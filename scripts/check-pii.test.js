'use strict';

// Every sample below is synthetic. Real-looking values are built by joining
// short fragments so this file itself passes the guard's tree scan.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = require('./check-pii');
const { isAllowedDigits, isSequential, mask, shouldSkipPath, loadDenylist, scanLine, scanText, parseDiff, parseArgs, RULES } = guard;

const j = (...parts) => parts.join('');
const PHONE = j('5491', '123', '456', '789');            // 549 + 10 mixed digits
const PHONE_12 = j('549', '2', '134', '576', '98');       // 549 + 9 mixed digits
const LID = j('2468', '1357', '9024', '681');            // 15 mixed digits
const MIXED_12 = j('4815', '1623', '4271');              // 12 mixed digits, no prefix

const ruleIds = (hits) => hits.map((h) => h.rule);
const scan = (line) => scanLine(line, RULES);

describe('isAllowedDigits', () => {
    test('accepts zero-heavy placeholders', () => {
        for (const d of ['5490000000000', '5490000000001', '5490000000002', '10000000000', '100000000000001', '000000000000000']) {
            expect(isAllowedDigits(d)).toBe(true);
        }
    });

    test('accepts epoch milliseconds, the 555 range and monotone sequences', () => {
        for (const d of ['1700000000000', j('1758', '123456789'), j('1899', '876543210'), '15551234567', '5551234', '1234567890', '123456789012345', '9876543210']) {
            expect(isAllowedDigits(d)).toBe(true);
        }
    });

    test('rejects real-looking numbers', () => {
        for (const d of [PHONE, PHONE_12, LID, MIXED_12, j('98765', '43210', '12345'), j('99988', '87776', '66555'), j('1658', '123456789')]) {
            expect(isAllowedDigits(d)).toBe(false);
        }
    });

    test('isSequential needs one direction only', () => {
        expect(isSequential('1234567890')).toBe(true);
        expect(isSequential('0987654321')).toBe(true);
        expect(isSequential(j('98765', '43210', '12345'))).toBe(false);
        expect(isSequential('12')).toBe(false);
    });
});

describe('phone and id rules', () => {
    test('flags an Argentine number and accepts its placeholder', () => {
        expect(ruleIds(scan(`const owner = '${PHONE}';`))).toEqual(['ar-phone']);
        expect(scan("const owner = '5490000000000';")).toEqual([]);
        expect(scan("const owner = '5490000000001';")).toEqual([]);
    });

    test('flags other long digit runs but not fractions, timestamps or hashes', () => {
        expect(ruleIds(scan(`id: ${MIXED_12}`))).toEqual(['long-number']);
        expect(scan(`r="0.${MIXED_12}"`)).toEqual([]);
        expect(scan(`t = ${j('1758', '000000000')}`)).toEqual([]);
        expect(scan(`sha = "ab${MIXED_12}cd"`)).toEqual([]);
        expect(scan(`v = ${j('12345678', '9012345678')}`)).toEqual([]); // 18 digits, out of range and sequential
    });

    test('flags WhatsApp ids once and accepts placeholders', () => {
        expect(ruleIds(scan(`to: '${PHONE}@s.whatsapp.net'`))).toEqual(['wa-jid']);
        expect(ruleIds(scan(`lid: '${LID}@lid'`))).toEqual(['wa-lid']);
        expect(ruleIds(scan(`group: '${PHONE}-1600000000@g.us'`))).toEqual(['wa-group']);
        expect(scan("to: '5490000000000@s.whatsapp.net'")).toEqual([]);
        expect(scan("lid: '100000000000001@lid'")).toEqual([]);
        expect(scan("lid: '000000000000000@lid'")).toEqual([]);
        expect(scan("group: '100000000000001@g.us'")).toEqual([]);
        expect(scan("const isLid = jid.endsWith('@lid');")).toEqual([]);
    });
});

