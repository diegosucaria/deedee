
const { GitOps } = require('../src/git-ops');
const child_process = require('child_process');

// Mock child_process at top level to ensure promisify picks it up
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

describe('GitOps Shell Injection Prevention', () => {
    let gitOps;
    let mockExec;
    let mockExecFile;

    beforeEach(() => {
        // Clear history but keep implementation
        jest.clearAllMocks();
        mockExec = child_process.exec;
        mockExecFile = child_process.execFile;

        gitOps = new GitOps('/tmp/test');
        // Mock internal methods
        gitOps._scanForSecrets = jest.fn().mockResolvedValue();
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
    });

    test('should use execFile for commit to prevent shell injection', async () => {
        const maliciousMessage = '"; rm -rf /; echo "pwned';

        await gitOps.commitAndPush(maliciousMessage);

        // Verify execFile was called for commit
        // Expected args: git, ['commit', '-m', maliciousMessage]
        // Verify execFile was called for commit
        // Filter calls to find the one that is NOT git status (if any)
        // Or just check that ONE of the calls matches our expectation
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['commit', '-m', maliciousMessage]),
            expect.any(Object),
            expect.any(Function)
        );

        // Verify the malicious message was passed as a SINGLE argument, not interpreted
        const commitCall = mockExecFile.mock.calls.find(call => call[1].includes('commit'));
        const args = commitCall[1];
        const messageArg = args[args.indexOf('-m') + 1];

        expect(messageArg).toBe(maliciousMessage);
    });

    test('should use execFile for add with malicious filenames', async () => {
        const maliciousFile = '; rm -rf /';

        await gitOps.commitAndPush('safe message', [maliciousFile]);

        // Verify execFile was called for add
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['add', maliciousFile]),
            expect.any(Object),
            expect.any(Function)
        );
    });
});
