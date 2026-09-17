/**
 * ConfirmationManager: the safety rules that decide whether a tool call may
 * run at once, must wait for the owner's approval, or is denied outright.
 *
 * - `check(name, args)` runs the per-tool flags from tools-definition.js and
 *   the rule list below. A rule that throws on odd arguments counts as a hit:
 *   a crash must deny, never allow.
 * - `denyCheck(name, args, patterns)` matches glob patterns over
 *   "toolName:argsJson" (a pattern without ':' matches the tool name only).
 *   The owner keeps the patterns in agent_settings `approvals.deny`, with
 *   APPROVALS_DENY as the env fallback. Denied calls never reach the owner;
 *   they fail with a message the model can read.
 *
 * Pending approvals live in the database and are handled by
 * services/approval-service.js. This file holds no state between calls.
 */
const { toolDefinitions } = require('./tools-definition');
const { BLOCKED_PATTERNS: SHELL_BLOCKED } = require('@deedee/mcp-servers/src/local/index');
const { taintedAction } = require('./utils/untrusted-content');

/** The "Why" line of a taint approval: what the call does and what was read. */
function taintReason(action, taint) {
    const carried = taint.sources.some(s => s.includes(' [carried by '));
    const what = carried ? 'read untrusted content, or was created by a run that did' : 'read untrusted content';
    return `This run ${what} (${taint.describe()}) and now wants to ${action}. ` +
        'The content may have asked for it, so the owner decides.';
}

const HA_CALL_TOOLS = new Set(['ha_call_service', 'call_service']);
// Domains where any service call changes physical security. Climate,
// covers (except opening a garage) and bulk light/switch control are
// everyday actions and run unasked.
const HA_GUARDED_DOMAINS = new Set(['lock', 'alarm_control_panel']);
// A cover whose id reads as a garage or gate: opening it lets people in.
const GARAGE_COVER_RE = /garage|gate|port[oó]n|cochera|driveway/i;
const COVER_OPEN_SERVICES = new Set(['open_cover', 'open_cover_tilt', 'set_cover_position', 'set_cover_tilt_position', 'toggle', 'toggle_cover_tilt']);
// Bulk actions that open or unlock (ha_bulk_control operations).
const OPENING_ACTIONS = /open|unlock|toggle|disarm|position/i;
// Removal tools that destroy Home Assistant configuration (not list items).
const HA_CONFIG_REMOVE_RE = /^ha_config_remove_|^ha_remove_(?:device|entity|area_or_floor|zone|helpers_integrations)$/;

const DESTRUCTIVE_PLEX = new Set([
    'media_delete', 'playlist_delete', 'collection_delete',
    'media_edit_metadata', 'playlist_edit', 'collection_edit'
]);