describe('secret rules', () => {
    test('flags real-looking tokens', () => {
        const cases = [
            ['google-api-key', j('AIza', 'Sy', 'Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv')],
            ['google-oauth-token', j('ya29.', 'a1B2c3D4e5F6g7H8i9J0k1L2')],
            ['slack-token', j('xoxb-', '1029384756-abcdefghij')],
            ['github-token', j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4')],
            ['github-token', j('github_pat_', '11AAbbCCdd_EEffGGhh22IIjjKKll')],
            ['tailscale-key', j('tskey-', 'auth-k1A2b3C4d5E6f7')],
            ['slack-webhook', j('https://hooks.slack.com/services/', 'T0A1B2C3D4/B0E5F6G7H8/a1B2c3D4e5F6g7H8i9J0k1L2')],
            ['private-key', j('-----BEGIN ', 'PRIVATE KEY-----')],
            ['private-key', j('-----BEGIN RSA ', 'PRIVATE KEY-----')]
        ];
        for (const [rule, sample] of cases) {
            expect(ruleIds(scan(`x = "${sample}"`))).toEqual([rule]);
        }
    });

    test('accepts documented placeholders', () => {
        expect(scan(`KEY=${j('AIza', 'X'.repeat(35))}`)).toEqual([]);
        expect(scan('TOKEN=xoxb-XXXXXXXXXXXX')).toEqual([]);
        expect(scan('URL=https://hooks.slack.com/services/T000/B000/XXXX')).toEqual([]);
        expect(scan('Risk: keys like `AIza...`, `ghp_...`')).toEqual([]);
    });

    test('skips a line that carries the allow marker', () => {
        expect(scan(`regex: /${j('-----BEGIN ', 'PRIVATE KEY-----')}/ // pii-guard: allow`)).toEqual([]);
        expect(scan(`x = '${PHONE}' // pii-guard:allow`)).toEqual([]);
    });
});

describe('lan-address rule', () => {
    test('flags private addresses and accepts non-numeric placeholders', () => {
        expect(ruleIds(scan(`HOST=${j('10.', '1.1.5')}`))).toEqual(['lan-address']);
        expect(ruleIds(scan(`PLEX=http://${j('192.168.', '1.10')}:32400`))).toEqual(['lan-address']);
        expect(scan('PLEX=http://192.168.1.x:32400')).toEqual([]);
        expect(scan('HOST=127.0.0.1')).toEqual([]);
        expect(scan('version 10.8.1')).toEqual([]);
    });
});

describe('denylist', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-denylist-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('loads one regex per line, ignores comments and blanks, matches case-insensitively', () => {
        const file = path.join(dir, '.pii-denylist');
        fs.writeFileSync(file, '# names\nzaphod\n\nbeeblebrox\\b\n');
        const rule = loadDenylist(file);
        expect(rule.id).toBe('denylist');
        expect(rule.regexes).toHaveLength(2);
        expect(ruleIds(scanLine("name: 'Zaphod'", [...RULES, rule]))).toEqual(['denylist']);
        expect(scanLine("name: 'Alex'", [...RULES, rule])).toEqual([]);
    });

    test('returns null for a missing or empty file and throws on a bad regex', () => {
        expect(loadDenylist(path.join(dir, 'missing'))).toBeNull();
        const empty = path.join(dir, 'empty');
        fs.writeFileSync(empty, '# only a comment\n');
        expect(loadDenylist(empty)).toBeNull();
        const bad = path.join(dir, 'bad');
        fs.writeFileSync(bad, '(\n');
        expect(() => loadDenylist(bad)).toThrow(/invalid regex/);
    });
});

describe('mask', () => {
    test('hides the middle of digit runs and keeps the domain', () => {
        const out = mask(`${PHONE}@s.whatsapp.net`);
        expect(out.startsWith('549')).toBe(true);
        expect(out.endsWith('89@s.whatsapp.net')).toBe(true);
        expect(out).toContain('*');
        expect(out).not.toContain(PHONE.slice(3, 11));
    });

    test('leaves short words readable', () => {
        const pem = j('-----BEGIN ', 'PRIVATE KEY-----');
        expect(mask(pem)).toBe(pem);
        expect(mask(j('AIza', 'Sy', 'Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0Uv'))).toMatch(/^AIz\*+Uv$/);
    });
});

