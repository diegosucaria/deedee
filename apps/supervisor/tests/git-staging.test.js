const { GitOps } = require('../src/git-ops');
const child_process = require('child_process');

// Mock git so no real repo is touched. The mock answers status, write-tree,
// rev-parse and commit-tree; everything else prints nothing.
let mockStatusOutput = '';
jest.mock('child_process', () => ({
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof args === 'function') cb = args;
        if (typeof opts === 'function') cb = opts;
        let stdout = '';
        if (args.includes('status')) stdout = mockStatusOutput;
        else if (args.includes('write-tree')) stdout = 'tree-new\n';
        else if (args.includes('rev-parse')) stdout = 'tree-old\n';
        else if (args.includes('commit-tree')) stdout = 'c0ffee\n';
        cb(null, { stdout, stderr: '' });
        return { unref: () => { } };
    })
}));

/** The git arguments after the fixed safety flags and --git-dir/--work-tree. */
function gitArgs(call) {
    const args = call[1];
    const start = args.findIndex(a => a.startsWith('--work-tree=')) + 1;
    return args.slice(start);
}

function addCalls() {
    return child_process.execFile.mock.calls
        .filter(call => call[0] === 'git')
        .map(gitArgs)
        .filter(args => args.includes('add'));
}

function fakeFetch() {
    return jest.fn(async () => ({ ok: true, status: 201, text: async () => '{"number":7,"html_url":"https://github.example/pull/7"}' }));
}

