const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalTools, redactSecrets, shellEnv } = require('../src/local/index');

describe('LocalTools keeps credentials out of tool output', () => {
    const FAKE = 'fake-secret-value-123';
    let dir;
    let tools;

    beforeEach(() => {
        process.env.TEST_SERVICE_PASSWORD = FAKE;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
        tools = new LocalTools(dir);
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        delete process.env.TEST_SERVICE_PASSWORD;
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('printenv and /proc/*/environ are blocked', async () => {
        await expect(tools.runShellCommand('printenv | grep TEST')).rejects.toThrow(/blocked/);
        await expect(tools.runShellCommand('cat /proc/self/environ')).rejects.toThrow(/process environments/);
    });

    test('shell output never shows a secret env value', async () => {
        const r = await tools.runShellCommand(`echo "pw is ${FAKE}"`);
        expect(r.stdout).toBe('pw is [REDACTED:TEST_SERVICE_PASSWORD]');
        const viaVar = await tools.runShellCommand('echo "$TEST_SERVICE_PASSWORD"');
        expect(viaVar.stdout).not.toContain(FAKE);
    });

    test('readFile redacts secret-named lines, even for values this process lacks', async () => {
        fs.writeFileSync(path.join(dir, 'x.env'), 'SERVICE_USERNAME=someone\nOTHER_API_KEY=abc123xyz\nHOST=example.com\n');
        const text = await tools.readFile('x.env');
        expect(text).toContain('SERVICE_USERNAME=someone');
        expect(text).toContain('OTHER_API_KEY=[REDACTED]');
        expect(text).toContain('HOST=example.com');
    });

    test('redactSecrets leaves ordinary text alone', () => {
        expect(redactSecrets('nothing to hide here', {})).toBe('nothing to hide here');
    });
});

describe('LocalTools gives a shell command a minimal environment', () => {
    let dir;
    let tools;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-env-'));
        tools = new LocalTools(dir);
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        delete process.env.PROVIDER_API_KEY;
        delete process.env.SHELL_ENV_PASSTHROUGH;
        delete process.env.WEATHER_CITY;
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a provider key never reaches the child, even with no output', async () => {
        process.env.PROVIDER_API_KEY = 'top-secret-key-value';
        // Written to a file, so redaction of stdout cannot be what hides it.
        const out = path.join(dir, 'leak.txt');
        await tools.runShellCommand(`printf '%s' "$PROVIDER_API_KEY" > ${out}`);
        expect(fs.readFileSync(out, 'utf8')).toBe('');
    });

    test('the base variables are there, so ordinary commands still work', async () => {
        const r = await tools.runShellCommand('echo "$HOME|$LANG" && pwd');
        expect(r.error).toBeUndefined();
        expect(r.stdout).toContain(fs.realpathSync(dir));
    });

    test('SHELL_ENV_PASSTHROUGH lets named variables through', async () => {
        process.env.WEATHER_CITY = 'Cordoba';
        process.env.SHELL_ENV_PASSTHROUGH = 'WEATHER_CITY';
        const r = await tools.runShellCommand('echo "city=$WEATHER_CITY"');
        expect(r.stdout).toBe('city=Cordoba');
    });

    test('shellEnv keeps the base, the allowlist and nothing else', () => {
        const env = shellEnv({
            PATH: '/bin', HOME: '/root', TZ: 'UTC', LANG: 'C',
            GOOGLE_API_KEY: 'k', GITHUB_PAT: 'p',
            SHELL_ENV_PASSTHROUGH: 'ONE, TWO', ONE: '1', TWO: '2', THREE: '3'
        });
        expect(env).toEqual({ PATH: '/bin', HOME: '/root', TZ: 'UTC', LANG: 'C', ONE: '1', TWO: '2' });
    });

    test('shellEnv always sets a PATH', () => {
        expect(shellEnv({}).PATH).toContain('/usr/bin');
    });
});

describe('redactSecrets hides GitHub tokens and credentials in URLs', () => {
    const fake = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    test('a remote URL with a token', () => {
        const line = `\turl = https://x-access-token:ghs_${fake}@github.com/owner/repo.git`;
        const out = redactSecrets(line, {});
        expect(out).not.toContain(fake);
        expect(out).toBe('\turl = https://[REDACTED]@github.com/owner/repo.git');
    });

    test('a fine-grained token on its own', () => {
        const out = redactSecrets(`token github_pat_${fake} here`, {});
        expect(out).toBe('token [REDACTED] here');
    });

    test('a classic token on its own', () => {
        expect(redactSecrets(`ghp_${fake}`, {})).toBe('[REDACTED]');
    });

    test('PAT- and WEBHOOK-named lines are redacted', () => {
        const out = redactSecrets('GITHUB_PAT=abc123def\nSLACK_WEBHOOK: https://hooks.example/x\n', {});
        expect(out).toContain('GITHUB_PAT=[REDACTED]');
        expect(out).toContain('SLACK_WEBHOOK: [REDACTED]');
    });

    test('an ordinary URL survives', () => {
        expect(redactSecrets('clone https://github.com/owner/repo.git', {}))
            .toBe('clone https://github.com/owner/repo.git');
    });
});
