// Runs the real git binary against throwaway repositories: a bare "remote",
// the shared work tree the agent writes, and the supervisor's own git dir.
// The GitHub REST API is a fake fetch.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitOps, cleanGitEnv } = require('../src/git-ops');

const SELF = { name: 'Deedee Supervisor', email: 'supervisor@example.test' };
const OWNER = { name: 'Owner', email: 'owner@example.test' };
const TOKEN = 'test-token-value';

describe('GitOps pull request flow against real git', () => {
    let root;
    let remote;
    let seed;
    let work;
    let stateDir;
    let marker;
    let gitOps;
    let apiCalls;

    function git(args, cwd) {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...cleanGitEnv(), HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
        }).trim();
    }

    function ownerCommit(file, content, subject) {
        fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
        fs.writeFileSync(path.join(seed, file), content);
        git(['add', '--', file], seed);
        git(['-c', `user.name=${OWNER.name}`, '-c', `user.email=${OWNER.email}`, 'commit', '-q', '-m', subject], seed);
        git(['push', '-q', 'origin', 'master'], seed);
        return git(['rev-parse', 'HEAD'], seed);
    }

    function fakeFetch() {
        let next = 100;
        return jest.fn(async (url, opts) => {
            apiCalls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
            const number = next++;
            return {
                ok: true,
                status: 201,
                text: async () => JSON.stringify({ number, html_url: `https://github.example/pull/${number}` })
            };
        });
    }

    /** Plants every trap the agent could set in its own .git. */
    function plantTraps() {
        const hook = `#!/bin/sh\necho ran >> "${marker}"\n`;
        const hooks = path.join(work, '.git', 'hooks');
        fs.mkdirSync(hooks, { recursive: true });
        for (const name of ['pre-commit', 'commit-msg', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'post-index-change']) {
            fs.writeFileSync(path.join(hooks, name), hook, { mode: 0o755 });
        }
        const evil = path.join(root, 'evil.sh');
        fs.writeFileSync(evil, hook, { mode: 0o755 });
        fs.appendFileSync(path.join(work, '.git', 'config'), [
            '[core]', `\thooksPath = ${hooks}`, `\tfsmonitor = ${evil}`,
            '[filter "x"]', `\tclean = ${evil}`, `\tsmudge = ${evil}`,
            '[commit]', '\tgpgSign = true', '[gpg]', `\tprogram = ${evil}`, ''
        ].join('\n'));
        fs.writeFileSync(path.join(work, '.gitattributes'), '* filter=x\n');
    }

    beforeEach(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-pr-')));
        remote = path.join(root, 'remote.git');
        seed = path.join(root, 'seed');
        work = path.join(root, 'source');
        stateDir = path.join(root, 'state');
        marker = path.join(root, 'hook-ran.txt');
        apiCalls = [];

        git(['init', '-q', '--bare', '-b', 'master', remote], root);
        git(['clone', '-q', remote, seed], root);
        git(['checkout', '-q', '-b', 'master'], seed);
        ownerCommit('apps/agent/src/a.js', 'module.exports = 1;\n', 'feat: first owner commit');
        // The shared tree, as the old supervisor left it: a clone with its own .git.
        git(['clone', '-q', remote, work], root);

        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        gitOps = new GitOps(work, SELF, { stateDir, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await gitOps.configure(SELF.name, SELF.email, remote, TOKEN);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('the supervisor keeps its git dir in the state volume', () => {
        expect(fs.existsSync(path.join(stateDir, 'repo.git', 'HEAD'))).toBe(true);
        const headOfState = execFileSync('git', [`--git-dir=${path.join(stateDir, 'repo.git')}`, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
        expect(headOfState).toBe(git(['rev-parse', 'HEAD'], seed));
    });

    test('commitAndPush pushes a deedee/self branch, opens a pull request and leaves master alone', async () => {
        const masterBefore = git(['rev-parse', 'master'], remote);
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 2;\n');
        fs.writeFileSync(path.join(work, 'apps/agent/src/b.js'), 'module.exports = 3;\n');

        const result = await gitOps.commitAndPush('feat: two');

        expect(result.success).toBe(true);
        expect(result.branch).toMatch(/^deedee\/self\/\d{8}-\d{6}$/);
        expect(result.pullRequest.number).toBe(100);
        expect(git(['rev-parse', 'master'], remote)).toBe(masterBefore);
        const branchHead = git(['rev-parse', `refs/heads/${result.branch}`], remote);
        expect(branchHead).toBe(result.commit);
        expect(git(['log', '-1', '--format=%ae %s', branchHead], remote)).toBe(`${SELF.email} feat: two`);
        expect(git(['show', `${branchHead}:apps/agent/src/b.js`], remote)).toBe('module.exports = 3;');

        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0].url).toBe('https://api.github.com/repos/owner/repo/pulls');
        expect(apiCalls[0].method).toBe('POST');
        expect(apiCalls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(apiCalls[0].body).toMatchObject({ title: 'feat: two', head: result.branch, base: 'master' });
        expect(apiCalls[0].body.body).toMatch(/Do not merge without the owner's review\./);

        // The work tree keeps the edits; the supervisor's HEAD stays on master.
        expect(fs.readFileSync(path.join(work, 'apps/agent/src/a.js'), 'utf8')).toBe('module.exports = 2;\n');
        expect(await gitOps.git(['rev-parse', 'HEAD'])).toBe(masterBefore);
        expect(gitOps.listSelfPullRequests()[0]).toMatchObject({ number: 100, branch: result.branch, commit: result.commit });
    });

    test('no hook, fsmonitor, filter or signing program from the agent tree ever runs', async () => {
        plantTraps();
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 2;\n');

        const result = await gitOps.commitAndPush('feat: trap');
        await gitOps.pull();
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 5;\n');
        await gitOps.commitAndPush('feat: trap again');
        await gitOps.rollback();

        expect(result.success).toBe(true);
        expect(fs.existsSync(marker)).toBe(false);
    });

    test('a tracked change under .github is refused', async () => {
        ownerCommit('.github/workflows/ci.yml', 'on: push\n', 'ci: add');
        await gitOps.pull();
        fs.writeFileSync(path.join(work, '.github/workflows/ci.yml'), 'on: pull_request\n');
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 2;\n');

        const result = await gitOps.commitAndPush('feat: sneaky');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/\.github/);
        expect(apiCalls).toHaveLength(0);
        expect(git(['branch', '--list', 'deedee/*'], remote)).toBe('');
    });

    test('nothing to commit is reported, not pushed', async () => {
        const result = await gitOps.commitAndPush('feat: nothing');
        expect(result.success).toBe(false);
        expect(apiCalls).toHaveLength(0);
    });

    test('rollback opens a revert pull request and never pushes master', async () => {
        const first = git(['rev-parse', 'HEAD'], seed);
        const bad = ownerCommit('apps/agent/src/a.js', 'broken(\n', 'feat: bad change');
        const masterBefore = git(['rev-parse', 'master'], remote);

        const result = await gitOps.rollback({ commit: bad, reason: 'health check failed' });

        expect(result.success).toBe(true);
        expect(result.branch).toMatch(/^deedee\/revert\//);
        expect(git(['rev-parse', 'master'], remote)).toBe(masterBefore);
        const revert = git(['rev-parse', `refs/heads/${result.branch}`], remote);
        expect(git(['rev-parse', `${revert}^{tree}`], remote)).toBe(git(['rev-parse', `${first}^{tree}`], remote));
        expect(git(['rev-parse', `${revert}^1`], remote)).toBe(masterBefore);
        expect(apiCalls[0].body.title).toBe('Revert "feat: bad change"');
    });

    test('rollback of an older commit keeps the newer ones', async () => {
        const bad = ownerCommit('apps/agent/src/bad.js', 'broken(\n', 'feat: bad');
        ownerCommit('apps/agent/src/good.js', 'ok();\n', 'feat: good');

        const result = await gitOps.rollback({ commit: bad });

        expect(result.success).toBe(true);
        const revert = git(['rev-parse', `refs/heads/${result.branch}`], remote);
        const files = git(['ls-tree', '-r', '--name-only', revert], remote).split('\n');
        expect(files).toContain('apps/agent/src/good.js');
        expect(files).not.toContain('apps/agent/src/bad.js');
    });

    test('rollback refuses a commit that is not on master', async () => {
        const result = await gitOps.rollback({ commit: 'deadbeef' });
        expect(result.success).toBe(false);
        expect(apiCalls).toHaveLength(0);
    });

    test('pull brings the work tree to origin/master', async () => {
        ownerCommit('apps/agent/src/c.js', 'c();\n', 'feat: c');
        const result = await gitOps.pull();
        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(work, 'apps/agent/src/c.js'), 'utf8')).toBe('c();\n');
    });

    test('a first start keeps local edits and does not turn upstream changes into reverts', async () => {
        // The shared tree is one commit behind, with an uncommitted edit.
        ownerCommit('apps/agent/src/c.js', 'c();\n', 'feat: c upstream');
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 9;\n');
        fs.rmSync(stateDir, { recursive: true, force: true });

        const fresh = new GitOps(work, SELF, { stateDir, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await fresh.configure(SELF.name, SELF.email, remote, TOKEN);

        expect(fs.readFileSync(path.join(work, 'apps/agent/src/c.js'), 'utf8')).toBe('c();\n');
        const status = await fresh.git(['status', '--porcelain']);
        expect(status).toBe('M apps/agent/src/a.js');
    });

    test('a first start whose previous commit the remote lacks keeps local edits', async () => {
        // The old flow left a commit it never pushed, plus an uncommitted edit.
        fs.writeFileSync(path.join(work, 'apps/agent/src/local.js'), 'local();\n');
        git(['add', '--', 'apps/agent/src/local.js'], work);
        git(['-c', `user.name=${SELF.name}`, '-c', `user.email=${SELF.email}`, 'commit', '-q', '-m', 'unpushed'], work);
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 9;\n');
        ownerCommit('apps/agent/src/c.js', 'c();\n', 'feat: c upstream');
        fs.rmSync(stateDir, { recursive: true, force: true });

        const fresh = new GitOps(work, SELF, { stateDir, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await fresh.configure(SELF.name, SELF.email, remote, TOKEN);

        expect(fs.readFileSync(path.join(work, 'apps/agent/src/a.js'), 'utf8')).toBe('module.exports = 9;\n');
        expect(fs.readFileSync(path.join(work, 'apps/agent/src/local.js'), 'utf8')).toBe('local();\n');
        expect(await fresh.git(['rev-parse', 'HEAD'])).toBe(git(['rev-parse', 'master'], remote));
        const status = await fresh.git(['status', '--porcelain']);
        expect(status).toContain('M apps/agent/src/a.js');
        expect(status).toContain('?? apps/agent/src/local.js');
    });

    test('a first start on an empty volume checks the files out', async () => {
        const empty = path.join(root, 'empty-source');
        const emptyState = path.join(root, 'empty-state');
        fs.mkdirSync(empty);
        const fresh = new GitOps(empty, SELF, { stateDir: emptyState, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await fresh.configure(SELF.name, SELF.email, remote, TOKEN);

        expect(fs.readFileSync(path.join(empty, 'apps/agent/src/a.js'), 'utf8')).toBe('module.exports = 1;\n');
        expect(await fresh.git(['status', '--porcelain'])).toBe('');
    });

    test('a restart after a self-improvement merged moves to origin/master', async () => {
        // The agent's uncommitted edit and new file became a pull request,
        // and the owner merged the same content.
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 2;\n');
        fs.writeFileSync(path.join(work, 'apps/agent/src/n.js'), 'n();\n');
        ownerCommit('apps/agent/src/a.js', 'module.exports = 2;\n', 'feat: merged a');
        const merged = ownerCommit('apps/agent/src/n.js', 'n();\n', 'feat: merged n');

        const restarted = new GitOps(work, SELF, { stateDir, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await restarted.configure(SELF.name, SELF.email, remote, TOKEN);

        expect(await restarted.git(['rev-parse', 'HEAD'])).toBe(merged);
        expect(await restarted.git(['status', '--porcelain'])).toBe('');
    });

    test('a restart keeps local edits that differ from origin/master', async () => {
        fs.writeFileSync(path.join(work, 'apps/agent/src/a.js'), 'module.exports = 7;\n');
        ownerCommit('apps/agent/src/c.js', 'c();\n', 'feat: c upstream');

        const restarted = new GitOps(work, SELF, { stateDir, fetch: fakeFetch(), repoSlug: 'owner/repo' });
        await restarted.configure(SELF.name, SELF.email, remote, TOKEN);

        expect(fs.readFileSync(path.join(work, 'apps/agent/src/a.js'), 'utf8')).toBe('module.exports = 7;\n');
        expect(fs.readFileSync(path.join(work, 'apps/agent/src/c.js'), 'utf8')).toBe('c();\n');
    });

    test('isTracked answers from the supervisor index, not the agent one', async () => {
        fs.writeFileSync(path.join(work, 'apps/agent/src/planted.env'), 'X=1\n');
        git(['add', '-f', 'apps/agent/src/planted.env'], work);
        expect(await gitOps.isTracked('apps/agent/src/a.js')).toBe(true);
        expect(await gitOps.isTracked('apps/agent/src/planted.env')).toBe(false);
        expect(await gitOps.isTracked('.git/config')).toBe(false);
        expect(await gitOps.isTracked('../outside')).toBe(false);
        expect(await gitOps.isTracked('apps/agent/src/*')).toBe(false);
        expect(await gitOps.isTracked('')).toBe(false);
    });

    test('the token never reaches the stored config', async () => {
        expect(fs.readFileSync(path.join(stateDir, 'repo.git', 'config'), 'utf8')).not.toContain(TOKEN);
    });
});
