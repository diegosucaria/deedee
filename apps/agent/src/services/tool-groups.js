/**
 * Tool groups for interactive requests.
 *
 * The router names the optional groups a message needs. Core tools are always
 * sent; tools from the other groups are left out of that request. Every
 * request otherwise carries every tool declaration (~100k tokens with all MCP
 * servers connected), so dropping the groups a message can't use is the main
 * lever on per-message cost and latency.
 */

// Internal tool categories (tools-definition.js `category`) → group.
// Categories not listed here (and tools with no category) are core.
// `filesystem` stays core on purpose: the `code` group only marks the turn as
// coding (thinking class `coding`, docs/models.md) until tool deferral moves
// the shell and file tools behind it.
const INTERNAL_CATEGORY_GROUPS = {
    smarthome: 'home',
    wardrobe: 'wardrobe',
    dj: 'dj',
    slack: 'slack',
    vault: 'docs',
    rag: 'docs',
};

// MCP server name → group. Servers not listed here are always sent, so a newly
// added server works before anyone maps it.
function mcpServerGroup(serverName = '') {
    if (serverName.startsWith('gws_')) return 'workspace';
    return {
        homeassistant: 'home',
        'node-red': 'home',
        plex: 'media',
        browser: 'browser',
        pilotfy: 'flights',
        allende: 'health',
    }[serverName] || null;
}

const TOOL_GROUPS = {
    home: 'lights, devices, sensors, Home Assistant, Node-RED automations',
    workspace: 'Gmail, Google Calendar, Google Drive / Docs / Sheets / Slides',
    slack: 'Slack messages, channels and people',
    wardrobe: 'clothes, outfits, packing for trips',
    dj: 'vinyl records, DJ sets, track picks',
    docs: 'life vaults, notes, uploaded documents',
    media: 'Plex movies, shows and music',
    browser: 'opening or acting on web pages (Playwright browser)',
    flights: 'Pilotfy flight school: lessons, bookings, flight hours',
    health: 'Sanatorio Allende medical appointments ("turnos"): search, book, cancel',
    code: 'repo files, shell, git, editing this codebase',
};

// Words that name an integration outright. A message that names one always
// gets its group, whatever the router decided: asking for "the allende mcp"
// and getting a tool set without it made the model improvise through the shell.
const GROUP_NAME_WORDS = {
    home: ['home assistant', 'homeassistant', 'node-red', 'node red', 'nodered'],
    workspace: ['gmail', 'google calendar', 'google drive', 'google docs', 'google sheets'],
    slack: ['slack'],
    media: ['plex'],
    browser: ['browser', 'playwright'],
    flights: ['pilotfy'],
    health: ['allende'],
    code: ['shell', 'git', 'repo', 'repository', 'codebase'],
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The short code words need the whole word, so "git" does not fire on
// "digital", "legit" or "github". Product names match from the start of a word
// only, so inflections and Spanglish still fire: "gmails", "google calendario",
// "slackeame", "browsers".
const WHOLE_WORD_GROUPS = new Set(['code']);
const GROUP_NAME_PATTERNS = Object.fromEntries(
    Object.entries(GROUP_NAME_WORDS).map(([g, words]) => {
        const tail = WHOLE_WORD_GROUPS.has(g) ? '\\b' : '';
        return [g, new RegExp(`\\b(?:${words.map(escapeRe).join('|')})${tail}`, 'i')];
    })
);

/** Groups whose integration is named in `text` (case-insensitive, from a word start). */
function groupsNamedIn(text) {
    const t = String(text || '');
    if (!t) return [];
    return Object.entries(GROUP_NAME_PATTERNS)
        .filter(([, re]) => re.test(t))
        .map(([group]) => group);
}

/**
 * Keeps core tools plus tools from `groups`. `groups` must be an array;
 * callers skip scoping entirely when the router gave none.
 */
function filterToolsByGroups(internalTools, externalTools, groups) {
    const wanted = new Set(groups);
    const keepInternal = t => {
        const g = INTERNAL_CATEGORY_GROUPS[t.category];
        return !g || wanted.has(g);
    };
    const keepExternal = t => {
        const g = mcpServerGroup(t.serverName);
        return !g || wanted.has(g);
    };
    return {
        internalTools: internalTools.filter(keepInternal),
        externalTools: externalTools.filter(keepExternal),
    };
}

/**
 * Remembers the groups each chat used recently, so a short follow-up ("ok",
 * "and the kitchen?") keeps the tools of the task it continues even when the
 * router sees no need for them in that message alone.
 */
class ToolGroupMemory {
    constructor(ttlMs = 30 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.byChat = new Map(); // chatId -> Map(group -> lastUsedMs)
    }

    // Returns `groups` plus any group this chat used within the TTL, and records them.
    merge(chatId, groups, now = Date.now()) {
        const valid = groups.filter(g => Object.prototype.hasOwnProperty.call(TOOL_GROUPS, g));
        let seen = this.byChat.get(chatId);
        if (!seen) {
            seen = new Map();
            this.byChat.set(chatId, seen);
        }
        for (const [g, ts] of seen) {
            if (now - ts > this.ttlMs) seen.delete(g);
        }
        for (const g of valid) seen.set(g, now);
        return [...seen.keys()];
    }
}

module.exports = { TOOL_GROUPS, INTERNAL_CATEGORY_GROUPS, mcpServerGroup, filterToolsByGroups, ToolGroupMemory, groupsNamedIn };
