/**
 * GET /health ran PRAGMA quick_check, which walks every page of the file, on
 * every request. better-sqlite3 is synchronous, so on the device each health
 * request blocked the whole agent for 1.2 to 2.0 seconds, several times a
 * minute, and once the file grew the answer came later than the API's
 * one-second wait: the dashboard showed a working agent as down.
 *
 * A request now never walks the file. The scan runs in a worker thread.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');

const MIN = 60 * 1000;

describe('AgentDB.healthCheck', () => {
    let dir, db, pragma;

    beforeEach(() => {
        delete process.env.HEALTH_INTEGRITY_MINUTES;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-health-'));
        db = new AgentDB(dir);
        pragma = jest.spyOn(db.db, 'pragma');
        jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(async () => {
        delete process.env.HEALTH_INTEGRITY_MINUTES;
        await db._integrityRun;
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const mainThreadScans = () => pragma.mock.calls.filter(c => /quick_check|integrity_check|wal_checkpoint/.test(String(c[0]))).length;

    describe('with the real worker', () => {
        test('the first request says "pending" at once; the scan lands from the worker, never from the main thread', async () => {
            const first = db.healthCheck();
            expect(first).toEqual({ ok: true, details: { status: 'ok', connectivity: 'ok', integrity: 'pending', wal: { bytes: expect.any(Number) } } });

            const scan = await db._integrityRun;
            expect(scan.integrity).toBe('ok');
            const second = db.healthCheck();
            expect(second).toMatchObject({ ok: true, details: { status: 'ok', integrity: 'ok' } });
            expect(second.details.integrityCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(mainThreadScans()).toBe(0);
        });

        test('a damaged file is reported', async () => {
            for (let i = 0; i < 400; i++) db.saveMessage({ role: 'user', content: `row ${i} ${'x'.repeat(400)}`, chatId: 'c1' });
            db.db.pragma('wal_checkpoint(TRUNCATE)');
            const pageSize = db.db.pragma('page_size', { simple: true });
            const pages = db.db.pragma('page_count', { simple: true });
            const fd = fs.openSync(db.dbPath, 'r+');
            // Every page after the first few: whatever holds the rows is hit.
            for (let page = 8; page < pages; page++) fs.writeSync(fd, Buffer.alloc(pageSize, 0xAB), 0, pageSize, page * pageSize);
            fs.closeSync(fd);

            // A file this damaged makes quick_check throw SQLITE_CORRUPT where a
            // lightly damaged one returns rows. Both must read "corrupt": as an
            // "error" it would be scanned again every minute, for ever.
            const scan = await db.scanIntegrity();
            expect(scan.integrity).toBe('corrupt');
            expect(scan.integrityErrors.length).toBeGreaterThan(0);
            // The worker's exit comes after its message; it must not log a second, false result.
            expect(console.log.mock.calls.filter(c => /Integrity scan/.test(String(c[0])))).toHaveLength(1);
        });

        test('a file that is not there is a database error, not a crash', async () => {
            const gone = Object.assign(Object.create(AgentDB.prototype), { dbPath: path.join(dir, 'missing.db') });
            const scan = await gone.scanIntegrity();
            expect(scan).toMatchObject({ integrity: 'error', integrityError: expect.any(String) });
        });

        const workerFile = (body) => {
            const file = path.join(dir, `worker-${Math.random().toString(36).slice(2)}.js`);
            fs.writeFileSync(file, body);
            return file;
        };

        test('a scan that never answers is stopped, and says nothing about the file', async () => {
            const hung = workerFile('setInterval(() => {}, 1000);');
            const t0 = Date.now();
            const scan = await db.scanIntegrity(t0, { workerFile: hung, timeoutMs: 150 });
            expect(scan.integrity).toBe('unknown');
            expect(scan.integrityError).toMatch(/no answer/);
            // Dated when it settled, not when it began: or it would be due again at
            // once. The scan measures its own time from a clock read a moment after
            // t0, so allow a few milliseconds.
            expect(scan.at).toBeGreaterThanOrEqual(t0 + 140);
        });

        test('while a timed-out worker is still alive, no other scan starts; once it has gone, one may', async () => {
            // terminate() cannot end a thread blocked inside a read. On the device that
            // would have meant one more hung thread every two minutes, for ever.
            const stuck = { alive: true };
            db._integrityStuck = stuck;
            const spy = jest.spyOn(db, 'scanIntegrity');
            expect(db._startIntegrityScan(Date.now() + 24 * 60 * MIN)).toBeNull();
            expect(spy).not.toHaveBeenCalled();
            expect(db.healthCheck().ok).toBe(true);

            db._integrityStuck = null;
            const run = db._startIntegrityScan(Date.now());
            expect(run).not.toBeNull();
            await run;
        });

        test('a worker that is stopped after its timeout is forgotten when it exits', async () => {
            const hung = workerFile('setInterval(() => {}, 1000);');
            await db.scanIntegrity(Date.now(), { workerFile: hung, timeoutMs: 100 });
            // This one can be terminated (it is not inside a read), so it exits soon.
            for (let i = 0; i < 100 && db._integrityStuck; i++) await new Promise(r => setTimeout(r, 20));
            expect(db._integrityStuck).toBeNull();
        });

        test('a worker that dies with no result is "unknown" too', async () => {
            const dies = workerFile('process.exit(3);');
            const scan = await db.scanIntegrity(Date.now(), { workerFile: dies });
            expect(scan).toMatchObject({ integrity: 'unknown', integrityError: expect.stringMatching(/exited with code 3/) });
        });

        test('a worker file that is not there is "unknown", never a throw', async () => {
            const scan = await db.scanIntegrity(Date.now(), { workerFile: path.join(dir, 'no-such-worker.js') });
            expect(scan.integrity).toBe('unknown');
        });
    });

    describe('when a scan runs', () => {
        let results;
        beforeEach(() => {
            results = [];
            jest.spyOn(db, 'scanIntegrity').mockImplementation((now) => Promise.resolve({ at: now, ...(results.shift() || { integrity: 'ok' }) }));
        });
        const settle = () => db._integrityRun || Promise.resolve();
        const scans = () => db.scanIntegrity.mock.calls.length;

        test('twenty requests at once start one scan', async () => {
            for (let i = 0; i < 20; i++) expect(db.healthCheck().ok).toBe(true);
            expect(scans()).toBe(1);
            await settle();
            for (let i = 0; i < 20; i++) expect(db.healthCheck().details.integrity).toBe('ok');
            expect(scans()).toBe(1);
        });

        test('it runs again once its result is half an hour old', async () => {
            const t0 = Date.now();
            db.healthCheck({ now: t0 }); await settle();
            db.healthCheck({ now: t0 + 29 * MIN }); await settle();
            expect(scans()).toBe(1);
            db.healthCheck({ now: t0 + 31 * MIN }); await settle();
            expect(scans()).toBe(2);
        });

        test('a corrupt result is kept and shown until a later scan says otherwise', async () => {
            const t0 = Date.now();
            results.push({ integrity: 'corrupt', integrityErrors: ['*** in database main ***', 'Page 12: btreeInitPage() returns error code 11'] });
            db.healthCheck({ now: t0 }); await settle();
            const bad = db.healthCheck({ now: t0 + 29 * MIN });
            expect(bad.ok).toBe(false);
            expect(bad.details).toMatchObject({ status: 'corrupt', integrity: 'corrupt' });
            expect(bad.details.integrityErrors).toHaveLength(2);
            expect(scans()).toBe(1);
            db.healthCheck({ now: t0 + 31 * MIN }); await settle();
            expect(db.healthCheck({ now: t0 + 32 * MIN }).ok).toBe(true);
        });

        test('a scan that could not run is not held against the file for half an hour', async () => {
            const t0 = Date.now();
            results.push({ integrity: 'error', integrityError: 'disk I/O error' });
            db.healthCheck({ now: t0 }); await settle();
            expect(db.healthCheck({ now: t0 + 30 * 1000 }).details).toMatchObject({ status: 'error', integrity: 'error', integrityError: 'disk I/O error' });
            expect(scans()).toBe(1);
            // A minute on, the next request starts another try, and it clears.
            db.healthCheck({ now: t0 + 61 * 1000 }); await settle();
            expect(scans()).toBe(2);
            expect(db.healthCheck({ now: t0 + 62 * 1000 }).ok).toBe(true);
        });

        test('a check that could not run leaves the status alone, and is tried again within a minute', async () => {
            const t0 = Date.now();
            results.push({ integrity: 'unknown', integrityError: 'the scan could not start: out of memory' });
            db.healthCheck({ now: t0 }); await settle();
            const seen = db.healthCheck({ now: t0 + 30 * 1000 });
            expect(seen.ok).toBe(true);
            expect(seen.details).toMatchObject({ status: 'ok', integrity: 'unknown', integrityError: expect.stringMatching(/could not start/) });
            db.healthCheck({ now: t0 + 61 * 1000 }); await settle();
            expect(scans()).toBe(2);
        });

        test('an empty HEALTH_INTEGRITY_MINUTES is the default, not "off"; a tiny value is floored at a minute', async () => {
            const t0 = Date.now();
            process.env.HEALTH_INTEGRITY_MINUTES = '';
            db.healthCheck({ now: t0 }); await settle();
            expect(scans()).toBe(1);
            expect(db.healthCheck({ now: t0 + 1000 }).details.integrity).toBe('ok');

            process.env.HEALTH_INTEGRITY_MINUTES = '0.001';
            db.healthCheck({ now: t0 + 30 * 1000 }); await settle();
            expect(scans()).toBe(1);
            db.healthCheck({ now: t0 + 61 * 1000 }); await settle();
            expect(scans()).toBe(2);
        });

        test('HEALTH_INTEGRITY_MINUTES: read on every call, junk means the default, 0 turns the scan off', async () => {
            const t0 = Date.now();
            db.healthCheck({ now: t0 }); await settle();
            process.env.HEALTH_INTEGRITY_MINUTES = '5';
            db.healthCheck({ now: t0 + 6 * MIN }); await settle();
            expect(scans()).toBe(2);

            process.env.HEALTH_INTEGRITY_MINUTES = 'soon';
            db.healthCheck({ now: t0 + 20 * MIN }); await settle();
            expect(scans()).toBe(2);
            db.healthCheck({ now: t0 + 40 * MIN }); await settle();
            expect(scans()).toBe(3);

            process.env.HEALTH_INTEGRITY_MINUTES = '0';
            db.healthCheck({ now: t0 + 400 * MIN }); await settle();
            expect(scans()).toBe(3);
        });

        test('with the scan off, a fresh database reports "off", not "pending"', () => {
            process.env.HEALTH_INTEGRITY_MINUTES = '0';
            expect(db.healthCheck().details.integrity).toBe('off');
            expect(scans()).toBe(0);
        });

        test('a scan that lands after the database closed is dropped', async () => {
            db.healthCheck();
            const run = db._integrityRun;
            db.close();
            await run;
            expect(db._integrity).toBeUndefined();
            expect(db.healthCheck()).toEqual({ ok: false, details: { status: 'closed' } });
        });

        test('every request still proves the database answers, and none checkpoints the WAL', () => {
            const prepare = jest.spyOn(db.db, 'prepare');
            db.healthCheck();
            expect(prepare).toHaveBeenCalledWith('SELECT 1');
            expect(mainThreadScans()).toBe(0);
        });
    });
});
