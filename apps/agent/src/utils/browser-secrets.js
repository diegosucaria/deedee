/**
 * Browser secrets: the Settings UI saves a JSON map; the browser MCP server
 * (@playwright/mcp --secrets) reads a dotenv file. This module renders one
 * from the other and lists the names for the prompt. The model only sees
 * names: the server redacts values from tool output, and the confirmation
 * manager stops runShellCommand from reading `browser_profile/` or talking
 * to the CDP port. Both files are mode 0600 under the data dir.
 */
const fs = require('fs');
const path = require('path');

const KEY_RE = /^[A-Z0-9_]+$/;

/** Paths of the JSON and dotenv files under `dataDir`. */
function secretsPaths(dataDir) {
    const dir = path.join(dataDir, 'browser_profile');
    return { dir, json: path.join(dir, 'browser-secrets.json'), env: path.join(dir, 'browser-secrets.env') };
}

/**
 * Quotes one value so `dotenv.parse` (what @playwright/mcp uses for
 * --secrets) returns it unchanged. dotenv does not unescape `\"` or `\\`
 * inside double quotes, so escaping breaks round trips. Single quotes are
 * literal, so they are the default; double quotes serve values that hold a
 * single quote, with real newlines written as `\n` (dotenv turns them back).
 */
function quoteValue(value) {
    if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
    if (!value.includes('"')) return `"${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
    throw new Error('A secret value cannot hold both a single and a double quote');
}

/**
 * Renders one `KEY=<quoted value>` line per secret. Throws on a key that is
 * not upper-case letters, digits and underscores, on a value that is not a
 * string, or on a value that cannot be quoted.
 */
function renderDotenv(secrets) {
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
        throw new Error('Secrets must be a JSON object');
    }
    const lines = [];
    for (const [key, value] of Object.entries(secrets)) {
        if (!KEY_RE.test(key)) throw new Error(`Invalid secret name "${key}": use A-Z, 0-9 and _ only`);
        if (typeof value !== 'string') throw new Error(`Secret "${key}" must be a string`);
        lines.push(`${key}=${quoteValue(value)}`);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

/** Reads the JSON file; {} when missing or unreadable. */
function readSecrets(dataDir) {
    const { json } = secretsPaths(dataDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Secret names, sorted. Names only; never values. */
function readSecretNames(dataDir) {
    return Object.keys(readSecrets(dataDir)).filter(k => KEY_RE.test(k)).sort();
}

/** Writes both files. Validates first so a bad key changes nothing. */
function writeSecrets(dataDir, secrets) {
    const dotenv = renderDotenv(secrets);
    const { dir, json, env } = secretsPaths(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(json, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(env, dotenv, { encoding: 'utf8', mode: 0o600 });
    return Object.keys(secrets).length;
}

/**
 * Regenerates the dotenv file from the JSON file. Run on boot before the MCP
 * servers start so the browser server always reads the current values.
 * Returns the number of secrets written.
 */
function regenerateEnv(dataDir) {
    const secrets = readSecrets(dataDir);
    const valid = {};
    for (const [k, v] of Object.entries(secrets)) {
        if (!KEY_RE.test(k) || typeof v !== 'string') continue;
        try { quoteValue(v); } catch { continue; }
        valid[k] = v;
    }
    const { dir, env } = secretsPaths(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(env, renderDotenv(valid), { encoding: 'utf8', mode: 0o600 });
    return Object.keys(valid).length;
}

module.exports = { KEY_RE, secretsPaths, quoteValue, renderDotenv, readSecrets, readSecretNames, writeSecrets, regenerateEnv };
