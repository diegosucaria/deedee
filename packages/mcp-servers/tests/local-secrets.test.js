const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalTools, redactSecrets } = require('../src/local/index');

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
