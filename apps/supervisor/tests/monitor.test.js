const { Monitor } = require('../src/monitor');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER = 'owner@example.test';

describe('Monitor', () => {
    let monitor;
    let mockGit;
    let mockFetch;
    let stateDir;
    let workDir;
    let selfPrs;

    // What `git log -1 --pretty=format:%H%x09%ae%x09%s` prints for HEAD.
    function headLine(hash, email, subject = 'feat: test commit') {
        return `${hash}\t${email}\t${subject}`;
    }

    function mockHead(hash, email, subject) {
        mockGit.git.mockResolvedValue(headLine(hash, email, subject));
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

        selfPrs = [];
        mockGit = {
            git: jest.fn(),
            rollback: jest.fn().mockResolvedValue({ success: true, revertCommit: 'rev0000', pullRequest: { number: 42 } }),
            listSelfPullRequests: jest.fn(() => selfPrs),
            updateSelfPullRequest: jest.fn((number, patch) => {
                selfPrs = selfPrs.map(e => (e.number === number ? { ...e, ...patch } : e));
            }),
            getPullRequest: jest.fn(),
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
            mockHead('hash123', OWNER, 'fix: a | b subject');

            const head = await monitor.readHead();

            expect(mockGit.git).toHaveBeenCalledWith(['log', '-1', '--pretty=format:%H%x09%ae%x09%s']);
            expect(head).toEqual({ hash: 'hash123', authorEmail: OWNER, subject: 'fix: a | b subject' });
        });

        test('returns null on empty output', async () => {
            mockGit.git.mockResolvedValue('');
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

    describe('checks', () => {
        test('health fetch carries a timeout signal', async () => {
            await monitor.check();

            const healthCall = mockFetch.mock.calls.find(([url]) => url.endsWith('/health'));
            expect(healthCall[1].signal).toBeInstanceOf(AbortSignal);
        });

        test('start() never touches git beyond reading HEAD', async () => {
            mockHead('hash123', OWNER);
            jest.spyOn(monitor, 'check').mockResolvedValue();
            jest.spyOn(global, 'setInterval').mockReturnValue(1);

            await monitor.start();

            expect(mockGit.git.mock.calls.map(c => c[0][0])).toEqual(['log']);
            expect(mockGit.rollback).not.toHaveBeenCalled();
        });
    });

    describe('handleFailure: revert pull request after a self-improvement merge', () => {
        const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

        beforeEach(() => {
            monitor.failures = monitor.rollbackThreshold;
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            jest.spyOn(console, 'log').mockImplementation(() => {});
        });

        test('opens a revert pull request for a self PR merged inside the window', async () => {
            selfPrs = [{ number: 7, branch: 'deedee/self/x', commit: 'c1' }];
            mockGit.getPullRequest.mockResolvedValue({ state: 'closed', merged_at: minutesAgo(15), merge_commit_sha: 'abc1234' });

            await monitor.handleFailure();

            expect(mockGit.getPullRequest).toHaveBeenCalledWith(7);
            expect(mockGit.rollback).toHaveBeenCalledWith(expect.objectContaining({ commit: 'abc1234' }));
            expect(selfPrs[0]).toMatchObject({ mergeCommit: 'abc1234', revertPullRequest: 42 });
            const texts = slackTexts();
            expect(texts.some(t => t.includes('PR #7'))).toBe(true);
            expect(texts.some(t => t.includes('#42') && t.includes('Merge it to roll back'))).toBe(true);
        });

        test('acts once per failure streak, not on every failing tick', async () => {
            selfPrs = [{ number: 7, mergedAt: minutesAgo(5), mergeCommit: 'abc1234' }];

            monitor.failures = monitor.rollbackThreshold + 1;
            await monitor.handleFailure();
            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('never reverts the same pull request twice', async () => {
            selfPrs = [{ number: 7, mergedAt: minutesAgo(5), mergeCommit: 'abc1234', revertPullRequest: 42 }];
            await monitor.handleFailure();
            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('alert only when the merge is older than the window', async () => {
            selfPrs = [{ number: 7, mergedAt: minutesAgo(61), mergeCommit: 'abc1234' }];
            await monitor.handleFailure();
            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('alert only when no self PR merged (open or closed unmerged)', async () => {
            selfPrs = [{ number: 8 }, { number: 9 }];
            mockGit.getPullRequest
                .mockResolvedValueOnce({ state: 'open', merged_at: null })
                .mockResolvedValueOnce({ state: 'closed', merged_at: null });

            await monitor.handleFailure();

            expect(mockGit.rollback).not.toHaveBeenCalled();
            expect(selfPrs[1]).toMatchObject({ closedUnmerged: true });
        });

        test('never acts when auto-rollback is disabled', async () => {
            monitor.autoRollback = false;
            selfPrs = [{ number: 7, mergedAt: minutesAgo(5), mergeCommit: 'abc1234' }];
            await monitor.handleFailure();
            expect(mockGit.rollback).not.toHaveBeenCalled();
            expect(mockGit.getPullRequest).not.toHaveBeenCalled();
        });

        test('reports a failed revert pull request', async () => {
            selfPrs = [{ number: 7, mergedAt: minutesAgo(5), mergeCommit: 'abc1234' }];
            mockGit.rollback.mockResolvedValue({ success: false, error: 'no clean revert' });

            await monitor.handleFailure();

            expect(slackTexts().some(t => t.includes('Could not open a revert pull request: no clean revert'))).toBe(true);
        });

        test('a GitHub error keeps the monitor running', async () => {
            selfPrs = [{ number: 7 }];
            mockGit.getPullRequest.mockRejectedValue(new Error('GitHub API 500'));
            jest.spyOn(console, 'error').mockImplementation(() => {});
            await expect(monitor.handleFailure()).resolves.toBeUndefined();
            expect(mockGit.rollback).not.toHaveBeenCalled();
        });

        test('the window length reads SUPERVISOR_ROLLBACK_WINDOW_MINUTES', () => {
            process.env.SUPERVISOR_ROLLBACK_WINDOW_MINUTES = '90';
            try {
                expect(new Monitor(mockGit).rollbackWindow).toBe(90 * 60000);
            } finally {
                delete process.env.SUPERVISOR_ROLLBACK_WINDOW_MINUTES;
            }
        });
    });
});
