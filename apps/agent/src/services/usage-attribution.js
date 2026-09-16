/**
 * Usage attribution helpers: which class of call a token_usage row belongs to
 * and a cheap estimate of what the prompt was made of.
 *
 * Tags on the main chat path:
 *   chat | job | subagent | watcher          the first model call of a turn
 *   <base>_tool_loop                         every call that follows tool results
 *
 * Estimates use JSON length / 4, the same rule the [Context] log lines use.
 * They are not billed counts; the API's promptTokenCount stays the source of
 * truth. Their job is to show how the prompt splits between the system
 * instruction, the declared tools and the history.
 *
 * The prefix hash covers the part of the request that implicit caching can
 * reuse: the system instruction plus the sorted declaration names. A hash
 * that changes between two turns of one chat means the cache prefix moved.
 */
const crypto = require('crypto');

const CHARS_PER_TOKEN = 4;

/**
 * Estimate tokens for a string or a JSON-serialisable value.
 * @param {*} value
 * @returns {number}
 */
function estimateTokens(value) {
    if (value === null || value === undefined || value === '') return 0;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Base tag for a message: sub-agent runs first, then watcher alerts, then
 * scheduler jobs; everything else is an interactive chat.
 * @param {object} message
 * @param {{ watcher?: boolean, toolLoop?: boolean }} [opts]
 * @returns {string}
 */
function usageTag(message, opts = {}) {
    const meta = message?.metadata || {};
    let base = 'chat';
    if (meta.isSubAgent) base = 'subagent';
    else if (opts.watcher) base = 'watcher';
    else if (message?.source === 'scheduler') base = 'job';
    return opts.toolLoop ? `${base}_tool_loop` : base;
}

/**
 * Function declarations found in a Gemini `tools` array.
 * @param {Array} tools
 * @returns {Array}
 */
function functionDeclarations(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap(t => Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []);
}

/**
 * sha1 of the system instruction plus the sorted declaration names.
 * @param {string} systemInstruction
 * @param {Array} tools - Gemini `tools` array
 * @returns {string}
 */
function prefixHash(systemInstruction, tools) {
    const names = functionDeclarations(tools).map(d => d?.name).filter(Boolean).sort();
    return crypto.createHash('sha1')
        .update(String(systemInstruction || ''))
        .update('\n')
        .update(names.join(','))
        .digest('hex');
}

/**
 * Estimate the three prompt parts and hash the cacheable prefix.
 * @param {{ systemInstruction?: string, tools?: Array, history?: Array }} parts
 * @returns {{ sysTokensEst: number, toolsTokensEst: number, historyTokensEst: number, declCount: number, prefixHash: string }}
 */
function promptComposition({ systemInstruction = '', tools = [], history = [] } = {}) {
    const decls = functionDeclarations(tools);
    return {
        sysTokensEst: estimateTokens(systemInstruction),
        // Declarations when there are any; otherwise the tools array itself
        // (googleSearch mode declares nothing but still ships a tool block).
        toolsTokensEst: decls.length ? estimateTokens(decls) : estimateTokens(tools),
        historyTokensEst: estimateTokens(history),
        declCount: decls.length,
        prefixHash: prefixHash(systemInstruction, tools)
    };
}

/**
 * The four token_usage estimate columns from a composition (or nothing).
 * @param {object} [composition]
 * @returns {object}
 */
function usageColumns(composition) {
    if (!composition) return {};
    const { sysTokensEst, toolsTokensEst, historyTokensEst, declCount } = composition;
    return { sysTokensEst, toolsTokensEst, historyTokensEst, declCount };
}

module.exports = { CHARS_PER_TOKEN, estimateTokens, usageTag, functionDeclarations, prefixHash, promptComposition, usageColumns };
