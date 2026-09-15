#!/usr/bin/env node
'use strict';

/**
 * check-pii.js - keep personal data and secrets out of the public repo.
 *
 * Usage:
 *   node scripts/check-pii.js                              scan every text file (tracked and untracked, not ignored)
 *   node scripts/check-pii.js --range origin/master...HEAD scan added lines in a diff range
 *   node scripts/check-pii.js --staged                     scan added lines in the staged diff
 *
 * Options:
 *   --fix-hints          print a placeholder suggestion for every rule that hit
 *   --denylist <file>    extra regex list (default: .pii-denylist in the repo root)
 *   --quiet              print hits only, no summary
 *
 * What it blocks (see docs/security.md, "Personal data guard"):
 *   - Argentine phone numbers (549 + 8-10 digits) and other 11-15 digit runs
 *   - WhatsApp ids: <digits>@s.whatsapp.net, <digits>@lid, <digits>@g.us
 *   - secret-looking tokens (Google, Slack, GitHub, Tailscale, private keys)
 *   - private LAN addresses (10.x.x.x, 192.168.x.x)
 *   - anything matching the owner's local .pii-denylist (gitignored)
 *
 * Allowed placeholders: digit runs with fewer than 4 distinct digits
 * (5490000000000, 100000000000001), 549 + a near-constant tail
 * (5490000000001), monotone sequences (1234567890), epoch milliseconds
 * (17xxxxxxxxxxx, 18xxxxxxxxxxx) and the fictional US 555 range (15551234567). A line that carries the marker
 * "pii-guard: allow" is skipped; use it only for pattern definitions and
 * test fixtures.
 *
 * Exit codes: 0 clean, 1 hits found, 2 usage or git error. No dependencies.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ALLOW_MARKER = /pii-guard:\s*allow/i;
const EPOCH_MS = /^1[78]\d{11}$/;
const FICTIONAL_555 = /^1?555\d{4,7}$/;

const SKIP_PATH = /(^|\/)node_modules\//;
const SKIP_FILE = /(^|\/)(package-lock\.json|\.pii-denylist)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|7z|mp3|mp4|m4a|ogg|wav|webm|mov|db|sqlite3?|bin|wasm|pyc|so|dylib|exe|dll|jar|class|node)$/i;

function distinctChars(s) {
    return new Set(s).size;
}

/** True for 1234567890-style runs: every step is +1 or every step is -1 (mod 10). */
function isSequential(digits) {
    if (digits.length < 3) return false;
    const step = (Number(digits[1]) - Number(digits[0]) + 10) % 10;
    if (step !== 1 && step !== 9) return false;
    for (let i = 1; i < digits.length; i++) {
        if ((Number(digits[i]) - Number(digits[i - 1]) + 10) % 10 !== step) return false;
    }
    return true;
}

/** True when a digit run is an obvious placeholder, a timestamp or a fictional number. */
function isAllowedDigits(digits) {
    if (!digits) return true;
    if (isSequential(digits)) return true;
    if (distinctChars(digits) < 4) return true;
    if (digits.startsWith('549') && distinctChars(digits.slice(3)) < 3) return true;
    if (EPOCH_MS.test(digits)) return true;
    if (FICTIONAL_555.test(digits)) return true;
    return false;
}

/** True when a token body looks like a placeholder (XXXX, 0000, ...). */
function isPlaceholderToken(body) {
    return distinctChars(body) < 4;
}

const allDigitGroupsAllowed = (m) => m.match(/\d+/g).every(isAllowedDigits);

