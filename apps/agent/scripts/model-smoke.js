#!/usr/bin/env node
/**
 * Model smoke check: one real call per model role, the same ids the agent uses.
 *
 * Run inside the agent container (from /app/apps/agent or the repo root):
 *   node scripts/model-smoke.js [--with-image] [--only LITE,FLASH] [--skip LIVE]
 *                               [--checks get,text] [--timeout 60000] [--max-tokens 20] [--json]
 *
 * Per role:              ROUTER LITE FLASH SEARCH PRO | TTS | IMAGE | EMBEDDING | LIVE
 *   get       models.get   x      x    x     x     x     x     x       x          x
 *   text      20-token reply at the lowest thinking level the model supports
 *   tools     getTime function call -> functionResponse -> text
 *   thinking  role's thinking level (ROUTER/LITE MINIMAL, FLASH/SEARCH LOW, PRO HIGH); prints thoughtsTokenCount
 *   tts       responseModalities AUDIO -> inlineData audio/*
 *   image     responseModalities TEXT+IMAGE -> inlineData image/* (needs --with-image, costs ~$0.07)
 *   embed     embedContent -> values.length === EMBEDDING_DIMENSIONS
 *   live      authTokens.create with liveConnectConstraints -> token name auth_tokens/...
 *
 * Roles that share a model id share the call, so nothing is paid for twice.
 * Exit code: 0 all ok, 1 any failure, 2 bad arguments. Needs GOOGLE_API_KEY.
 * Nothing here writes to token_usage; the cost column is an estimate from
 * ConfigService pricing. See docs/models.md.
 *
 * Every run also writes DATA_DIR/model-smoke.json (one row per role, with its
 * status, time and first error). GET /internal/models reads that file, so the
 * Models tab in the web app can show when each role last answered.
 * MODEL_SMOKE_WRITE=0 turns the write off.
 */
const fs = require('fs');
const path = require('path');

const AGENT_ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(AGENT_ROOT, '..', '..', '.env') }); } catch (e) { /* optional */ }
try { require('dotenv').config(); } catch (e) { /* optional */ }

const { ConfigService } = require(path.join(AGENT_ROOT, 'src', 'services', 'config-service'));

const ROLE_ORDER = ['ROUTER', 'LITE', 'FLASH', 'SEARCH', 'PRO', 'TTS', 'IMAGE', 'EMBEDDING', 'LIVE'];
const TEXT_ROLES = ['ROUTER', 'LITE', 'FLASH', 'SEARCH', 'PRO'];
const CHECKS = ['get', 'text', 'tools', 'thinking', 'tts', 'image', 'embed', 'live'];

// Per-role levels for the live check only. Runtime levels per call class live
// in ConfigService.getThinking (docs/models.md, "Thinking levels").
const THINKING_LEVELS = { ROUTER: 'MINIMAL', LITE: 'MINIMAL', FLASH: 'LOW', SEARCH: 'LOW', PRO: 'HIGH' };

// Output budget for the text check when the model cannot think at MINIMAL.
const TEXT_THINKING_BUDGET = 1024;

const DEFAULTS = { withImage: false, only: null, skip: [], checks: null, timeout: 60000, maxTokens: 20, json: false, help: false };

const HELP = `Usage: node scripts/model-smoke.js [options]
  --with-image        run the image generation check (costs money)
  --only ROLES        comma list of roles to run (${ROLE_ORDER.join(',')})
  --skip ROLES        comma list of roles to skip
  --checks CHECKS     comma list of checks to run (${CHECKS.join(',')})
  --timeout MS        per-call timeout, default ${DEFAULTS.timeout}
  --max-tokens N      maxOutputTokens for the text check, default ${DEFAULTS.maxTokens}
  --json              print rows as JSON instead of a table
  --help              this text`;

