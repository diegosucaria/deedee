const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LocalTools, commandHeads } = require('../src/local/index');

// Under a git hook, GIT_DIR and friends point at the real repository. Drop
// every GIT_ variable so these commands only touch the temp dir.
function git(cwd, ...args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    execFileSync('git', args, {
        cwd,
        stdio: 'pipe',
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    });
}

describe('LocalTools file sandbox follows symlinks', () => {
    let base;
    let root;
    let outside;
    let tools;

    beforeEach(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-sandbox-')));
        root = path.join(base, 'source');
        outside = path.join(base, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside content');
        tools = new LocalTools(root);
    });

    afterEach(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    test('a link to a folder outside the tree is refused for read, write and list', async () => {
        fs.symlinkSync(outside, path.join(root, 'escape'));
        await expect(tools.readFile('escape/secret.txt')).rejects.toThrow(/Access denied/);
        await expect(tools.listDirectory('escape')).rejects.toThrow(/Access denied/);
        await expect(tools.writeFile('escape/new.txt', 'x')).rejects.toThrow(/Access denied/);
        await expect(tools.writeFile('escape/deeper/new.txt', 'x')).rejects.toThrow(/Access denied/);
        expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
        expect(fs.existsSync(path.join(outside, 'deeper'))).toBe(false);
    });

    test('a link to / is refused', async () => {
        fs.symlinkSync('/', path.join(root, 'r'));
        await expect(tools.readFile('r/etc/hostname')).rejects.toThrow(/Access denied/);
        await expect(tools.listDirectory('r')).rejects.toThrow(/Access denied/);
    });

    test('a link to a file outside the tree is refused, and so is writing through it', async () => {
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        await expect(tools.readFile('link.txt')).rejects.toThrow(/Access denied/);
        await expect(tools.writeFile('link.txt', 'overwritten')).rejects.toThrow(/Access denied/);
        expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside content');
    });

    test('a dangling link that would create a file outside is refused', async () => {
        fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(root, 'dangling.txt'));
        await expect(tools.writeFile('dangling.txt', 'x')).rejects.toThrow(/Access denied/);
        expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    });

    test('a sibling folder that shares the prefix is outside', async () => {
        fs.mkdirSync(path.join(base, 'source-evil'));
        fs.writeFileSync(path.join(base, 'source-evil', 'x.txt'), 'x');
        await expect(tools.readFile('../source-evil/x.txt')).rejects.toThrow(/Access denied/);
    });

    test('a link that stays inside the tree still works', async () => {
        fs.mkdirSync(path.join(root, 'real'));
        fs.writeFileSync(path.join(root, 'real', 'a.txt'), 'inside');
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
        await expect(tools.readFile('alias/a.txt')).resolves.toBe('inside');
        await tools.writeFile('alias/b.txt', 'new');
        expect(fs.readFileSync(path.join(root, 'real', 'b.txt'), 'utf8')).toBe('new');
    });

    test('writes under .git/ and .github/ are refused, also through a link', async () => {
        fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
        await expect(tools.writeFile('.git/hooks/pre-commit', '#!/bin/sh')).rejects.toThrow(/\.git\//);
        await expect(tools.writeFile('.git/config', '[core]')).rejects.toThrow(/\.git\//);
        await expect(tools.writeFile('.github/workflows/deploy.yml', 'on: push')).rejects.toThrow(/\.github\//);
        await expect(tools.writeFile('packages/x/.git/config', '')).rejects.toThrow(/\.git\//);
        fs.symlinkSync(path.join(root, '.git'), path.join(root, 'innocent'));
        await expect(tools.writeFile('innocent/hooks/post-checkout', 'x')).rejects.toThrow(/\.git\//);
        expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
    });
});

describe('LocalTools redaction of reads', () => {
    let root;
    let tools;
    const SOURCE = 'const token = getToken();\nconst apiKey: string = config.key;\nmodule.exports = { token };\n';

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-redact-')));
        git(root, 'init', '-q');
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src', 'tracked.js'), SOURCE);
        git(root, 'add', 'src/tracked.js');
        fs.writeFileSync(path.join(root, 'untracked.env'), 'SERVICE_API_KEY=abc123xyz\nHOST=example.com\n');
        tools = new LocalTools(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('a tracked source file comes back as it is on disk', async () => {
        await expect(tools.readFile('src/tracked.js')).resolves.toBe(SOURCE);
    });

    test('read-then-write of a tracked file leaves it unchanged', async () => {
        const text = await tools.readFile('src/tracked.js');
        await tools.writeFile('src/tracked.js', text);
        expect(fs.readFileSync(path.join(root, 'src', 'tracked.js'), 'utf8')).toBe(SOURCE);
    });

    test('an untracked file is still redacted', async () => {
        const text = await tools.readFile('untracked.env');
        expect(text).toContain('SERVICE_API_KEY=[REDACTED]');
        expect(text).not.toContain('abc123xyz');
        expect(text).toContain('HOST=example.com');
    });

    test('files under .git are redacted even though git knows them', async () => {
        fs.appendFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://user:hunter22@example.test/r.git\n');
        const text = await tools.readFile('.git/config');
        expect(text).not.toContain('hunter22');
    });

    test('a link to .git/config from a tracked-looking name is redacted', async () => {
        fs.appendFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://user:hunter22@example.test/r.git\n');
        fs.symlinkSync(path.join(root, '.git', 'config'), path.join(root, 'src', 'cfg.js'));
        git(root, 'add', 'src/cfg.js');
        const text = await tools.readFile('src/cfg.js');
        expect(text).not.toContain('hunter22');
    });

    test('writeFile refuses content with a redaction marker', async () => {
        const text = await tools.readFile('untracked.env');
        await expect(tools.writeFile('untracked.env', text)).rejects.toThrow(/REDACTED/);
        expect(fs.readFileSync(path.join(root, 'untracked.env'), 'utf8')).toContain('abc123xyz');
        await expect(tools.writeFile('src/new.js', 'x = "[REDACTED:GOOGLE_API_KEY]"')).rejects.toThrow(/REDACTED/);
    });

    test('outside a git repository every read is redacted', async () => {
        const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-plain-')));
        try {
            fs.writeFileSync(path.join(plain, 'a.env'), 'OTHER_TOKEN=abcdef123\n');
            const text = await new LocalTools(plain).readFile('a.env');
            expect(text).toBe('OTHER_TOKEN=[REDACTED]\n');
        } finally {
            fs.rmSync(plain, { recursive: true, force: true });
        }
    });
});

describe('shell blocklist looks past the first word', () => {
    let tools;
    beforeEach(() => {
        tools = new LocalTools(os.tmpdir());
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test.each([
        'sh -c env',
        'bash -c "printenv"',
        "bash -lc 'env | sort'",
        'cd /tmp && printenv',
        'ls; env',
        'true || printenv',
        'echo $(printenv)',
        'nohup env',
        'timeout 5 printenv',
        'xargs -n 1 printenv',
        '/usr/bin/env',
        'FOO=1 printenv',
    ])('blocks %s', async (command) => {
        await expect(tools.runShellCommand(command)).rejects.toThrow(/blocked/);
    });

    test.each([
        ['git commit -m "stop; halt the loop"', ['git']],
        ['command -v vim', ['command']],
        ['npm test 2>&1 | tail -5', ['npm', '1', 'tail']],
        ["grep -r 'env' src | head", ['grep', 'head']],
        ['cat <<EOF > notes.md\ninit the db\ntop of the list\nEOF', ['cat']],
        ['node -e "console.log(1)"', ['node']],
    ])('ordinary command %s is not blocked', (command, heads) => {
        expect(commandHeads(command)).toEqual(heads);
    });
});
