const child_process = require('child_process');

// Mock git so no real repo is touched.
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

const { GitOps, splitRemoteCredentials } = require('../src/git-ops');

const TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REMOTE = 'https://github.com/owner/repo.git';

function execFileCalls() {
    return child_process.execFile.mock.calls.filter(c => c[0] === 'git').map(c => c[1]);
}
function execCommands() {
    return child_process.exec.mock.calls.map(c => c[0]);
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

describe('GitOps keeps the token out of .git/config', () => {
    let gitOps;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        gitOps = new GitOps('/tmp/test');
    });

    afterEach(() => jest.restoreAllMocks());

    test('configure stores the remote without credentials', async () => {
        await gitOps.configure('Name', 'mail@example.test', REMOTE, TOKEN);

        const setUrl = execFileCalls().find(args => args.includes('remote'));
        expect(setUrl).toEqual(expect.arrayContaining(['remote', 'add', 'origin', REMOTE]));
        expect(JSON.stringify(execFileCalls())).not.toContain(TOKEN);
        expect(JSON.stringify(execCommands())).not.toContain(TOKEN);
    });

    test('a URL that carries a token is stored clean, and the token still works', async () => {
        await gitOps.configure('Name', 'mail@example.test', `https://${TOKEN}@github.com/owner/repo.git`);

        const setUrl = execFileCalls().find(args => args.includes('remote'));
        expect(setUrl).toEqual(expect.arrayContaining(['remote', 'add', 'origin', REMOTE]));
        expect(gitOps.token).toBe(TOKEN);
    });

    test('pull and push carry the credentials as a per-command header', async () => {
        gitOps.token = TOKEN;
        const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

        await gitOps._runAuthed(['push', 'origin', 'master']);

        expect(execFileCalls()[0]).toEqual([
            '-c', `http.extraheader=Authorization: Basic ${basic}`, 'push', 'origin', 'master'
        ]);
    });

    test('a failed remote command never returns the token', async () => {
        gitOps.token = TOKEN;
        const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
        child_process.execFile.mockImplementationOnce((file, args, opts, cb) => {
            if (typeof opts === 'function') cb = opts;
            cb(new Error(`Command failed: git -c http.extraheader=Authorization: Basic ${basic} push origin master\nfatal: ${TOKEN} rejected`));
            return { unref: () => { } };
        });

        await expect(gitOps._runAuthed(['push', 'origin', 'master'])).rejects.toThrow(/\[REDACTED\]/);
        await expect(gitOps._runAuthed(['push', 'origin', 'master'])).resolves.toBe('');

        const logged = console.error.mock.calls.flat().join(' ');
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain(basic);
    });

    test('with no token the commands stay plain', async () => {
        await gitOps._runAuthed(['fetch', 'origin']);
        expect(execFileCalls()[0]).toEqual(['fetch', 'origin']);
    });
});