describe('GitOps staging rules', () => {
    let gitOps;

    beforeEach(() => {
        jest.clearAllMocks();
        mockStatusOutput = '';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        gitOps = new GitOps('/tmp/test', { name: 'Deedee Supervisor', email: 'supervisor@example.test' },
            { stateDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'staging-state-')), fetch: fakeFetch() });
        gitOps.remoteUrl = 'https://github.com/owner/repo.git';
        gitOps.token = 'tok';
        gitOps._scanForSecrets = jest.fn().mockResolvedValue();
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
    });

    afterEach(() => {
        require('fs').rmSync(gitOps.stateDir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    // `git status --porcelain -z` ends every entry with NUL.
    function mockStatus(entries) {
        mockStatusOutput = entries.map(e => `${e}\0`).join('');
    }

    test('never runs git add . ; uses add -u with literal pathspecs for tracked changes', async () => {
        mockStatus([' M apps/agent/src/agent.js']);

        const result = await gitOps.commitAndPush('fix: thing');

        expect(result.success).toBe(true);
        const adds = addCalls();
        expect(adds).toEqual([['--literal-pathspecs', 'add', '-u', '--', 'apps/agent/src/agent.js']]);
        expect(adds.some(args => args.includes('.'))).toBe(false);
        const status = child_process.execFile.mock.calls.map(gitArgs).find(args => args.includes('status'));
        expect(status).toEqual(['status', '--porcelain', '-z', '--untracked-files=all']);
    });

    test('_parseStatus keeps a path with a space as is and takes the new name of a rename', () => {
        const out = [
            ' M apps/agent/src/agent.js',
            '?? apps/agent/src/my file.js',
            'R  apps/agent/src/new.js', 'apps/agent/src/old.js',
            '?? docs/nota con espacio.md'
        ].map(e => `${e}\0`).join('');

        expect(gitOps._parseStatus(out)).toEqual({
            tracked: ['apps/agent/src/agent.js', 'apps/agent/src/new.js'],
            untracked: ['apps/agent/src/my file.js', 'docs/nota con espacio.md']
        });
    });

    test('a file name with a shell metacharacter never reaches the verifier or git add', async () => {
        mockStatus([
            ' M apps/agent/src/agent.js',
            '?? apps/agent/src/x; rm -rf y.js',
            '?? apps/agent/src/$(id).js'
        ]);

        const result = await gitOps.commitAndPush('feat: x');

        expect(result.success).toBe(false);
        expect(result.skipped).toEqual(['apps/agent/src/x; rm -rf y.js', 'apps/agent/src/$(id).js']);
        expect(gitOps.verifier.verify).not.toHaveBeenCalled();
        expect(addCalls()).toEqual([]);
    });

    test('a tracked file with an unsafe name is skipped and fails the commit', async () => {
        mockStatus([' M apps/agent/src/agent.js', ' M apps/agent/src/a;b.js']);

        const result = await gitOps.commitAndPush('feat: x');

        expect(result.success).toBe(false);
        expect(result.skipped).toEqual(['apps/agent/src/a;b.js']);
        expect(addCalls()).toEqual([]);
    });

    test('the commit is built with commit-tree, carries the identity, and goes to a self branch', async () => {
        mockStatus([' M apps/agent/src/agent.js']);

        const result = await gitOps.commitAndPush('fix: thing');

        expect(result.success).toBe(true);
        const calls = child_process.execFile.mock.calls.map(gitArgs);
        expect(calls.find(args => args.includes('commit-tree'))).toEqual([
            '-c', 'user.name=Deedee Supervisor',
            '-c', 'user.email=supervisor@example.test',
            'commit-tree', 'tree-new', '-p', 'HEAD', '-m', 'fix: thing'
        ]);
        expect(calls.some(args => args.includes('commit'))).toBe(false);
        const push = calls.find(args => args.includes('push'));
        expect(push.at(-1)).toMatch(/^c0ffee:refs\/heads\/deedee\/self\/\d{8}-\d{6}$/);
        expect(calls.some(args => args.some(a => /master/.test(a)) && args.includes('push'))).toBe(false);
        // Staging uses a throwaway index, never the main one
        const addOpts = child_process.execFile.mock.calls.find(call => gitArgs(call).includes('add'))[2];
        expect(addOpts.env.GIT_INDEX_FILE).toMatch(/index\.tmp-/);
    });

    test('every git command carries the safety flags, its own git dir and no system config', async () => {
        mockStatus([' M apps/agent/src/agent.js']);
        await gitOps.commitAndPush('fix: thing');

        for (const [file, args, opts] of child_process.execFile.mock.calls) {
            if (file !== 'git') continue;
            expect(args.slice(0, 4)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
            expect(args).toContain(`--git-dir=${gitOps.gitDir}`);
            expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
        }
    });

    test('a tracked or untracked change under .github or .git fails the commit', async () => {
        mockStatus([' M apps/agent/src/agent.js', ' M .github/workflows/deploy.yml']);
        let result = await gitOps.commitAndPush('feat: x');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/\.github/);

        mockStatus(['?? apps/agent/.git/hooks/x.sh']);
        result = await gitOps.commitAndPush('feat: x');
        expect(result.success).toBe(false);
        expect(addCalls()).toEqual([]);
    });

    test('without a GitHub remote and token nothing runs', async () => {
        gitOps.token = null;
        mockStatus([' M apps/agent/src/agent.js']);
        const result = await gitOps.commitAndPush('feat: x');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/GITHUB_PAT/);
        expect(child_process.execFile).not.toHaveBeenCalled();
    });

    test('skips a root-level untracked file and root data/ paths, commit goes on', async () => {
        mockStatus([
            ' M apps/agent/src/agent.js',
            '?? notes-for-owner.txt',
            '?? data/people.db',
            '?? apps/agent/src/new-tool.js'
        ]);

        const result = await gitOps.commitAndPush('feat: tool');

        expect(result.success).toBe(true);
        expect(result.skipped).toEqual(['notes-for-owner.txt', 'data/people.db']);
        const adds = addCalls();
        expect(adds).toEqual([
            ['--literal-pathspecs', 'add', '-u', '--', 'apps/agent/src/agent.js'],
            ['--literal-pathspecs', 'add', '--', 'apps/agent/src/new-tool.js']
        ]);
        // Scan and verifier still run, on the staged set only
        expect(gitOps._scanForSecrets).toHaveBeenCalledWith(['apps/agent/src/agent.js', 'apps/agent/src/new-tool.js']);
        expect(gitOps.verifier.verify).toHaveBeenCalledWith(['apps/agent/src/agent.js', 'apps/agent/src/new-tool.js']);
    });

    test('a skipped file under an allowed folder fails the commit and lists the drop', async () => {
        mockStatus([
            ' M apps/agent/src/agent.js',
            '?? notes-for-owner.txt',
            '?? apps/agent/data/private.json',
            '?? apps/agent/src/new-tool.js',
            '?? apps/agent/.env'
        ]);

        const result = await gitOps.commitAndPush('feat: tool');

        expect(result.success).toBe(false);
        expect(result.skipped).toEqual(['notes-for-owner.txt', 'apps/agent/data/private.json', 'apps/agent/.env']);
        expect(result.error).toMatch(/Refusing a partial commit/);
        expect(result.error).toContain('apps/agent/data/private.json');
        expect(result.error).toContain('apps/agent/.env');
        expect(result.error).not.toContain('notes-for-owner.txt');
        expect(gitOps.verifier.verify).not.toHaveBeenCalled();
        expect(addCalls()).toEqual([]);
    });

    test('refuses paths outside the allowed folders when files are listed', async () => {
        const result = await gitOps.commitAndPush('chore: x', ['package.json', 'docs/notes.md', '../etc/passwd.md']);

        expect(result.success).toBe(true);
        expect(result.skipped).toEqual(['package.json', '../etc/passwd.md']);
        expect(addCalls()).toEqual([['--literal-pathspecs', 'add', '--', 'docs/notes.md']]);
    });

    test('a listed file under an allowed folder with a bad extension fails the commit', async () => {
        const result = await gitOps.commitAndPush('chore: x', ['docs/notes.md', 'apps/agent/people.db']);

        expect(result.success).toBe(false);
        expect(result.skipped).toEqual(['apps/agent/people.db']);
        expect(addCalls()).toEqual([]);
    });

    test('fails when every listed file is outside the allowed folders', async () => {
        const result = await gitOps.commitAndPush('chore: x', ['secrets.json', 'data/x.db']);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/No file in the allowed folders/);
        expect(result.skipped).toEqual(['secrets.json', 'data/x.db']);
        expect(addCalls()).toEqual([]);
    });

    test('git runs with GIT_DIR and friends removed from the environment', async () => {
        process.env.GIT_DIR = '/elsewhere/.git';
        process.env.GIT_WORK_TREE = '/elsewhere';
        process.env.GIT_INDEX_FILE = '/elsewhere/index';
        try {
            await gitOps.git(['status']);
        } finally {
            delete process.env.GIT_DIR;
            delete process.env.GIT_WORK_TREE;
            delete process.env.GIT_INDEX_FILE;
        }

        const opts = child_process.execFile.mock.calls.at(-1)[2];
        expect(opts.cwd).toBe('/tmp/test');
        expect(opts.env.GIT_DIR).toBeUndefined();
        expect(opts.env.GIT_WORK_TREE).toBeUndefined();
        expect(opts.env.GIT_INDEX_FILE).toBeUndefined();
        expect(opts.env.PATH).toBe(process.env.PATH);
    });

    test('isAllowedPath rules', () => {
        expect(gitOps.isAllowedPath('apps/agent/src/a.js')).toBe(true);
        expect(gitOps.isAllowedPath('.github/workflows/ci.yml')).toBe(false);
        expect(gitOps.isAllowedPath('specs/020-x.md')).toBe(true);
        expect(gitOps.isAllowedPath('packages/core/notes.txt')).toBe(true);
        expect(gitOps.isAllowedPath('README.md')).toBe(false);
        expect(gitOps.isAllowedPath('notes.txt')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/people.db')).toBe(false);
        expect(gitOps.isAllowedPath('data/x.json')).toBe(false);
        expect(gitOps.isAllowedPath('/etc/x.js')).toBe(false);
        // Wider extension list
        expect(gitOps.isAllowedPath('apps/agent/photo.png')).toBe(true);
        expect(gitOps.isAllowedPath('apps/web/src/app/globals.css')).toBe(true);
        expect(gitOps.isAllowedPath('apps/web/public/icon.svg')).toBe(true);
        expect(gitOps.isAllowedPath('apps/agent/scripts/run.sh')).toBe(true);
        expect(gitOps.isAllowedPath('packages/core/index.mjs')).toBe(true);
        expect(gitOps.isAllowedPath('packages/core/index.cjs')).toBe(true);
        expect(gitOps.isAllowedPath('apps/agent/Dockerfile')).toBe(true);
        expect(gitOps.isAllowedPath('apps/agent/Dockerfile.dev')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/.env')).toBe(false);
        // Safe characters only; brackets and plus are fine, shell metacharacters are not
        expect(gitOps.isAllowedPath('apps/web/src/app/chat/[id]/page.js')).toBe(true);
        expect(gitOps.isAllowedPath('apps/agent/src/x; rm -rf y.js')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/src/$(id).js')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/src/my file.js')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/src/`id`.js')).toBe(false);
    });
});
