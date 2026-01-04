
const { GitOps } = require('../src/git-ops');
const child_process = require('child_process');
const util = require('util');

// Mock child_process
jest.mock('child_process', () => ({
    exec: jest.fn(),
    execFile: jest.fn(),
}));

describe('GitOps Shell Injection Prevention', () => {
    let gitOps;
    let mockExecFile;
    let mockExec;

    beforeEach(() => {
        jest.clearAllMocks();
        mockExec = child_process.exec;
        mockExecFile = child_process.execFile;

        // Mock implementation to return success
        mockExec.mockImplementation((cmd, opts, cb) => cb(null, { stdout: '', stderr: '' }));
        mockExecFile.mockImplementation((file, args, opts, cb) => cb(null, { stdout: '', stderr: '' }));

        gitOps = new GitOps('/tmp/test');
        // Mock internal methods to isolate commit logic
        gitOps._scanForSecrets = jest.fn().mockResolvedValue();
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
    });

    test('should use execFile for commit to prevent shell injection', async () => {
        const maliciousMessage = '"; rm -rf /; echo "pwned';

        await gitOps.commitAndPush(maliciousMessage);

        // Verify execFile was called for commit
        // Expected args: git, ['commit', '-m', maliciousMessage]
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
