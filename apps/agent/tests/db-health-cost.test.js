/**
 * GET /health ran PRAGMA quick_check, which walks every page of the file, on
 * every request. better-sqlite3 is synchronous, so on the device each health
 * request blocked the whole agent for about 1.2 seconds, several times a
 * minute, and once the file grew the answer came later than the API's
 * one-second wait: the dashboard showed a working agent as down.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');

describe('AgentDB.healthCheck', () => {
    let dir, db, pragma;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-health-'));
        db = new AgentDB(dir);
        pragma = jest.spyOn(db.db, 'pragma');
        jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const scans = () => pragma.mock.calls.filter(c => c[0] === 'quick_check').length;

    test('the first request scans; the ones that follow read its result', () => {
        const first = db.healthCheck();
        expect(first).toMatchObject({ ok: true, details: { status: 'ok', connectivity: 'ok', integrity: 'ok' } });
        expect(first.details.integrityCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(scans()).toBe(1);

        for (let i = 0; i < 20; i++) expect(db.healthCheck().ok).toBe(true);
        expect(scans()).toBe(1);
        // The WAL's state comes from the scan too: no checkpoint per request.
        expect(pragma.mock.calls.filter(c => c[0] === 'wal_checkpoint')).toHaveLength(1);
    });

    test('the scan runs again once its result is half an hour old, or when asked', () => {
        const t0 = Date.now();
        db.healthCheck({ now: t0 });
        db.healthCheck({ now: t0 + 29 * 60 * 1000 });
        expect(scans()).toBe(1);
        db.healthCheck({ now: t0 + 31 * 60 * 1000 });
        expect(scans()).toBe(2);
        db.healthCheck({ now: t0 + 32 * 60 * 1000, force: true });
        expect(scans()).toBe(3);
    });

    test('a corrupt result is kept and shown until a later scan says otherwise', () => {
        const t0 = Date.now();
        pragma.mockImplementationOnce(() => [{ quick_check: '*** in database main ***' }, { quick_check: 'Page 12: btreeInitPage() returns error code 11' }]);
        const bad = db.healthCheck({ now: t0 });
        expect(bad.ok).toBe(false);
        expect(bad.details).toMatchObject({ status: 'corrupt', integrity: 'corrupt' });
        expect(bad.details.integrityErrors).toHaveLength(2);
        // Still corrupt a minute later, with no new scan.
        expect(db.healthCheck({ now: t0 + 60 * 1000 }).details.status).toBe('corrupt');
        expect(scans()).toBe(1);
    });

    test('every request still proves the database answers', () => {
        db.healthCheck();
        const prepare = jest.spyOn(db.db, 'prepare');
        db.healthCheck();
        expect(prepare).toHaveBeenCalledWith('SELECT 1');
    });

    test('a closed database says so at once', () => {
        const closed = new AgentDB(fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-health-closed-')));
        closed.close();
        expect(closed.healthCheck()).toEqual({ ok: false, details: { status: 'closed' } });
    });
});