function parseArgs(argv) {
    const opts = { ...DEFAULTS, skip: [] };
    const roles = (v, flag) => {
        const list = String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        for (const r of list) if (!ROLE_ORDER.includes(r)) throw new Error(`${flag}: unknown role ${r}`);
        if (list.length === 0) throw new Error(`${flag} needs a value`);
        return list;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
        switch (a) {
            case '--with-image': opts.withImage = true; break;
            case '--json': opts.json = true; break;
            case '--help': case '-h': opts.help = true; break;
            case '--only': opts.only = roles(next(), a); break;
            case '--skip': opts.skip = roles(next(), a); break;
            case '--checks': {
                const list = String(next()).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                for (const c of list) if (!CHECKS.includes(c)) throw new Error(`--checks: unknown check ${c}`);
                if (list.length === 0) throw new Error('--checks needs a value');
                opts.checks = list;
                break;
            }
            case '--timeout': {
                opts.timeout = parseInt(next(), 10);
                if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout must be a positive number');
                break;
            }
            case '--max-tokens': {
                opts.maxTokens = parseInt(next(), 10);
                if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) throw new Error('--max-tokens must be a positive number');
                break;
            }
            default: throw new Error(`unknown option ${a} (see --help)`);
        }
    }
    return opts;
}

function checksForRole(role) {
    if (TEXT_ROLES.includes(role)) return ['get', 'text', 'tools', 'thinking'];
    if (role === 'TTS') return ['get', 'tts'];
    if (role === 'IMAGE') return ['get', 'image'];
    if (role === 'EMBEDDING') return ['get', 'embed'];
    if (role === 'LIVE') return ['get', 'live'];
    return ['get'];
}

/**
 * @param {Record<string,string>} models role -> model id
 * @returns {Array<{role:string, model:string, check:string, skip?:string}>}
 */
function buildPlan(models, opts = DEFAULTS) {
    const plan = [];
    for (const role of ROLE_ORDER) {
        if (opts.only && !opts.only.includes(role)) continue;
        if (opts.skip && opts.skip.includes(role)) continue;
        const model = models[role];
        if (!model) continue;
        for (const check of checksForRole(role)) {
            if (opts.checks && !opts.checks.includes(check)) continue;
            const item = { role, model, check };
            if (check === 'image' && !opts.withImage) item.skip = 'pass --with-image to run';
            plan.push(item);
        }
    }
    return plan;
}

function supportsThinkingLevel(model) {
    return /^gemini-3/.test(model);
}