describe('scanText and parseDiff', () => {
    test('scanText reports file and line numbers', () => {
        const text = `ok\nconst a = '${PHONE}';\nok\nconst b = '${LID}@lid';\n`;
        const hits = scanText('src/x.js', text, RULES);
        expect(hits.map((h) => [h.file, h.line, h.rule])).toEqual([
            ['src/x.js', 2, 'ar-phone'],
            ['src/x.js', 4, 'wa-lid']
        ]);
    });

    test('parseDiff keeps added lines only, with new-file line numbers', () => {
        const diff = [
            'diff --git a/a.js b/a.js',
            '--- a/a.js',
            '+++ b/a.js',
            '@@ -1,2 +1,3 @@',
            '-old line',
            '+new line one',
            '+new line two',
            '@@ -10 +11,2 @@',
            '+later line',
            '\\ No newline at end of file',
            'diff --git a/gone.js b/gone.js',
            '--- a/gone.js',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-removed',
            'diff --git a/b.md b/b.md',
            '--- /dev/null',
            '+++ b/b.md',
            '@@ -0,0 +1 @@',
            '+fresh'
        ].join('\n');
        expect(parseDiff(diff)).toEqual([
            { file: 'a.js', line: 1, text: 'new line one' },
            { file: 'a.js', line: 2, text: 'new line two' },
            { file: 'a.js', line: 11, text: 'later line' },
            { file: 'b.md', line: 1, text: 'fresh' }
        ]);
    });
});

describe('shouldSkipPath and parseArgs', () => {
    test('skips dependencies, lockfiles and images', () => {
        for (const p of ['node_modules/x/index.js', 'apps/web/node_modules/y.js', 'package-lock.json', 'docs/hero.png', 'apps/web/public/logo.svg', 'data/agent.db', '.pii-denylist']) {
            expect(shouldSkipPath(p)).toBe(true);
        }
        for (const p of ['apps/agent/src/agent.js', 'docs/security.md', '.env.example', 'scripts/check-pii.js']) {
            expect(shouldSkipPath(p)).toBe(false);
        }
    });

    test('parses modes and rejects bad input', () => {
        expect(parseArgs(['--range', 'origin/master...HEAD', '--fix-hints'])).toMatchObject({ range: 'origin/master...HEAD', fixHints: true });
        expect(parseArgs(['--staged'])).toMatchObject({ staged: true });
        expect(() => parseArgs(['--range'])).toThrow(/--range needs a value/);
        expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    });
});

describe('command line', () => {
    const SCRIPT = path.join(__dirname, 'check-pii.js');
    let repo;

    const git = (...args) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout;
    };
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
    const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-repo-'));
        git('init', '-q');
        write('clean.js', "const owner = '5490000000000';\nconst when = 1700000000000;\n");
        git('add', '.');
        git('commit', '-qm', 'base');
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    test('tree scan passes a clean repo', () => {
        const r = run();
        expect(r.status).toBe(0);
        expect(r.stderr).toContain('pii-guard: clean');
    });

    test('tree scan reports a masked hit with hints and exits 1', () => {
        write('leak.js', `module.exports = '${PHONE}@s.whatsapp.net';\n`);
        git('add', '.');
        const r = run('--fix-hints');
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^leak\.js:1: 549\*+89@s\.whatsapp\.net  \[wa-jid\]$/m);
        expect(r.stdout).not.toContain(PHONE);
        expect(r.stdout).toContain('fix hints:');
        expect(r.stdout).toContain('wa-jid: use 5490000000000@s.whatsapp.net');
    });

    test('range scan sees only added lines', () => {
        write('clean.js', `const owner = '${PHONE}';\n`); // change an existing line
        write('note.md', `Old id ${LID} lived here.\n`);
        git('add', '.');
        git('commit', '-qm', 'leak');
        const r = run('--range', 'HEAD~1...HEAD');
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^clean\.js:1: .*\[ar-phone\]$/m);
        expect(r.stdout).toMatch(/^note\.md:1: .*\[long-number\]$/m);
        expect(run('--range', 'HEAD~1...HEAD~1').status).toBe(0);
    });

    test('staged scan checks the index and honours the denylist', () => {
        write('names.txt', 'Contact: Zaphod\n');
        git('add', '.');
        expect(run('--staged').status).toBe(0);
        write('.pii-denylist', 'zaphod\n');
        const r = run('--staged');
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/^names\.txt:1: Z\*+  \[denylist\]$/m);
        expect(r.stdout).not.toContain('Zaphod');
    });

    test('bad arguments exit 2', () => {
        expect(run('--nope').status).toBe(2);
        expect(run('--range').status).toBe(2);
    });
});
