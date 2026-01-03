
const { GitOps } = require('../src/git-ops');
const fs = require('fs');
const path = require('path');

describe('GitOps Security Scan', () => {
    let gitOps;
    const testDir = path.join(__dirname, 'test_workspace');

    beforeAll(() => {
        if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);
        gitOps = new GitOps(testDir);
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('should detect OpenAI SK key', async () => {
        const file = 'secret.txt';
        fs.writeFileSync(path.join(testDir, file), 'some_code = "sk-12345678901234567890"');
        await expect(gitOps._scanForSecrets([file])).rejects.toThrow(/SECURITY ALERT/);
    });

    test('should detect Private Key', async () => {
        const file = 'key.pem';
        fs.writeFileSync(path.join(testDir, file), '-----BEGIN PRIVATE KEY-----');
        await expect(gitOps._scanForSecrets([file])).rejects.toThrow(/SECURITY ALERT/);
    });

    test('should allow safe files', async () => {
        const file = 'safe.js';
        fs.writeFileSync(path.join(testDir, file), 'console.log("hello world")');
        await expect(gitOps._scanForSecrets([file])).resolves.not.toThrow();
    });

    test('should ignore example files', async () => {
        const file = '.env.example';
        fs.writeFileSync(path.join(testDir, file), 'OPENAI_KEY=sk-12345678901234567890');
        await expect(gitOps._scanForSecrets([file])).resolves.not.toThrow();
    });
});