// Cheapest level a model accepts: 3.7/3.8 flash and Pro have no MINIMAL.
function lowestThinkingLevel(model) {
    if (/pro/.test(model) || /^gemini-3\.[78]-flash/.test(model)) return 'LOW';
    return 'MINIMAL';
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function usageOf(result) {
    const m = result?.usageMetadata || {};
    return {
        prompt: m.promptTokenCount || 0,
        candidates: m.candidatesTokenCount || 0,
        thoughts: m.thoughtsTokenCount || 0,
        cached: m.cachedContentTokenCount || 0,
        total: m.totalTokenCount || ((m.promptTokenCount || 0) + (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0))
    };
}

function textOf(result) {
    if (typeof result?.text === 'string') return result.text;
    const parts = result?.candidates?.[0]?.content?.parts || [];
    return parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
}

function inlinePart(result, mimePrefix) {
    const parts = result?.candidates?.[0]?.content?.parts || [];
    return parts.find(p => p.inlineData && String(p.inlineData.mimeType || '').startsWith(mimePrefix));
}

function thinkingConfig(model, level) {
    return supportsThinkingLevel(model) ? { thinkingConfig: { thinkingLevel: level } } : {};
}

const RUNNERS = {
    async get({ client, model }) {
        const info = await client.models.get({ model });
        const name = info?.name || '';
        if (!name.includes(model)) throw new Error(`models.get returned ${name || 'no name'}`);
        return { note: [info.displayName, info.version].filter(Boolean).join(' ') };
    },

    async text({ client, model, opts }) {
        // Thinking tokens count against maxOutputTokens on Gemini 3.x. Models whose
        // lowest level is above MINIMAL (Pro) need room to think before they answer,
        // or they hit MAX_TOKENS with an empty reply.
        const level = lowestThinkingLevel(model);
        const maxOutputTokens = level && level !== 'MINIMAL' ? Math.max(opts.maxTokens, TEXT_THINKING_BUDGET) : opts.maxTokens;
        const result = await client.models.generateContent({
            model,
            contents: 'Reply with the single word OK.',
            config: { maxOutputTokens, ...thinkingConfig(model, level) }
        });
        const text = textOf(result).trim();
        const usage = usageOf(result);
        if (!text) {
            const reason = result?.candidates?.[0]?.finishReason || 'unknown';
            throw new Error(`empty text (finishReason ${reason}; try --max-tokens)`);
        }
        return { usage, note: JSON.stringify(text.slice(0, 20)) };
    },

    async tools({ client, model }) {
        const tools = [{
            functionDeclarations: [{
                name: 'getTime',
                description: 'Returns the current UTC time as an ISO 8601 string.',
                parameters: { type: 'OBJECT', properties: {} }
            }]
        }];
        const userTurn = { role: 'user', parts: [{ text: 'What time is it right now? Call getTime to find out.' }] };
        const first = await client.models.generateContent({ model, contents: [userTurn], config: { tools } });
        const call = (first.functionCalls || first?.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall) || [])[0];
        if (!call || call.name !== 'getTime') throw new Error(`no getTime call (got ${call ? call.name : textOf(first).slice(0, 40) || 'nothing'})`);

        // Send the model turn back whole so thought signatures round-trip.
        const modelTurn = first.candidates[0].content;
        const second = await client.models.generateContent({
            model,
            contents: [
                userTurn,
                modelTurn,
                { role: 'user', parts: [{ functionResponse: { name: 'getTime', response: { time: new Date().toISOString() } } }] }
            ],
            config: { tools }
        });
        const text = textOf(second).trim();
        if (!text) throw new Error('no text after functionResponse');
        const u1 = usageOf(first); const u2 = usageOf(second);
        const usage = {
            prompt: u1.prompt + u2.prompt, candidates: u1.candidates + u2.candidates,
            thoughts: u1.thoughts + u2.thoughts, cached: u1.cached + u2.cached, total: u1.total + u2.total
        };
        return { usage, note: JSON.stringify(text.slice(0, 20)) };
    },

    async thinking({ client, model, role }) {
        if (!supportsThinkingLevel(model)) return { skip: 'thinkingLevel needs a gemini-3.x id' };
        const level = THINKING_LEVELS[role] || 'LOW';
        const result = await client.models.generateContent({
            model,
            contents: 'In one short sentence: why is the sky blue?',
            config: { thinkingConfig: { thinkingLevel: level } }
        });
        const text = textOf(result).trim();
        if (!text) throw new Error(`empty text at ${level}`);
        const usage = usageOf(result);
        return { usage, note: `${level}: thoughts=${usage.thoughts}` };
    },

    async tts({ client, model }) {
        const result = await client.models.generateContent({
            model,
            contents: [{ parts: [{ text: 'Please read the following text aloud. Text: "Smoke test."' }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
        });
        const part = inlinePart(result, 'audio/');
        if (!part) throw new Error('no inlineData audio/* part');
        return { usage: usageOf(result), note: `${part.inlineData.mimeType} ${Math.round((part.inlineData.data || '').length * 3 / 4 / 1024)} KB` };
    },

    async image({ client, model }) {
        const result = await client.models.generateContent({
            model,
            contents: 'A plain red circle on a white background.',
            config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        const part = inlinePart(result, 'image/');
        if (!part) throw new Error('no inlineData image/* part');
        return { usage: usageOf(result), imageTokens: imageTokensOf(result), note: `${part.inlineData.mimeType} ${Math.round((part.inlineData.data || '').length * 3 / 4 / 1024)} KB` };
    },

    async embed({ client, model }) {
        const dims = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;
        const config = { taskType: 'RETRIEVAL_QUERY' };
        if (dims !== 3072) config.outputDimensionality = dims;
        const result = await client.models.embedContent({ model, contents: [{ parts: [{ text: 'smoke test' }] }], config });
        const values = result?.embeddings?.[0]?.values || result?.embedding?.values;
        if (!Array.isArray(values)) throw new Error('no embedding values');
        if (values.length !== dims) throw new Error(`got ${values.length} dims, EMBEDDING_DIMENSIONS=${dims}`);
        return { usage: usageOf(result), note: `${values.length} dims` };
    },

    async live({ client, model }) {
        if (!client.authTokens?.create) throw new Error('client.authTokens.create missing (SDK too old?)');
        const token = await client.authTokens.create({
            config: {
                uses: 1,
                liveConnectConstraints: { model, config: { responseModalities: ['AUDIO'] } },
                httpOptions: { apiVersion: 'v1alpha' }
            }
        });
        const name = token?.name || '';
        if (!name.startsWith('auth_tokens/')) throw new Error(`token name ${JSON.stringify(name)} does not start with auth_tokens/`);
        return { note: `token ${name.slice(0, 20)}...` };
    }
};

function imageTokensOf(result) {
    const details = result?.usageMetadata?.candidatesTokensDetails;
    if (!Array.isArray(details)) return null;
    return details.filter(d => String(d.modality || '').toUpperCase() === 'IMAGE').reduce((s, d) => s + (d.tokenCount || 0), 0);
}

/**
 * Run the plan against a GoogleGenAI-compatible client.
 * @returns {Promise<{rows: Array, exitCode: number, ok: number, failed: number, skipped: number, cost: number}>}
 */
async function runSmoke(client, plan, opts = DEFAULTS, config = new ConfigService()) {
    const memo = new Map();
    const rows = [];
    for (const item of plan) {
        const { role, model, check } = item;
        const key = `${check}|${model}|${THINKING_LEVELS[role] || ''}`;
        let row;
        if (item.skip) {
            row = { role, model, check, status: 'skip', ms: 0, tokens: 0, thoughts: 0, cost: 0, note: item.skip };
        } else if (memo.has(key)) {
            const shared = memo.get(key);
            row = { ...shared, role, cost: 0, tokens: 0, thoughts: shared.thoughts, note: `same as ${shared.role}${shared.note ? `: ${shared.note}` : ''}` };
        } else {
            const started = Date.now();
            try {
                const out = await withTimeout(RUNNERS[check]({ client, model, role, opts }), opts.timeout, `${role} ${check}`);
                const ms = Date.now() - started;
                if (out.skip) {
                    row = { role, model, check, status: 'skip', ms, tokens: 0, thoughts: 0, cost: 0, note: out.skip };
                } else {
                    const u = out.usage || { prompt: 0, candidates: 0, thoughts: 0, cached: 0, total: 0 };
                    const cost = out.usage ? config.calculateCost(model, u.prompt, u.candidates, u.cached, u.thoughts, out.imageTokens ?? null) : 0;
                    row = { role, model, check, status: 'ok', ms, tokens: u.total, thoughts: u.thoughts, cost, note: out.note || '' };
                }
            } catch (e) {
                row = { role, model, check, status: 'fail', ms: Date.now() - started, tokens: 0, thoughts: 0, cost: 0, note: (e && e.message) || String(e) };
            }
            if (row.status !== 'skip') memo.set(key, row);
        }
        rows.push(row);
    }
    const ok = rows.filter(r => r.status === 'ok').length;
    const failed = rows.filter(r => r.status === 'fail').length;
    const skipped = rows.filter(r => r.status === 'skip').length;
    const cost = rows.reduce((s, r) => s + (r.cost || 0), 0);
    return { rows, ok, failed, skipped, cost, exitCode: failed > 0 ? 1 : 0 };
}

/** Where the last run is kept. Same folder as agent.db on the device. */
function resultPath(dataDir = process.env.DATA_DIR || path.join(AGENT_ROOT, 'data')) {
    return path.join(dataDir, 'model-smoke.json');
}

/**
 * One row per role, from the per-check rows. A role fails when any of its
 * checks fails; it is skipped only when every check was skipped.
 * @param {Array} rows
 * @returns {Array<{role:string, model:string, status:string, ms:number, error:string|null, checks:Array}>}
 */
function summarizeByRole(rows = []) {
    const byRole = new Map();
    for (const row of rows) {
        if (!byRole.has(row.role)) byRole.set(row.role, { role: row.role, model: row.model, status: 'skip', ms: 0, error: null, checks: [] });
        const role = byRole.get(row.role);
        role.checks.push({ check: row.check, status: row.status, ms: row.ms || 0, note: row.note || '' });
        role.ms += row.ms || 0;
        if (row.status === 'fail') {
            role.status = 'fail';
            if (!role.error) role.error = row.note || `${row.check} failed`;
        } else if (row.status === 'ok' && role.status !== 'fail') {
            role.status = 'ok';
        }
    }
    return [...byRole.values()];
}

/**
 * Write the last run so the web app can show it. A failed write only warns:
 * the smoke check itself must still report its own result.
 * @returns {string|null} the file written, or null
 */
/**
 * An error text from the SDK may quote a request URL or a key. The file lands
 * in DATA_DIR, which the backup zips, and the Models page shows the text: no
 * key may sit in either.
 */
function scrubSecrets(text) {
    return String(text)
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
        .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[redacted]')
        .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/g, '$1[redacted]');
}

function writeResult(result, models, dataDir, out = console) {
    if (process.env.MODEL_SMOKE_WRITE === '0') return null;
    const file = resultPath(dataDir);
    const payload = {
        at: new Date().toISOString(),
        ok: result.ok, failed: result.failed, skipped: result.skipped, cost: result.cost,
        roles: summarizeByRole(result.rows).map(r => ({ ...r, model: models[r.role] || r.model }))
    };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, scrubSecrets(JSON.stringify(payload, null, 2)));
        return file;
    } catch (e) {
        out.error(`model-smoke: could not write ${file}: ${e.message}`);
        return null;
    }
}

function formatTable(rows) {
    const cols = [
        ['Role', r => r.role], ['Model', r => r.model], ['Check', r => r.check],
        ['Result', r => r.status.toUpperCase()], ['ms', r => String(r.ms)],
        ['Tokens', r => String(r.tokens || 0)], ['Thoughts', r => String(r.thoughts || 0)],
        ['Est $', r => (r.cost || 0).toFixed(5)], ['Note', r => r.note || '']
    ];
    const cells = rows.map(r => cols.map(([, f]) => f(r)));
    const widths = cols.map(([h], i) => Math.max(h.length, ...cells.map(c => c[i].length)));
    const line = (c) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
    return [line(cols.map(([h]) => h)), line(widths.map(w => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

async function createClient() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI({ apiKey });
}

async function main(argv = process.argv.slice(2), out = console) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        out.error(`model-smoke: ${e.message}`);
        out.error(HELP);
        return 2;
    }
    if (opts.help) { out.log(HELP); return 0; }

    const config = new ConfigService();
    const models = config.get('MODELS');
    const envVars = config.get('MODEL_ENV_VARS') || {};
    const plan = buildPlan(models, opts);
    if (plan.length === 0) { out.error('model-smoke: nothing to run'); return 2; }

    if (!opts.json) {
        out.log('Model roles (env override in parentheses):');
        for (const role of ROLE_ORDER) {
            if (!models[role]) continue;
            const src = process.env[envVars[role]] ? 'env' : 'default';
            out.log(`  ${role.padEnd(9)} ${models[role]}  (${envVars[role] || '-'}, ${src})`);
        }
        out.log(`  EMBEDDING_DIMENSIONS=${process.env.EMBEDDING_DIMENSIONS || '768 (default)'}\n`);
    }

    let client;
    try {
        client = await createClient();
    } catch (e) {
        out.error(`model-smoke: ${e.message}`);
        return 2;
    }

    const result = await runSmoke(client, plan, opts, config);
    writeResult(result, models, undefined, out);
    if (opts.json) {
        out.log(JSON.stringify({ ...result, models }, null, 2));
    } else {
        out.log(formatTable(result.rows));
        out.log(`\n${result.ok} ok, ${result.failed} failed, ${result.skipped} skipped; est. cost $${result.cost.toFixed(4)}`);
        if (result.failed > 0) out.log('FAIL: at least one model check failed.');
    }
    return result.exitCode;
}

module.exports = {
    parseArgs, buildPlan, runSmoke, formatTable, checksForRole, lowestThinkingLevel, supportsThinkingLevel, TEXT_THINKING_BUDGET,
    summarizeByRole, writeResult, resultPath, scrubSecrets,
    ROLE_ORDER, TEXT_ROLES, CHECKS, THINKING_LEVELS, DEFAULTS, HELP, RUNNERS, main
};

if (require.main === module) {
    main().then(code => process.exit(code)).catch(e => {
        console.error('model-smoke: unexpected error:', e);
        process.exit(1);
    });
}
