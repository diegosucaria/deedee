const { GitOps } = require('../src/git-ops');
const child_process = require('child_process');

// Mock git so no real repo is touched. exec answers `git status`; execFile records adds.
jest.mock('child_process', () => ({
    exec: jest.fn((cmd, opts, cb) => {
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    }),
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof args === 'function') cb = args;
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    })
}));

function addCalls() {
    return child_process.execFile.mock.calls
        .filter(call => call[0] === 'git' && call[1].includes('add') && !call[1].includes('commit'))
        .map(call => call[1]);
}

describe('GitOps staging rules', () => {
    let gitOps;

    beforeEach(() => {
        jest.clearAllMocks();
        gitOps = new GitOps('/tmp/test', { name: 'Deedee Supervisor', email: 'supervisor@example.test' });
        gitOps._scanForSecrets = jest.fn().mockResolvedValue();
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
    });

    // `git status --porcelain -z` ends every entry with NUL.
    function mockStatus(entries) {
        child_process.exec.mockImplementation((cmd, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            const stdout = cmd.includes('git status') ? entries.map(e => `${e}\0`).join('') : '';
            cb(null, { stdout, stderr: '' });
            return { unref: () => { } };
        });
    }

    test('never runs git add . ; uses add -u with literal pathspecs for tracked changes', async () => {
        mockStatus([' M apps/agent/src/agent.js']);

        const result = await gitOps.commitAndPush('fix: thing');

        expect(result.success).toBe(true);
        const adds = addCalls();
        expect(adds).toEqual([['--literal-pathspecs', 'add', '-u', '--', 'apps/agent/src/agent.js']]);
        expect(adds.some(args => args.includes('.'))).toBe(false);
        const statusCmd = child_process.exec.mock.calls.find(([cmd]) => cmd.includes('git status'))[0];
        expect(statusCmd).toBe('git status --porcelain -z --untracked-files=all');
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

    test('commit carries the identity per command, so repo config is irrelevant', async () => {
        mockStatus([' M apps/agent/src/agent.js']);

        await gitOps.commitAndPush('fix: thing');

        const commit = child_process.execFile.mock.calls
            .map(call => call[1])
            .find(args => args.includes('commit'));
        expect(commit).toEqual([
            '-c', 'user.name=Deedee Supervisor',
            '-c', 'user.email=supervisor@example.test',
            'commit', '-m', 'fix: thing'
        ]);
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
            await gitOps.runSafe('git', ['status']);
            await gitOps.run('git status');
        } finally {
            delete process.env.GIT_DIR;
            delete process.env.GIT_WORK_TREE;
            delete process.env.GIT_INDEX_FILE;
        }

        const safeOpts = child_process.execFile.mock.calls.at(-1)[2];
        const shellOpts = child_process.exec.mock.calls.at(-1)[1];
        for (const opts of [safeOpts, shellOpts]) {
            expect(opts.cwd).toBe('/tmp/test');
            expect(opts.env.GIT_DIR).toBeUndefined();
            expect(opts.env.GIT_WORK_TREE).toBeUndefined();
            expect(opts.env.GIT_INDEX_FILE).toBeUndefined();
            expect(opts.env.PATH).toBe(process.env.PATH);
        }
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

describe('GitOps rollback guard', () => {
    let gitOps;
    let commands;

    function safeCalls() {
        return child_process.execFile.mock.calls.map(call => call[1]);
    }

    beforeEach(() => {
        jest.clearAllMocks();
        commands = [];
        gitOps = new GitOps('/tmp/test', { name: 'Deedee Supervisor', email: 'supervisor@example.test' });
        child_process.exec.mockImplementation((cmd, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            commands.push(cmd);
            const stdout = cmd.includes('rev-parse') ? 'aaaa111\n' : '';
            cb(null, { stdout, stderr: '' });
            return { unref: () => { } };
        });
    });

    test('reverts when HEAD still is the expected self-commit', async () => {
        const result = await gitOps.rollback({ expectedHead: 'aaaa111' });
        expect(result.success).toBe(true);
        expect(result.revertCommit).toBe('aaaa111');
        expect(safeCalls().some(args => args.includes('revert'))).toBe(true);
        expect(safeCalls().some(args => args.includes('push'))).toBe(true);
    });

    test('revert carries the identity per command and never touches a shell', async () => {
        await gitOps.rollback({ expectedHead: 'aaaa111' });

        const revert = safeCalls().find(args => args.includes('revert'));
        expect(revert).toEqual([
            '-c', 'user.name=Deedee Supervisor',
            '-c', 'user.email=supervisor@example.test',
            'revert', '--no-edit', 'HEAD'
        ]);
        expect(commands.some(c => c.includes('revert'))).toBe(false);
    });

    test('refuses when HEAD moved away from the self-commit', async () => {
        const result = await gitOps.rollback({ expectedHead: 'bbbb222' });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Rollback aborted/);
        expect(safeCalls().some(args => args.includes('revert'))).toBe(false);
        expect(safeCalls().some(args => args.includes('push'))).toBe(false);
    });

    test('manual rollback without expectedHead still reverts', async () => {
        const result = await gitOps.rollback();
        expect(result.success).toBe(true);
        expect(safeCalls().some(args => args.includes('revert'))).toBe(true);
    });
});
