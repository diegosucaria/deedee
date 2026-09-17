
const { GitOps } = require('../src/git-ops');
const child_process = require('child_process');

// Mock child_process at top level to ensure promisify picks it up
jest.mock('child_process', () => ({
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof args === 'function') cb = args;
        if (typeof opts === 'function') cb = opts;
        let stdout = '';
        if (args.includes('status')) stdout = ' M apps/agent/src/a.js\0';
        else if (args.includes('write-tree')) stdout = 'tree-new';
        else if (args.includes('rev-parse')) stdout = 'tree-old';
        else if (args.includes('commit-tree')) stdout = 'c0ffee';
        cb(null, { stdout, stderr: '' });
        return { unref: () => { } };
    })
}));

describe('GitOps Shell Injection Prevention', () => {
    let gitOps;
    let mockExecFile;

    beforeEach(() => {
        // Clear history but keep implementation
        jest.clearAllMocks();
        mockExecFile = child_process.execFile;

        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        gitOps = new GitOps('/tmp/test', null, {
            stateDir: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'inj-state-')),
            fetch: jest.fn(async () => ({ ok: true, status: 201, text: async () => '{"number":1,"html_url":"u"}' }))
        });
        gitOps.remoteUrl = 'https://github.com/owner/repo.git';
        gitOps.token = 'tok';
        // Mock internal methods
        gitOps._scanForSecrets = jest.fn().mockResolvedValue();
        gitOps.verifier = { verify: jest.fn().mockResolvedValue() };
    });

    test('should use execFile for commit to prevent shell injection', async () => {
        const maliciousMessage = '"; rm -rf /; echo "pwned';

        await gitOps.commitAndPush(maliciousMessage);

        const commitCall = mockExecFile.mock.calls.find(call => call[1].includes('commit-tree'));
        expect(commitCall[0]).toBe('git');
        const args = commitCall[1];
        expect(args[args.indexOf('-m') + 1]).toBe(maliciousMessage);
    });

    test('a malicious file name is refused before any git or node command', async () => {
        // Inside an allowed folder, so only the character filter stops it
        const maliciousFile = 'apps/agent/; rm -rf x.js';

        const result = await gitOps.commitAndPush('safe message', [maliciousFile]);

        expect(result.success).toBe(false);
        expect(result.skipped).toEqual([maliciousFile]);
        expect(gitOps.verifier.verify).not.toHaveBeenCalled();
        expect(mockExecFile.mock.calls.some(call => call[1].includes('add'))).toBe(false);
    });
});
