#!/usr/bin/env node
/**
 * Token usage report: cost and prompt size by day, model and tag, plus how
 * often the cacheable prompt prefix moved between turns.
 *
 * Run inside the agent container (from /app/apps/agent or the repo root):
 *   node scripts/usage-report.js [--days 7] [--db /app/data/agent.db] [--json]
 *
 * Reads the database read-only. Tags on the main chat path are chat, job,
 * subagent and watcher (with a _tool_loop suffix on the calls that follow
 * tool results); other tags name their call site (title, router, tts, ...).
 * NULL tags are rows written before the attribution change.
 *
 * The prefix_hash metric is written once per turn with value 1 when the
 * system instruction or the declared tool names differ from the chat's
 * previous turn. After a session's first turn it should stay at 0.
 */
const fs = require('fs');
const path = require('path');

const Database = require('better-sqlite3');

function parseArgs(argv) {
    const opts = { days: 7, db: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--days') opts.days = parseInt(argv[++i], 10);
        else if (a === '--db') opts.db = argv[++i];
        else if (a === '--json') opts.json = true;
        else if (a === '--help' || a === '-h') { opts.help = true; }
        else { console.error(`Unknown argument: ${a}`); process.exit(2); }
    }
    if (!Number.isInteger(opts.days) || opts.days < 1) { console.error('--days must be a positive integer'); process.exit(2); }
    return opts;
}

function resolveDbPath(explicit) {
    if (explicit) return explicit;
    const dataDir = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.join(process.cwd(), 'data'));
    return path.join(dataDir, 'agent.db');
}

const DAILY_SQL = `
SELECT date(timestamp) d, model, tag, COUNT(*) n,
       AVG(prompt_tokens) p, SUM(cached_tokens)*1.0/SUM(prompt_tokens) cached_ratio,
       AVG(thoughts_tokens) thoughts, SUM(estimated_cost) usd
FROM token_usage WHERE timestamp > date('now', ?) GROUP BY 1,2,3 ORDER BY usd DESC`;

const COMPOSITION_SQL = `
SELECT tag, model, COUNT(*) n, AVG(prompt_tokens) p,
       AVG(sys_tokens_est) sys_est, AVG(tools_tokens_est) tools_est, AVG(history_tokens_est) history_est, AVG(decl_count) decls
FROM token_usage WHERE timestamp > date('now', ?) AND sys_tokens_est IS NOT NULL
GROUP BY 1,2 ORDER BY n DESC`;

const PREFIX_SQL = `
SELECT date(timestamp) d, COUNT(*) turns, SUM(value) changed
FROM metrics WHERE type = 'prefix_hash' AND timestamp > date('now', ?) GROUP BY 1 ORDER BY 1`;

function fmt(v, digits = 0) {
    if (v === null || v === undefined) return '-';
    if (typeof v !== 'number') return String(v);
    return digits ? v.toFixed(digits) : String(Math.round(v));
}

function table(rows, columns) {
    if (!rows.length) { console.log('  (no rows)'); return; }
    const cells = rows.map(r => columns.map(c => c.fmt ? c.fmt(r[c.key]) : fmt(r[c.key], c.digits)));
    const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map(row => row[i].length)));
    const line = (vals) => '  ' + vals.map((v, i) => (columns[i].left ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ');
    console.log(line(columns.map(c => c.label)));
    console.log(line(widths.map(w => '-'.repeat(w))));
    for (const row of cells) console.log(line(row));
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('node scripts/usage-report.js [--days 7] [--db /app/data/agent.db] [--json]');
        return;
    }
    const dbPath = resolveDbPath(opts.db);
    if (!fs.existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const since = `-${opts.days} day`;

    const daily = db.prepare(DAILY_SQL).all(since);
    const composition = db.prepare(COMPOSITION_SQL).all(since);
    const prefix = db.prepare(PREFIX_SQL).all(since);
    const untagged = db.prepare(`SELECT COUNT(*) n FROM token_usage WHERE timestamp > date('now', ?) AND tag IS NULL`).get(since).n;
    const totalUsd = daily.reduce((s, r) => s + (r.usd || 0), 0);
    const prefixChanges = prefix.reduce((s, r) => s + (r.changed || 0), 0);
    const prefixTurns = prefix.reduce((s, r) => s + (r.turns || 0), 0);
    db.close();

    if (opts.json) {
        console.log(JSON.stringify({ dbPath, days: opts.days, totalUsd, untagged, prefixTurns, prefixChanges, daily, composition, prefix }, null, 2));
        return;
    }

    console.log(`Token usage for the last ${opts.days} day(s) from ${dbPath}`);
    console.log(`Total estimated cost: $${totalUsd.toFixed(4)}; untagged rows: ${untagged}\n`);

    console.log('By day, model and tag (most expensive first):');
    table(daily, [
        { key: 'd', label: 'day', left: true },
        { key: 'model', label: 'model', left: true },
        { key: 'tag', label: 'tag', left: true, fmt: v => v || '(null)' },
        { key: 'n', label: 'calls' },
        { key: 'p', label: 'avg prompt' },
        { key: 'cached_ratio', label: 'cached', fmt: v => (v === null || v === undefined ? '-' : (v * 100).toFixed(1) + '%') },
        { key: 'thoughts', label: 'avg thoughts' },
        { key: 'usd', label: 'usd', digits: 4 }
    ]);

    console.log('\nPrompt composition estimates (rows from the main chat path only; JSON length / 4):');
    table(composition, [
        { key: 'tag', label: 'tag', left: true },
        { key: 'model', label: 'model', left: true },
        { key: 'n', label: 'calls' },
        { key: 'p', label: 'avg prompt' },
        { key: 'sys_est', label: 'sys est' },
        { key: 'tools_est', label: 'tools est' },
        { key: 'history_est', label: 'history est' },
        { key: 'decls', label: 'decls' }
    ]);

    console.log(`\nPrefix hash changes: ${prefixChanges} of ${prefixTurns} turn(s)`);
    table(prefix, [
        { key: 'd', label: 'day', left: true },
        { key: 'turns', label: 'turns' },
        { key: 'changed', label: 'changed' }
    ]);
}

if (require.main === module) main();

module.exports = { DAILY_SQL, COMPOSITION_SQL, PREFIX_SQL, parseArgs, resolveDbPath };
