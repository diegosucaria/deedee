const { Monitor } = require('../src/monitor');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SELF = 'supervisor@deedee.bot';
const OWNER = 'owner@example.test';

describe('Monitor', () => {
    let monitor;
    let mockGit;
    let mockFetch;
    let stateDir;
    let workDir;

    // What `git log -1 --pretty=format:%H%x09%ae%x09%s` prints for HEAD.
    function headLine(hash, email, subject = 'feat: test commit') {
        return `${hash}\t${email}\t${subject}`;
    }

    function mockHead(hash, email, subject) {
        mockGit.runSafe.mockResolvedValue(headLine(hash, email, subject));
    }

    function writeBoot(hash) {
        fs.writeFileSync(path.join(stateDir, '.last_boot_commit'), hash);
    }

    function readBoot() {
        const file = path.join(stateDir, '.last_boot_commit');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    }

    function slackTexts() {
        return mockFetch.mock.calls
            .filter(([url]) => url === 'http://slack')
            .map(([, opts]) => JSON.parse(opts.body).text);
    }

    beforeEach(() => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));
        stateDir = path.join(root, 'state');
        workDir = path.join(root, 'source');
        fs.mkdirSync(workDir);

        mockGit = {
            run: jest.fn(),
            runSafe: jest.fn(),
            rollback: jest.fn().mockResolvedValue({ success: true, revertCommit: 'rev0000' }),
            workDir
        };
        mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
        global.fetch = mockFetch;

        process.env.SUPERVISOR_STATE_DIR = stateDir;
        monitor = new Monitor(mockGit);
        monitor.slackWebhookUrl = 'http://slack';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.SUPERVISOR_STATE_DIR;
        fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
    });

    describe('readHead', () => {
        test('runs git log without a shell and splits on tabs', async () => {
            mockHead('hash123', SELF, 'fix: a | b subject');

            const head = await monitor.readHead();

            expect(mockGit.runSafe).toHaveBeenCalledWith('git', ['log', '-1', '--pretty=format:%H%x09%ae%x09%s']);
            expect(mockGit.run).not.toHaveBeenCalled();
            expect(head).toEqual({ hash: 'hash123', authorEmail: SELF, subject: 'fix: a | b subject' });
        });

        test('returns null on empty output', async () => {
            mockGit.runSafe.mockResolvedValue('');
            expect(await monitor.readHead()).toBeNull();
        });
    });

    describe('notifyStartup', () => {
        test('sends alert and saves hash on first run (no file)', async () => {
            mockHead('hash123', OWNER, 'feat: test commit');

            await monitor.notifyStartup();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0];
            expect(url).toBe('http://slack');
            const body = JSON.parse(options.body);
            expect(body.text).toContain('*Deedee Rebooted* (New Update)');
            expect(body.text).toContain('feat: test commit');
            expect(body.text).toContain('hash123');
            expect(readBoot()).toBe('hash123');
        });

        test('creates the state dir when missing', async () => {
            expect(fs.existsSync(stateDir)).toBe(false);
            mockHead('hash123', OWNER);

            await monitor.notifyStartup();

            expect(fs.existsSync(stateDir)).toBe(true);
            expect(readBoot()).toBe('hash123');
        });

        test('sends alert and saves hash on new commit', async () => {
            fs.mkdirSync(stateDir);
            writeBoot('hash123');
            mockHead('hash456', OWNER, 'fix: bug');

            await monitor.notifyStartup();

            const texts = slackTexts();
            expect(texts).toHaveLength(1);
            expect(texts[0]).toContain('*Deedee Rebooted* (New Update)');
            expect(texts[0]).toContain('fix: bug');
            expect(texts[0]).toContain('hash456');
            expect(readBoot()).toBe('hash456');
        });

        test('sends simple alert on same commit', async () => {
            fs.mkdirSync(stateDir);
            writeBoot('hash123');
            mockHead('hash123', OWNER);

            await monitor.notifyStartup();

            const texts = slackTexts();
            expect(texts).toHaveLength(1);
            expect(texts[0]).toContain('*Deedee Rebooted* (No Changes)');
            expect(texts[0]).toContain('back online');
            expect(readBoot()).toBe('hash123');
        });

        test('Slack fetch carries a timeout signal', async () => {
            mockHead('hash123', OWNER);

            await monitor.notifyStartup();

            const [, options] = mockFetch.mock.calls[0];
            expect(options.signal).toBeInstanceOf(AbortSignal);
        });

        test('a rejected Slack fetch does not stop start()', async () => {
            mockFetch.mockRejectedValue(new Error('TimeoutError'));
            mockHead('hash123', OWNER);
            jest.spyOn(monitor, 'check').mockResolvedValue();
            jest.spyOn(global, 'setInterval').mockReturnValue(1);

            await expect(monitor.start()).resolves.toBeUndefined();
            expect(readBoot()).toBe('hash123');
        });
    });

    describe('state dir migration', () => {
        test('copies the legacy .last_boot_commit from the work dir once', () => {
            fs.writeFileSync(path.join(workDir, '.last_boot_commit'), 'legacy00');

            expect(monitor._readLastBootCommit()).toBe('legacy00');
            expect(readBoot()).toBe('legacy00');

            // The new file wins from now on
            fs.writeFileSync(path.join(workDir, '.last_boot_commit'), 'changed0');
            expect(monitor._readLastBootCommit()).toBe('legacy00');
        });

        test('returns empty when neither file exists', () => {
            expect(monitor._readLastBootCommit()).toBe('');
            expect(fs.existsSync(stateDir)).toBe(false);
        });

        test('rollback hash lives next to the boot hash', () => {
            monitor._writeLastRollbackCommit('rev0000');
            expect(fs.readFileSync(path.join(stateDir, '.last_rollback_commit'), 'utf-8')).toBe('rev0000');
            expect(monitor._readLastRollbackCommit()).toBe('rev0000');
        });
    });

    describe('assessRollbackWindow', () => {
        beforeEach(() => fs.mkdirSync(stateDir));

        test('opens only for a new commit authored by the supervisor', async () => {
            mockHead('abc1234', SELF);
            writeBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBeGreaterThan(0);
            expect(monitor.selfCommit).toBe('abc1234');
            expect(monitor.lastAssessedHash).toBe('abc1234');
        });

        test('stays closed on a plain restart (same commit, self author)', async () => {
            mockHead('abc1234', SELF);
            writeBoot('abc1234');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed for a new commit by the owner', async () => {
            mockHead('abc1234', OWNER);
            writeBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed for a self-authored revert commit', async () => {
            mockHead('abc1234', SELF, 'Revert "feat: broken self-improvement"');
            writeBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed for the recorded rollback commit even with a plain subject', async () => {
            mockHead('rev0000', SELF, 'feat: looks new');
            writeBoot('old0000');
            monitor._writeLastRollbackCommit('rev0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed when auto-rollback is disabled', async () => {
            monitor.autoRollback = false;
            mockHead('abc1234', SELF);
            writeBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(mockGit.runSafe).not.toHaveBeenCalled();
        });

        test('stays closed when git throws', async () => {
            mockGit.runSafe.mockRejectedValue(new Error('not a git repository'));
            writeBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('start() reads the boot file before notifyStartup rewrites it', async () => {
            mockHead('abc1234', SELF);
            writeBoot('old0000');
            jest.spyOn(monitor, 'check').mockResolvedValue();
            jest.spyOn(global, 'setInterval').mockReturnValue(1);

            await monitor.start();

            expect(monitor.selfCommit).toBe('abc1234');
            expect(readBoot()).toBe('abc1234');
        });
    });

    describe('per-tick reassessment', () => {
        beforeEach(async () => {
            fs.mkdirSync(stateDir);
            // Boot on an owner commit: window closed, boot file written.
            mockHead('own0000', OWNER, 'feat: owner change');
            await monitor.assessRollbackWindow();
            await monitor.notifyStartup();
            mockFetch.mockClear();
            expect(monitor.lastUpdate).toBe(0);
        });

        test('HEAD unchanged between ticks: nothing happens', async () => {
            await monitor.check();

            expect(monitor.lastUpdate).toBe(0);
            expect(slackTexts()).toEqual([]);
            expect(readBoot()).toBe('own0000');
        });

        test('HEAD moves to a self-authored commit: window opens, boot file updated', async () => {
            mockHead('self111', SELF, 'feat: self-improvement');

            await monitor.check();

            expect(monitor.lastUpdate).toBeGreaterThan(0);
            expect(monitor.selfCommit).toBe('self111');
            expect(monitor.lastAssessedHash).toBe('self111');
            expect(readBoot()).toBe('self111');
            expect(slackTexts().some(t => t.includes('Deedee Updated') && t.includes('self111'))).toBe(true);
        });

        test('HEAD moves to an owner commit: window stays closed, boot file updated', async () => {
            mockHead('own2222', OWNER, 'feat: owner merge');

            await monitor.check();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
            expect(readBoot()).toBe('own2222');
        });

        test('an open window closes again when HEAD moves to an owner commit', async () => {
            mockHead('self111', SELF, 'feat: self-improvement');
            await monitor.check();
            expect(monitor.selfCommit).toBe('self111');

            mockHead('own2222', OWNER, 'fix: owner hotfix');
            await monitor.check();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('HEAD moves to a self-authored revert: window stays closed', async () => {
            mockHead('rev0000', SELF, 'Revert "feat: self-improvement"');

            await monitor.check();

            expect(monitor.lastUpdate).toBe(0);
            expect(readBoot()).toBe('rev0000');
        });

        test('a failing health check right after a self-commit sees the open window', async () => {
            mockHead('self111', SELF, 'feat: self-improvement');
            mockFetch.mockImplementation((url) => {
                if (url === 'http://slack') return Promise.resolve({ ok: true });
                return Promise.reject(new Error('ECONNREFUSED'));
            });
            monitor.failures = monitor.rollbackThreshold - 1;

            await monitor.check();

            expect(mockGit.rollback).toHaveBeenCalledWith({ expectedHead: 'self111' });
        });

        test('health fetch carries a timeout signal', async () => {
            await monitor.check();

            const healthCall = mockFetch.mock.calls.find(([url]) => url.endsWith('/health'));
            expect(healthCall[1].signal).toBeInstanceOf(AbortSignal);
        });
    });

    describe('handleFailure rollback policy', () => {
        beforeEach(() => {
            fs.mkdirSync(stateDir);
            monitor.failures = monitor.rollbackThreshold;
        });

        test('rolls back the recorded self-commit inside the window and records the revert', async () => {
            monitor.lastUpdate = Date.now();
            monitor.selfCommit = 'abc1234';

            await monitor.handleFailure();

            expect(mockGit.rollback).toHaveBeenCalledWith({ expectedHead: 'abc1234' });
            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
            expect(monitor._readLastRollbackCommit()).toBe('rev0000');
        });

        test('refuses to roll back the supervisor\'s own revert commit', async () => {
            monitor._writeLastRollbackCommit('rev0000');
            monitor.lastUpdate = Date.now();
            monitor.selfCommit = 'rev0000';

            await monitor.handleFailure();

            expect(mockGit.rollback).not.toHaveBeenCalled();
            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('never rolls back when the window is closed', async () => {
            monitor.lastUpdate = 0;
            monitor.selfCommit = null;

            await monitor.handleFailure();

            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('never rolls back when disabled, even inside the window', async () => {
            monitor.autoRollback = false;
            monitor.lastUpdate = Date.now();
            monitor.selfCommit = 'abc1234';

            await monitor.handleFailure();

            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('never rolls back after the window expired', async () => {
            monitor.lastUpdate = Date.now() - monitor.dangerWindow - 1;
            monitor.selfCommit = 'abc1234';

            await monitor.handleFailure();

            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('reports a refused rollback when HEAD moved', async () => {
            monitor.lastUpdate = Date.now();
            monitor.selfCommit = 'abc1234';
            mockGit.rollback.mockResolvedValue({ success: false, error: 'Rollback aborted: HEAD moved' });

            await monitor.handleFailure();

            expect(slackTexts().some(t => t.includes('Rollback failed: Rollback aborted'))).toBe(true);
            expect(monitor.lastUpdate).toBe(0);
            expect(monitor._readLastRollbackCommit()).toBe('');
        });
    });
});
