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
        .filter(call => call[0] === 'git' && call[1][0] === 'add')
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

    function mockStatus(lines) {
        child_process.exec.mockImplementation((cmd, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            const stdout = cmd.includes('git status') ? lines.join('\n') : '';
            cb(null, { stdout, stderr: '' });
            return { unref: () => { } };
        });
    }

    test('never runs git add . ; uses add -u for tracked changes', async () => {
        mockStatus([' M apps/agent/src/agent.js']);

        const result = await gitOps.commitAndPush('fix: thing');

        expect(result.success).toBe(true);
        const adds = addCalls();
        expect(adds).toEqual([['add', '-u']]);
        expect(adds.some(args => args.includes('.'))).toBe(false);
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

    test('skips a root-level untracked file and data/ paths', async () => {
        mockStatus([
            ' M apps/agent/src/agent.js',
            '?? notes-for-owner.txt',
            '?? data/people.db',
            '?? apps/agent/data/private.json',
            '?? apps/agent/src/new-tool.js',
            '?? apps/agent/.env'
        ]);

        const result = await gitOps.commitAndPush('feat: tool');

        expect(result.success).toBe(true);
        expect(result.skipped).toEqual([
            'notes-for-owner.txt',
            'data/people.db',
            'apps/agent/data/private.json',
            'apps/agent/.env'
        ]);
        const adds = addCalls();
        expect(adds).toEqual([
            ['add', '-u'],
            ['add', '--', 'apps/agent/src/new-tool.js']
        ]);
        // Scan and verifier still run, on the staged set only
        expect(gitOps._scanForSecrets).toHaveBeenCalledWith(['apps/agent/src/agent.js', 'apps/agent/src/new-tool.js']);
        expect(gitOps.verifier.verify).toHaveBeenCalledWith(['apps/agent/src/agent.js', 'apps/agent/src/new-tool.js']);
    });

    test('refuses paths outside the allowed folders when files are listed', async () => {
        const result = await gitOps.commitAndPush('chore: x', ['package.json', 'docs/notes.md', '../etc/passwd.md']);

        expect(result.success).toBe(true);
        expect(result.skipped).toEqual(['package.json', '../etc/passwd.md']);
        expect(addCalls()).toEqual([['add', '--', 'docs/notes.md']]);
    });

    test('fails when every listed file is outside the allowed folders', async () => {
        const result = await gitOps.commitAndPush('chore: x', ['secrets.json', 'data/x.db']);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/No file in the allowed folders/);
        expect(result.skipped).toEqual(['secrets.json', 'data/x.db']);
        expect(addCalls()).toEqual([]);
    });

    test('isAllowedPath rules', () => {
        expect(gitOps.isAllowedPath('apps/agent/src/a.js')).toBe(true);
        expect(gitOps.isAllowedPath('.github/workflows/ci.yml')).toBe(false);
        expect(gitOps.isAllowedPath('specs/020-x.md')).toBe(true);
        expect(gitOps.isAllowedPath('packages/core/notes.txt')).toBe(true);
        expect(gitOps.isAllowedPath('README.md')).toBe(false);
        expect(gitOps.isAllowedPath('notes.txt')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/people.db')).toBe(false);
        expect(gitOps.isAllowedPath('apps/agent/photo.png')).toBe(false);
        expect(gitOps.isAllowedPath('data/x.json')).toBe(false);
        expect(gitOps.isAllowedPath('/etc/x.js')).toBe(false);
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
