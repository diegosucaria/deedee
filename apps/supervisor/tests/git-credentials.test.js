const child_process = require('child_process');

// Mock git so no real repo is touched.
jest.mock('child_process', () => ({
    execFile: jest.fn((file, args, opts, cb) => {
        if (typeof args === 'function') cb = args;
        if (typeof opts === 'function') cb = opts;
        cb(null, { stdout: '', stderr: '' });
        return { unref: () => { } };
    })
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitOps, splitRemoteCredentials, githubSlug } = require('../src/git-ops');

const TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REMOTE = 'https://github.com/owner/repo.git';

/** Git arguments after the safety flags and --git-dir/--work-tree. */
function execFileCalls() {
    return child_process.execFile.mock.calls.filter(c => c[0] === 'git').map(c => {
        const args = c[1];
        return args.slice(args.findIndex(a => a.startsWith('--work-tree=')) + 1);
    });
}

describe('splitRemoteCredentials', () => {
    test('splits a token off the URL', () => {
        expect(splitRemoteCredentials(`https://${TOKEN}@github.com/owner/repo.git`))
            .toEqual({ url: REMOTE, token: TOKEN });
    });

    test('splits a user:token pair', () => {
        expect(splitRemoteCredentials(`https://x-access-token:${TOKEN}@github.com/owner/repo.git`))
            .toEqual({ url: REMOTE, token: TOKEN });
    });

    test('leaves a clean URL alone', () => {
        expect(splitRemoteCredentials(REMOTE)).toEqual({ url: REMOTE, token: null });
    });

    test('leaves an SSH remote alone', () => {
        const ssh = 'git@github.com:owner/repo.git';
        expect(splitRemoteCredentials(ssh)).toEqual({ url: ssh, token: null });
    });
});

describe('githubSlug', () => {
    test('reads owner/repo from an https GitHub URL', () => {
        expect(githubSlug(REMOTE)).toBe('owner/repo');
        expect(githubSlug('https://github.com/owner/repo')).toBe('owner/repo');
        expect(githubSlug('https://example.test/owner/repo.git')).toBeNull();
        expect(githubSlug('git@github.com:owner/repo.git')).toBeNull();
    });
});

describe('GitOps credentials', () => {
    let gitOps;
    let stateDir;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-state-'));
        gitOps = new GitOps('/tmp/test', null, { stateDir });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(stateDir, { recursive: true, force: true });
    });

    test('configure stores no remote and no token; the token only rides as a header', async () => {
        await gitOps.configure('Name', 'mail@example.test', REMOTE, TOKEN);

        const calls = execFileCalls();
        expect(calls.some(args => args.includes('remote'))).toBe(false);
        const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
        const fetch = calls.find(args => args.includes('fetch'));
        expect(fetch).toEqual(expect.arrayContaining([REMOTE]));
        const raw = child_process.execFile.mock.calls.find(c => c[1].includes('fetch'))[1];
        expect(raw).toContain(`http.${REMOTE}.extraheader=Authorization: Basic ${basic}`);
        // The token appears only inside that header, never as its own argument
        expect(raw.filter(a => a.includes(TOKEN))).toEqual([]);
    });

    test('a URL that carries a token is used clean, and the token still works', async () => {
        await gitOps.configure('Name', 'mail@example.test', `https://${TOKEN}@github.com/owner/repo.git`);
        expect(gitOps.token).toBe(TOKEN);
        expect(gitOps.remoteUrl).toBe(REMOTE);
        expect(JSON.stringify(execFileCalls())).not.toContain(TOKEN);
    });

    test('remote commands name the configured URL, not the remote origin', async () => {
        await gitOps.configure('Name', 'mail@example.test', REMOTE, TOKEN);
        jest.clearAllMocks();

        await gitOps.pull();
        await gitOps.rollback();

        const remoteCalls = execFileCalls().filter(args => args.includes('push') || args.includes('fetch'));
        expect(remoteCalls.length).toBeGreaterThan(0);
        for (const args of remoteCalls) {
            expect(args).toContain(REMOTE);
            expect(args).not.toContain('origin');
        }
    });

    test('with no configured URL, a remote command is refused', async () => {
        gitOps.token = TOKEN;
        gitOps.remoteUrl = null;

        expect(() => gitOps._remoteTarget()).toThrow(/no remote URL/i);
        expect((await gitOps.pull()).success).toBe(false);
        expect(execFileCalls().some(args => args.includes('push') || args.includes('fetch'))).toBe(false);
    });

    test('a failed git command never returns the token', async () => {
        gitOps.token = TOKEN;
        gitOps.remoteUrl = REMOTE;
        const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
        child_process.execFile.mockImplementationOnce((file, args, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            cb(Object.assign(new Error(`Command failed: git -c http.extraheader=Authorization: Basic ${basic} push`), { stderr: `fatal: ${TOKEN} rejected` }));
            return { unref: () => { } };
        });

        await expect(gitOps.git(['push', REMOTE, 'x:y'], { authed: true })).rejects.toThrow(/\[REDACTED\]/);

        const logged = console.error.mock.calls.flat().join(' ');
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain(basic);
    });

    test('a GitHub API error never returns the token', async () => {
        gitOps.token = TOKEN;
        gitOps.remoteUrl = REMOTE;
        gitOps.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => `bad credentials ${TOKEN}` }));
        await expect(gitOps._github('GET', '/repos/owner/repo/pulls/1')).rejects.toThrow(/401/);
        await expect(gitOps._github('GET', '/repos/owner/repo/pulls/1')).rejects.not.toThrow(new RegExp(TOKEN));
    });
});