const RULES = [
    {
        id: 'ar-phone',
        regex: /\b549\d{8,10}\b/g,
        allow: (m) => isAllowedDigits(m),
        hint: 'use 5490000000000 (5490000000001, 5490000000002 ... when tests need distinct contacts)'
    },
    {
        id: 'long-number',
        regex: /(?<![\w.])\d{11,15}(?![\w.])/g,
        allow: (m) => isAllowedDigits(m),
        hint: 'use a zero-heavy placeholder such as 10000000000 or 100000000000001; for timestamps use 1700000000000'
    },
    {
        id: 'wa-jid',
        regex: /\b\d{7,}@s\.whatsapp\.net\b/g,
        allow: allDigitGroupsAllowed,
        hint: 'use 5490000000000@s.whatsapp.net'
    },
    {
        id: 'wa-lid',
        regex: /\b\d{7,}@lid\b/g,
        allow: allDigitGroupsAllowed,
        hint: 'use 100000000000001@lid'
    },
    {
        id: 'wa-group',
        regex: /\b\d{7,}(?:-\d+)?@g\.us\b/g,
        allow: allDigitGroupsAllowed,
        hint: 'use 100000000000001@g.us'
    },
    {
        id: 'google-api-key',
        regex: /AIza[0-9A-Za-z_-]{30,}/g,
        allow: (m) => isPlaceholderToken(m.slice(4)),
        hint: 'never commit keys; in examples write AIza followed by X characters'
    },
    {
        id: 'google-oauth-token',
        regex: /ya29\.[0-9A-Za-z_-]{20,}/g,
        allow: (m) => isPlaceholderToken(m.slice(5)),
        hint: 'never commit tokens; in examples write ya29.XXXX'
    },
    {
        id: 'slack-token',
        regex: /xox[abp]-[0-9A-Za-z-]{10,}/g,
        allow: (m) => isPlaceholderToken(m.slice(5)),
        hint: 'never commit tokens; in examples write xoxb-XXXX'
    },
    {
        id: 'github-token',
        regex: /\b(?:github_pat_[0-9A-Za-z_]{20,}|ghp_[0-9A-Za-z]{20,})/g,
        allow: (m) => isPlaceholderToken(m.replace(/^(github_pat_|ghp_)/, '')),
        hint: 'never commit tokens; in examples write ghp_XXXX'
    },
    {
        id: 'tailscale-key',
        regex: /tskey-[0-9A-Za-z-]{10,}/g,
        allow: (m) => isPlaceholderToken(m.slice(6)),
        hint: 'never commit keys; in examples write tskey-XXXX'
    },
    {
        id: 'slack-webhook',
        regex: /hooks\.slack\.com\/services\/T[0-9A-Za-z]{6,}\/B[0-9A-Za-z]{6,}\/[0-9A-Za-z]{16,}/g,
        allow: (m) => isPlaceholderToken(m.split('/').pop()),
        hint: 'use https://hooks.slack.com/services/T000/B000/XXXX'
    },
    {
        id: 'private-key',
        regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g,
        allow: () => false,
        hint: 'never commit private keys; load them from the environment or a mounted file'
    },
    {
        id: 'lan-address',
        regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
        allow: () => false,
        hint: 'use a non-numeric placeholder such as 192.168.1.x or a hostname like example.local'
    }
];

/** Hide the middle of every long alphanumeric run so the report itself leaks nothing. */
function mask(text) {
    return text.replace(/[0-9A-Za-z_-]{6,}/g, (run) => {
        if (!/\d/.test(run) && run.length < 12) return run;
        return run.slice(0, 3) + '*'.repeat(run.length - 5) + run.slice(-2);
    });
}

function shouldSkipPath(file) {
    return SKIP_PATH.test(file) || SKIP_FILE.test(file) || BINARY_EXT.test(file);
}

function looksBinary(buffer) {
    return buffer.subarray(0, 8000).includes(0);
}

/** Read the denylist. Returns a rule or null. Throws on an invalid regex. */
function loadDenylist(file) {
    if (!file || !fs.existsSync(file)) return null;
    const patterns = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    if (patterns.length === 0) return null;
    const regexes = patterns.map((p) => {
        try {
            return new RegExp(p, 'gi');
        } catch (e) {
            throw new Error(`invalid regex in ${file}: ${p} (${e.message})`);
        }
    });
    return {
        id: 'denylist',
        regexes,
        hint: 'remove the name or value; use a neutral placeholder such as "Alex" or "example"'
    };
}

/** Return hits for one line: [{ rule, match, start, end }], deduped by containment. */
function scanLine(line, rules) {
    if (ALLOW_MARKER.test(line)) return [];
    const hits = [];
    for (const rule of rules) {
        const regexes = rule.regexes || [rule.regex];
        for (const regex of regexes) {
            regex.lastIndex = 0;
            for (const m of line.matchAll(regex)) {
                if (rule.allow && rule.allow(m[0])) continue;
                hits.push({ rule: rule.id, match: m[0], start: m.index, end: m.index + m[0].length });
            }
        }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const h of hits) {
        const inside = kept.some((k) => h.start >= k.start && h.end <= k.end);
        if (!inside) kept.push(h);
    }
    return kept;
}

/** Scan a whole text; returns [{ file, line, rule, match }]. */
function scanText(file, text, rules) {
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const h of scanLine(lines[i], rules)) {
            out.push({ file, line: i + 1, rule: h.rule, match: h.match });
        }
    }
    return out;
}

/**
 * Parse a unified diff (git diff -U0) into added lines only.
 * Returns [{ file, line, text }].
 */
