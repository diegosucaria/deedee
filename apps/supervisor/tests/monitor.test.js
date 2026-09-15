const { Monitor } = require('../src/monitor');
const fs = require('fs');
const path = require('path');

describe('Monitor', () => {
    let monitor;
    let mockGit;
    let mockFetch;

    beforeEach(() => {
        mockGit = {
            run: jest.fn(),
            rollback: jest.fn().mockResolvedValue({ success: true }),
            workDir: '/tmp'
        };
        mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
        global.fetch = mockFetch;
        monitor = new Monitor(mockGit);
        monitor.slackWebhookUrl = 'http://slack';
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('notifyStartup: sends alert and saves hash on first run (no file)', async () => {
        mockGit.run.mockResolvedValue('hash123|feat: test commit');
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe('http://slack');
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (New Update)');
        expect(body.text).toContain('feat: test commit');
        expect(body.text).toContain('hash123');

        expect(fs.writeFileSync).toHaveBeenCalledWith(path.join('/tmp', '.last_boot_commit'), 'hash123');
    });

    test('notifyStartup: sends alert and saves hash on new commit', async () => {
        mockGit.run.mockResolvedValue('hash456|fix: bug');
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue('hash123');
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (New Update)');
        expect(body.text).toContain('fix: bug');
        expect(body.text).toContain('hash456');

        expect(fs.writeFileSync).toHaveBeenCalledWith(path.join('/tmp', '.last_boot_commit'), 'hash456');
    });

    test('notifyStartup: sends simple alert on same commit', async () => {
        mockGit.run.mockResolvedValue('hash123|feat: test commit');
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue('hash123');
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (No Changes)');
        expect(body.text).toContain('back online');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    describe('assessRollbackWindow', () => {
        const SELF = 'supervisor@deedee.bot';

        function mockHead(hash, email) {
            mockGit.run.mockImplementation(async (cmd) => {
                if (cmd.includes('%ae')) return `${hash}|${email}`;
                return `${hash}|some subject`;
            });
        }

        function mockLastBoot(hash) {
            jest.spyOn(fs, 'existsSync').mockReturnValue(hash !== null);
            jest.spyOn(fs, 'readFileSync').mockReturnValue(hash || '');
            jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        }

        test('opens only for a new commit authored by the supervisor', async () => {
            mockHead('abc1234', SELF);
            mockLastBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBeGreaterThan(0);
            expect(monitor.selfCommit).toBe('abc1234');
        });

        test('stays closed on a plain restart (same commit, self author)', async () => {
            mockHead('abc1234', SELF);
            mockLastBoot('abc1234');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed for a new commit by the owner', async () => {
            mockHead('abc1234', 'owner@example.com');
            mockLastBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(monitor.selfCommit).toBeNull();
        });

        test('stays closed when auto-rollback is disabled', async () => {
            monitor.autoRollback = false;
            mockHead('abc1234', SELF);
            mockLastBoot('old0000');

            await monitor.assessRollbackWindow();

            expect(monitor.lastUpdate).toBe(0);
            expect(mockGit.run).not.toHaveBeenCalled();
        });

        test('start() reads the boot file before notifyStartup rewrites it', async () => {
            mockHead('abc1234', SELF);
            mockLastBoot('old0000');
            jest.spyOn(monitor, 'check').mockResolvedValue();
            jest.spyOn(global, 'setInterval').mockReturnValue(1);

            await monitor.start();

            expect(monitor.selfCommit).toBe('abc1234');
            expect(fs.writeFileSync).toHaveBeenCalledWith(path.join('/tmp', '.last_boot_commit'), 'abc1234');
        });
    });

    describe('handleFailure rollback policy', () => {
        beforeEach(() => {
            monitor.failures = monitor.rollbackThreshold;
        });

        test('rolls back the recorded self-commit inside the window', async () => {
            monitor.lastUpdate = Date.now();
            monitor.selfCommit = 'abc1234';

            await monitor.handleFailure();

            expect(mockGit.rollback).toHaveBeenCalledWith({ expectedHead: 'abc1234' });
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

            const texts = mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts.body).text);
            expect(texts.some(t => t.includes('Rollback failed: Rollback aborted'))).toBe(true);
            expect(monitor.lastUpdate).toBe(0);
        });
    });
});