const SHELL_REMOTE_EXEC = [
    /\|\s*(?:ba|z|k|da)?sh\b/i,          // curl ... | bash, | sh
    /\|\s*python[0-9.]*\b/i,
    /\|\s*node\b/i,
    /\b(?:ba|z|k|da)?sh\s+<\(/i,          // bash <(curl ...)
    /\b(?:ba|z|k|da)?sh\s+-c\s+["']?\$\(/i, // sh -c "$(curl ...)"
    /\beval\s+["']?\$\(\s*(?:curl|wget)\b/i
];
const SHELL_SYSTEM_DAMAGE = [
    /\brm\s+-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?\/+(?:\s|$|\*)/i, // rm -rf /
    /\brm\s+-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*\s+\/(?:etc|bin|usr|var|boot|app)\b/i,
    />\s*\/etc\//,
    /\btee\s+(?:-a\s+)?\/etc\//,
    /\bmkfs(?:\.[a-z0-9]+)?\b/i,
    /\bdd\b.*\bof=\/dev\/(?:sd|mmcblk|nvme|disk)/i,
    /:\(\)\s*\{\s*:\|:&\s*\};:/,           // fork bomb
    /\bchmod\s+(?:-R\s+)?[0-7]*777\s+\/(?:\s|$)/,
    /xmrig/i
];

function asString(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
}

function entityDomain(entityId) {
    const id = asString(entityId);
    const dot = id.indexOf('.');
    return dot > 0 ? id.slice(0, dot) : '';
}

/** Opening a garage-type cover (by id) needs the owner; closing never does. */
function isGarageOpen(entityId, service) {
    return GARAGE_COVER_RE.test(asString(entityId)) && COVER_OPEN_SERVICES.has(asString(service));
}

/**
 * Does one ha_bulk_control operation touch a guarded domain? Operations
 * carry `entity_id` (or `entity_ids`) with an `action` or `service`.
 */
function bulkOperationGuarded(op) {
    if (!op || typeof op !== 'object') return false;
    const ids = [];
    if (Array.isArray(op.entity_id)) ids.push(...op.entity_id);
    else if (op.entity_id !== undefined) ids.push(op.entity_id);
    if (Array.isArray(op.entity_ids)) ids.push(...op.entity_ids);
    if (Array.isArray(op.entities)) ids.push(...op.entities);
    const action = asString(op.action || op.service);
    const domain = asString(op.domain);
    if (domain && HA_GUARDED_DOMAINS.has(domain)) return true;
    if (domain === 'homeassistant' || domain === 'hassio') return true;
    for (const raw of ids) {
        const id = asString(raw);
        if (id === 'all') return true;
        const d = entityDomain(id);
        if (HA_GUARDED_DOMAINS.has(d)) return true;
        if (d === 'cover' && GARAGE_COVER_RE.test(id) && OPENING_ACTIONS.test(action)) return true;
    }
    return false;
}

/** Stable JSON: keys sorted so a deny pattern does not depend on argument order. */
function stableJson(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

/** The string deny patterns match against. */
function denyKey(name, args) {
    let json;
    try { json = stableJson(args ?? {}); } catch { json = '{}'; }
    return `${asString(name)}:${json}`;
}

/** Glob to RegExp: `*` any run, `?` one char, everything else literal. Case-insensitive. */
function globToRegExp(pattern) {
    const src = String(pattern).split('').map(ch => {
        if (ch === '*') return '.*';
        if (ch === '?') return '.';
        return ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }).join('');
    return new RegExp(`^${src}$`, 'is');
}

/** Per-tool flags declared next to the tool (never sent to the model). */
function buildToolFlags(definitions = toolDefinitions) {
    const flags = new Map();
    for (const group of definitions || []) {
        for (const tool of group.functionDeclarations || []) {
            if (tool && tool.requiresConfirmation) {
                flags.set(tool.name, {
                    message: typeof tool.confirmationReason === 'string' && tool.confirmationReason
                        ? tool.confirmationReason
                        : `'${tool.name}' is marked as needing the owner's approval.`
                });
            }
        }
    }
    return flags;
}

class ConfirmationManager {
    /**
     * @param {object} db - AgentDB (isVerifiedContact, searchPeople, getAgentSetting); a stub is fine in tests
     * @param {{ toolFlags?: Map<string, {message: string}>, isOwnerChat?: (channel: string, target: string) => boolean }} [opts]
     *   isOwnerChat: the delivery service's owner check (phone JID, LID, Telegram id).
     */
    constructor(db, opts = {}) {
        this.db = db || {};
        this.toolFlags = opts.toolFlags || buildToolFlags();
        this.isOwnerChat = typeof opts.isOwnerChat === 'function' ? opts.isOwnerChat : null;

        this.rules = [
            {
                id: 'ha-critical',
                condition: (name, args) => {
                    if (!HA_CALL_TOOLS.has(name)) return false;
                    const domain = asString(args.domain);
                    const service = asString(args.service);
                    if (domain === 'homeassistant' || domain === 'hassio') return true;
                    if (HA_GUARDED_DOMAINS.has(domain)) return true;
                    if (domain === 'automation' && service === 'turn_off') return true;
                    if (domain === 'script' && service.includes('delete')) return true;
                    if (domain === 'cover' && isGarageOpen(args.entity_id, service)) return true;
                    if (asString(args.entity_id) === 'all') {
                        if (['light', 'switch', 'media_player'].includes(domain) && service === 'turn_off') return false;
                        if (domain === 'light' && service === 'turn_on') return false;
                        return true;
                    }
                    return false;
                },
                message: 'This Home Assistant action touches the system, a lock, the alarm, a garage door, or every device at once.'
            },
            {
                // Bulk control of lights, switches, media or climate runs unasked;
                // only operations on a guarded domain (or on everything) pause.
                id: 'ha-bulk',
                condition: (name, args) => {
                    if (name !== 'ha_bulk_control') return false;
                    const ops = Array.isArray(args.operations) ? args.operations : [];
                    if (ops.some(bulkOperationGuarded)) return true;
                    // Flat shape: { entities: [...], action }
                    return bulkOperationGuarded({ entities: args.entities, entity_id: args.entity_id, action: args.action, domain: args.domain });
                },
                message: 'This bulk Home Assistant action touches a lock, the alarm, a garage door, or every device at once.'
            },
            {
                id: 'shell-remote-exec',
                condition: (name, args) => name === 'runShellCommand'
                    && SHELL_REMOTE_EXEC.some(re => re.test(asString(args.command))),
                message: 'The shell command pipes remote content into an interpreter.'
            },
            {
                id: 'shell-system-damage',
                condition: (name, args) => name === 'runShellCommand'
                    && SHELL_SYSTEM_DAMAGE.some(re => re.test(asString(args.command))),
                message: 'The shell command can damage the system.'
            },
            {
                // Same list the local MCP server refuses outright, so the two
                // layers never disagree. A glob is a hit as well: the rules
                // read the command text, so `/app/data/browser*/*.env` must
                // not walk around the spelled-out path.
                id: 'shell-credentials',
                condition: (name, args) => name === 'runShellCommand'
                    && SHELL_BLOCKED.some(rule => rule.match(asString(args.command))),
                message: 'Direct database or credentials access through the shell is not allowed. Use the proper tools instead.'
            },
            {
                // Chromium's CDP port: Network.getAllCookies would dump every session.
                // Anchor to a network context so a hash or id that contains 9222 passes.
                id: 'shell-cdp',
                condition: (name, args) => {
                    if (name !== 'runShellCommand') return false;
                    const command = asString(args.command);
                    return /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|:)9222\b/i.test(command)
                        || /\/json\/(?:list|version|new|activate)\b|\/devtools\/(?:page|browser)\//i.test(command);
                },
                message: 'The browser debug port (CDP) exposes every logged-in session. Use the browser tools instead.'
            },
            {
                id: 'file-browser-profile',
                condition: (name, args) => ['readFile', 'writeFile', 'listDirectory'].includes(name)
                    && /browser[_-]profile|browser-secrets/i.test(asString(args.path)),
                message: 'The browser profile holds secrets and cookies. Reading it is not allowed.'
            },
            {
                id: 'email-send',
                condition: (name, args) => {
                    if (/sendEmail|send_email|send_mail|gmail[a-z0-9_]*send|send[a-z0-9_]*gmail/i.test(name)) return true;
                    if (!/gmail|mail/i.test(name)) return false;
                    return /messages\.send|drafts\.send|"send"/i.test(denyKey(name, args));
                },
                message: 'Sending email needs the owner\'s approval.'
            },
            {
                id: 'first-contact',
                condition: (name, args) => name === 'sendMessage' && this._isFirstContact(args),
                message: 'First message to a contact the owner never messaged through Deedee.'
            },
            {
                id: 'appointments',
                condition: (name) => /(?:^|_)(?:book|cancel)_(?:appointment|turn)$/i.test(name),
                message: 'This books or cancels a real appointment.'
            },
            {
                id: 'plex-destructive',
                condition: (name) => DESTRUCTIVE_PLEX.has(name),
                message: 'This action modifies the Plex library.'
            },
            {
                // Data-destroying deletes only. The internal ones (deletePerson,
                // deleteVault, delete_garment, deleteDeviceAlias) carry a
                // per-tool flag; Plex deletes sit in DESTRUCTIVE_PLEX. Everyday
                // removals (a shopping-list item, a track from a playlist,
                // cancelJob) run unasked.
                id: 'delete-or-remove',
                condition: (name) => HA_CONFIG_REMOVE_RE.test(name),
                message: 'This deletes Home Assistant configuration.'
            }
        ];
    }

    /** Owner phone digits and lower-cased name from settings, env as fallback. */
    _ownerIdentity() {
        let ownerPhone = process.env.MY_PHONE || '';
        let ownerName = 'owner';
        try {
            if (typeof this.db.getAgentSetting === 'function') {
                ownerPhone = this.db.getAgentSetting('owner_phone')?.value || ownerPhone;
                ownerName = String(this.db.getAgentSetting('owner_name')?.value || ownerName).toLowerCase();
            }
        } catch { /* settings unavailable: nobody counts as the owner */ }
        return { ownerDigits: String(ownerPhone).replace(/[^0-9]/g, ''), ownerName };
    }

    /**
     * Is `sendMessage` addressed to the owner himself (an alias, his phone,
     * his WhatsApp LID, or one of his Telegram ids)? The same ids the
     * approval service routes by. Anything unclear counts as someone else.
     */
    isOwnerTarget(args) {
        const a = args && typeof args === 'object' ? args : {};
        const service = asString(a.service) || 'whatsapp';
        const raw = asString(a.to).trim();
        if (!raw) return false;
        const { ownerDigits, ownerName } = this._ownerIdentity();
        const lower = raw.toLowerCase();
        if (['me', 'myself', 'owner', ownerName].includes(lower)) return true;
        if (service === 'telegram') {
            const ids = String(process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
            return ids.includes(raw);
        }
        // Every web chat is the owner's.
        if (service === 'web') return true;
        if (service !== 'whatsapp') return false;
        const lid = /^\+?[0-9]+@lid$/i.test(raw);
        if (!lid && /[a-zA-Z]/.test(raw.replace(/@(?:s\.whatsapp\.net|c\.us)$/i, ''))) return false;
        const digits = raw.replace(/@.*$/, '').replace(/[^0-9]/g, '');
        if (!digits) return false;
        if (!lid && ownerDigits && digits === ownerDigits) return true;
        if (this.isOwnerChat) {
            try {
                return !!this.isOwnerChat('whatsapp', lid ? `${digits}@lid` : `${digits}@s.whatsapp.net`);
            } catch { return false; }
        }
        return false;
    }

    /**
     * A run that read untrusted content must ask before this call?
     * @returns {{ requiresConfirmation: boolean, message?: string, rule?: string }}
     */
    taintCheck(name, args, { taint = null, serverName = null } = {}) {
        if (!taint || !taint.tainted) return { requiresConfirmation: false };
        let action;
        try {
            action = taintedAction(asString(name), args, { serverName, isOwnerTarget: (a) => this.isOwnerTarget(a), browser: taint.browser || null });
        } catch (e) {
            action = `run ${asString(name)}`;
        }
        if (!action) return { requiresConfirmation: false };
        return { requiresConfirmation: true, rule: 'untrusted-content', message: taintReason(action, taint) };
    }

    /**
     * Does `sendMessage` reach someone the owner never messaged through Deedee?
     * Mirrors the executor's target resolution: aliases for the owner, names
     * through the people table, digits otherwise. Unresolvable targets are
     * left to the executor, which refuses them on its own.
     */
    _isFirstContact(args) {
        const service = asString(args.service) || 'whatsapp';
        if (service !== 'whatsapp') return false;
        const raw = asString(args.to).trim();
        if (!raw) return false;
        let target = raw;
        const { ownerDigits, ownerName } = this._ownerIdentity();
        const lower = target.toLowerCase();
        if (['me', 'myself', 'owner', ownerName].includes(lower)) return false;
        if (/[a-zA-Z]/.test(target) && !target.includes('@')) {
            if (typeof this.db.searchPeople !== 'function') return true;
            const matches = this.db.searchPeople(target) || [];
            if (matches.length !== 1 || !matches[0].phone) return false; // the executor asks for clarification
            target = String(matches[0].phone);
        }
        const digits = target.replace(/[^0-9]/g, '');
        if (!digits || digits.length < 5) return false;
        if (ownerDigits && digits === ownerDigits) return false;
        if (typeof this.db.isVerifiedContact !== 'function') return true;
        return !this.db.isVerifiedContact(service, digits);
    }

    /**
     * Does the call need the owner's approval?
     * @returns {{ requiresConfirmation: boolean, message?: string, rule?: string }}
     */
    check(name, args) {
        const toolName = asString(name);
        if (!toolName) {
            return { requiresConfirmation: true, rule: 'malformed', message: 'The tool call has no name.' };
        }
        const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const flag = this.toolFlags.get(toolName);
        if (flag) return { requiresConfirmation: true, rule: 'tool-flag', message: flag.message };

        for (const rule of this.rules) {
            try {
                if (rule.condition(toolName, safeArgs)) {
                    return { requiresConfirmation: true, rule: rule.id, message: rule.message };
                }
            } catch (e) {
                console.warn(`[ConfirmationManager] Rule '${rule.id}' failed on ${toolName}: ${e.message}. Asking for approval.`);
                return {
                    requiresConfirmation: true,
                    rule: rule.id,
                    message: `The safety rule '${rule.id}' could not read these arguments (${e.message}). Approval required.`
                };
            }
        }
        return { requiresConfirmation: false };
    }

    /**
     * Owner deny-list. Patterns are globs over "toolName:argsJson"; a pattern
     * with no ':' matches the tool name alone.
     * @returns {{ denied: boolean, pattern?: string }}
     */
    denyCheck(name, args, patterns) {
        const list = Array.isArray(patterns) ? patterns : [];
        if (list.length === 0) return { denied: false };
        const toolName = asString(name);
        const key = denyKey(toolName, args);
        for (const raw of list) {
            const pattern = String(raw ?? '').trim();
            if (!pattern || pattern.startsWith('#')) continue;
            try {
                const re = globToRegExp(pattern);
                const hit = pattern.includes(':') ? re.test(key) : re.test(toolName);
                if (hit) return { denied: true, pattern };
            } catch (e) {
                console.warn(`[ConfirmationManager] Bad deny pattern '${pattern}': ${e.message}`);
            }
        }
        return { denied: false };
    }
}

module.exports = { ConfirmationManager, taintReason, buildToolFlags, denyKey, globToRegExp, stableJson, HA_GUARDED_DOMAINS, bulkOperationGuarded, isGarageOpen };