function parseDiff(diff) {
    const out = [];
    let file = null;
    let lineNo = 0;
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('+++ ')) {
            const target = raw.slice(4).trim();
            file = target === '/dev/null' ? null : target.replace(/^b\//, '');
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('diff --git ') || raw.startsWith('\\ ')) continue;
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            lineNo = Number(hunk[1]);
            continue;
        }
        if (!file) continue;
        if (raw.startsWith('+')) {
            out.push({ file, line: lineNo, text: raw.slice(1) });
            lineNo++;
        } else if (raw.startsWith(' ')) {
            lineNo++;
        }
    }
    return out;
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function scanTree(root, rules) {
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter(Boolean);
    const hits = [];
    let scanned = 0;
    for (const file of files) {
        if (shouldSkipPath(file)) continue;
        let buf;
        try {
            buf = fs.readFileSync(path.join(root, file));
        } catch {
            continue; // deleted in the working tree
        }
        if (looksBinary(buf)) continue;
        scanned++;
        hits.push(...scanText(file, buf.toString('utf8'), rules));
    }
    return { hits, scanned };
}

function scanDiff(root, rules, diffArgs) {
    const diff = git(['diff', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR', ...diffArgs], root);
    const added = parseDiff(diff);
    const files = new Set();
    const hits = [];
    for (const { file, line, text } of added) {
        if (shouldSkipPath(file)) continue;
        files.add(file);
        for (const h of scanLine(text, rules)) {
            hits.push({ file, line, rule: h.rule, match: h.match });
        }
    }
    return { hits, scanned: files.size };
}

function parseArgs(argv) {
    const opts = { range: null, staged: false, fixHints: false, quiet: false, denylist: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--range') opts.range = argv[++i];
        else if (a === '--staged' || a === '--cached') opts.staged = true;
        else if (a === '--fix-hints') opts.fixHints = true;
        else if (a === '--quiet') opts.quiet = true;
        else if (a === '--denylist') opts.denylist = argv[++i];
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    if (opts.range !== null && !opts.range) throw new Error('--range needs a value, e.g. origin/master...HEAD');
    return opts;
}

function usage() {
    return [
        'usage: node scripts/check-pii.js [--range <a>...<b> | --staged] [--fix-hints] [--denylist <file>] [--quiet]',
        '  no mode      scan every text file (tracked and untracked, not ignored)',
        '  --range      scan added lines in `git diff <range>`',
        '  --staged     scan added lines in `git diff --cached`'
    ].join('\n');
}

function main(argv, io = { log: console.log, error: console.error }) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        io.error(`pii-guard: ${e.message}\n${usage()}`);
        return 2;
    }
    if (opts.help) {
        io.log(usage());
        return 0;
    }

    let root;
    try {
        root = git(['rev-parse', '--show-toplevel']).trim();
    } catch {
        io.error('pii-guard: not inside a git repository');
        return 2;
    }

    const rules = [...RULES];
    try {
        const denylist = loadDenylist(opts.denylist || path.join(root, '.pii-denylist'));
        if (denylist) rules.push(denylist);
    } catch (e) {
        io.error(`pii-guard: ${e.message}`);
        return 2;
    }

    let result;
    let mode;
    try {
        if (opts.range) {
            mode = `range ${opts.range}`;
            result = scanDiff(root, rules, [opts.range]);
        } else if (opts.staged) {
            mode = 'staged changes';
            result = scanDiff(root, rules, ['--cached']);
        } else {
            mode = 'working tree';
            result = scanTree(root, rules);
        }
    } catch (e) {
        io.error(`pii-guard: git failed: ${e.message.split('\n')[0]}`);
        return 2;
    }

    for (const h of result.hits) {
        const shown = h.rule === 'denylist'
            ? h.match[0] + '*'.repeat(Math.max(3, h.match.length - 1))
            : mask(h.match);
        io.log(`${h.file}:${h.line}: ${shown}  [${h.rule}]`);
    }

    if (opts.fixHints && result.hits.length) {
        const seen = new Set(result.hits.map((h) => h.rule));
        io.log('');
        io.log('fix hints:');
        for (const rule of rules) {
            if (seen.has(rule.id)) io.log(`  ${rule.id}: ${rule.hint}`);
        }
        io.log('  A line may carry "pii-guard: allow" only for pattern definitions and synthetic fixtures.');
    }

    if (!opts.quiet) {
        const files = new Set(result.hits.map((h) => h.file)).size;
        const summary = result.hits.length
            ? `pii-guard: ${result.hits.length} hit(s) in ${files} file(s)`
            : 'pii-guard: clean';
        io.error(`${summary} (${mode}, ${result.scanned} file(s) scanned)`);
    }
    return result.hits.length ? 1 : 0;
}

module.exports = {
    RULES,
    ALLOW_MARKER,
    isAllowedDigits,
    isSequential,
    isPlaceholderToken,
    mask,
    shouldSkipPath,
    loadDenylist,
    scanLine,
    scanText,
    parseDiff,
    parseArgs,
    main
};

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
