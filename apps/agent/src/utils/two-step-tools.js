/**
 * Two-step tools: the call with `confirm` false (or left out) only checks
 * the action and describes it; the call with `confirm: true` does it. The
 * first step changes nothing, so no approval rule pauses it.
 *
 * Only servers known to work this way count. Another server's tool with the
 * same name may act on the first call, so it stays under the normal rules.
 */

// server -> tool names whose confirm:false call is a preview
const TWO_STEP = Object.freeze({
    allende: new Set(['book_appointment', 'cancel_appointment']),
    pilotfy: new Set(['book_turn', 'cancel_turn']),
});

const SUMMARY_CHARS = 300;

/**
 * Is this call the preview step of a known two-step tool?
 * `confirm` must be absent, null or the boolean false. A string or a number
 * does not count: the server might read it as true.
 * @param {string} toolName
 * @param {object} args
 * @param {string|null} serverName - the MCP server that owns the tool; required
 */
function isPreviewCall(toolName, args, serverName) {
    const tools = serverName ? TWO_STEP[String(serverName)] : null;
    if (!tools || !tools.has(String(toolName || ''))) return false;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const confirm = args.confirm;
    return confirm === undefined || confirm === null || confirm === false;
}

/** Is this a known two-step tool (either step)? */
function isTwoStepTool(toolName, serverName) {
    const tools = serverName ? TWO_STEP[String(serverName)] : null;
    return !!(tools && tools.has(String(toolName || '')));
}

// The arguments that name what a two-step call acts on. The real call may
// add others (a reason, a note) that the check step left out.
const KEY_ARGS = Object.freeze({
    book_appointment: ['slot_ref'],
    cancel_appointment: ['appointmentId'],
    book_turn: ['planeId', 'date', 'timeFrom', 'timeTo'],
    cancel_turn: ['turnId'],
});

function stableJson(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

/**
 * A key for "the same action": the check step and the real call of a
 * two-step tool share it (only the arguments that name the target count),
 * and so do two identical calls of any other tool (all arguments).
 */
function stepKey(toolName, args) {
    const name = String(toolName || '');
    const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const keys = KEY_ARGS[name];
    let picked = src;
    if (keys && keys.every(k => src[k] !== undefined && src[k] !== null && src[k] !== '')) {
        picked = {};
        for (const k of keys) picked[k] = String(src[k]);
    } else if (keys) {
        picked = {};
        for (const k of Object.keys(src)) if (k !== 'confirm') picked[k] = src[k];
    }
    let json;
    try { json = stableJson(picked); } catch { json = '{}'; }
    return `${name}:${json}`;
}

/**
 * A tool result as an object: MCP servers return `{ output: "<json>" }`.
 * @returns {object|null}
 */
function parseToolOutput(result) {
    if (!result || typeof result !== 'object') return null;
    if (typeof result.output === 'string') {
        try {
            const parsed = JSON.parse(result.output);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return Array.isArray(result) ? null : result;
}

/** The one-line summary a preview returned, if it has one. */
function previewSummary(result) {
    const data = parseToolOutput(result);
    if (!data || data.status !== 'needs_confirmation' || typeof data.summary !== 'string') return null;
    const text = data.summary.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

module.exports = { TWO_STEP, KEY_ARGS, isPreviewCall, isTwoStepTool, stepKey, parseToolOutput, previewSummary };
