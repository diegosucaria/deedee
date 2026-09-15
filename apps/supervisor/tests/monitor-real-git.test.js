// Runs the real git binary against throwaway repositories. No child_process
// mocks here: this proves the HEAD command and the identity flags work as
// git itself sees them.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitOps } = require('../src/git-ops');
const { Monitor } = require('../src/monitor');

const SELF = { name: 'Deedee Supervisor', email: 'supervisor@example.test' };
const OWNER = { name: 'Owner', email: 'owner@example.test' };

describe('Monitor + GitOps against a real git repository', () => {
    let root;
    let remote;
    let work;
    let stateDir;
    let gitOps;
    let monitor;

    function git(args, cwd = work) {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
        }).trim();
    }

    function commitAs(identity, subject, file = null) {
        if (file) {
            fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
            fs.writeFileSync(path.join(work, file), `// ${subject}\n`);
            git(['add', '--', file]);
        }
        git(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`,
            'commit', '-q', '--allow-empty', '-m', subject]);
        git(['push', '-q', 'origin', 'master']);
        return git(['rev-parse', 'HEAD']);
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-git-'));
        remote = path.join(root, 'remote.git');
        work = path.join(root, 'work');
        stateDir = path.join(root, 'state');

        git(['init', '-q', '--bare', '-b', 'master', remote], root);
        git(['init', '-q', '-b', 'master', work], root);
        git(['remote', 'add', 'origin', remote]);
        commitAs(OWNER, 'feat: first owner commit', 'apps/agent/src/a.js');

        gitOps = new GitOps(work, SELF);
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
        monitor = new Monitor(gitOps);
        monitor.stateDir = stateDir;
        monitor.supervisorEmail = SELF.email;
        monitor.alertUser = jest.fn().mockResolvedValue();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('readHead parses hash, author email and subject, pipes included', async () => {
        const hash = commitAs(OWNER, 'feat: subject with | a pipe and %ae text');

        const head = await monitor.readHead();

        expect(head.hash).toBe(hash);
        expect(head.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(head.authorEmail).toBe(OWNER.email);
        expect(head.subject).toBe('feat: subject with | a pipe and %ae text');
    });

    test('window opens for a fresh self-commit and stays closed for an owner commit', async () => {
        monitor._writeLastBootCommit(git(['rev-parse', 'HEAD']));

        const selfHash = commitAs(SELF, 'feat: self-improvement');
        await monitor.assessRollbackWindow();
        expect(monitor.selfCommit).toBe(selfHash);
        expect(monitor.lastUpdate).toBeGreaterThan(0);

        commitAs(OWNER, 'fix: owner hotfix');
        await monitor.assessRollbackWindow();
        expect(monitor.selfCommit).toBeNull();
        expect(monitor.lastUpdate).toBe(0);
    });

    test('per-tick check picks up a self-commit made after start', async () => {
        global.fetch = jest.fn(() => Promise.resolve({ ok: true }));
        await monitor.assessRollbackWindow();
        await monitor.notifyStartup();
        expect(monitor.lastUpdate).toBe(0);

        const selfHash = commitAs(SELF, 'feat: agent-only change');
        await monitor.check();

        expect(monitor.selfCommit).toBe(selfHash);
        expect(monitor._readLastBootCommit()).toBe(selfHash);
    });

    test('rollback writes the revert with the env identity, not the repo config', async () => {
        git(['config', 'user.name', 'Someone Else']);
        git(['config', 'user.email', 'someone-else@example.test']);
        // git refuses to revert an empty commit, so this one changes a file
        const selfHash = commitAs(SELF, 'feat: broken self-improvement', 'apps/agent/src/broken.js');

        const result = await gitOps.rollback({ expectedHead: selfHash });

        expect(result.success).toBe(true);
        const head = await monitor.readHead();
        expect(result.revertCommit).toBe(head.hash);
        expect(head.authorEmail).toBe(SELF.email);
        expect(head.subject).toBe('Revert "feat: broken self-improvement"');
        expect(git(['rev-parse', 'master'], remote)).toBe(head.hash);
    });

    test('commitAndPush writes the commit with the env identity, not the repo config', async () => {
        git(['config', 'user.email', 'someone-else@example.test']);
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'console.log("changed");\n');

        const result = await gitOps.commitAndPush('feat: agent edit');

        expect(result.success).toBe(true);
        const head = await monitor.readHead();
        expect(head.authorEmail).toBe(SELF.email);
        expect(head.subject).toBe('feat: agent edit');
        expect(git(['rev-parse', 'master'], remote)).toBe(head.hash);
    });

    test('the supervisor never reverts its own revert', async () => {
        monitor._writeLastBootCommit(git(['rev-parse', 'HEAD']));
        const selfHash = commitAs(SELF, 'feat: broken self-improvement', 'apps/agent/src/broken.js');
        await monitor.assessRollbackWindow();
        expect(monitor.selfCommit).toBe(selfHash);

        monitor.failures = monitor.rollbackThreshold;
        await monitor.handleFailure();

        const revert = await monitor.readHead();
        expect(revert.subject).toBe('Revert "feat: broken self-improvement"');
        expect(monitor._readLastRollbackCommit()).toBe(revert.hash);

        // Next tick: HEAD moved to the revert. The window must stay closed.
        global.fetch = jest.fn(() => Promise.resolve({ ok: true }));
        await monitor.check();
        expect(monitor.lastUpdate).toBe(0);
        expect(monitor.selfCommit).toBeNull();

        // Even if forced open, handleFailure refuses that hash.
        monitor.lastUpdate = Date.now();
        monitor.selfCommit = revert.hash;
        monitor.failures = monitor.rollbackThreshold;
        const rollbackSpy = jest.spyOn(gitOps, 'rollback');
        await monitor.handleFailure();
        expect(rollbackSpy).not.toHaveBeenCalled();
        expect((await monitor.readHead()).hash).toBe(revert.hash);
    });
});
