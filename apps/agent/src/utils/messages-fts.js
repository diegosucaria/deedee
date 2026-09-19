/**
 * Full-text index over stored chat messages (SQLite FTS5).
 *
 * `searchMessages` used to run `LIKE '%q%'` over every row's content and raw
 * parts JSON: a full scan, newest first, no ranking, and a hit inside tool
 * JSON came back as 400 characters of escaped JSON.
 *
 * Layout:
 * - `messages_fts(body, tool)`: `body` is what was said, `tool` is what tools
 *   returned. Two columns so a chat line outranks a tool dump that happens to
 *   hold the same word (see FTS_WEIGHTS).
 * - `messages_fts_map(fts_id, msg_id)`: `messages.id` is TEXT, so its rowid is
 *   not stable across a VACUUM. The map gives each message an integer id of
 *   its own, and deletes find their index row without a scan.
 * - Three triggers keep the index in step with every writer, in SQL only, so
 *   no code path can forget it.
 *
 * Base64 never enters the index: attachments become short markers.
 */

const FTS_TOOL_RESULT_CHARS = 2000;
const FTS_WEIGHTS = Object.freeze({ body: 1.0, tool: 0.25 });
const FTS_SNIPPET_TOKENS = 48;
const FTS_EXCERPT_CHARS = 400;
const FTS_MAX_QUERY_TOKENS = 8;
const BACKFILL_FLAG = 'messages_fts_backfilled';
const BACKFILL_BATCH = 500;

/**
 * SQL for the two indexed columns of one `messages` row.
 * @param {string} r - row alias: `NEW` in a trigger, a table alias in the backfill
 * @returns {{ body: string, tool: string }}
 */
function columnsSql(r) {
    const parts = `json_each(${r}.parts) p WHERE p.type = 'object'`;
    const usable = `${r}.parts IS NOT NULL AND json_valid(${r}.parts) AND json_type(${r}.parts) = 'array'`;
    const said = `
        SELECT CASE
            WHEN json_type(p.value, '$.text') = 'text' THEN json_extract(p.value, '$.text')
            WHEN json_type(p.value, '$.functionCall') = 'object'
                THEN '[tool: ' || COALESCE(json_extract(p.value, '$.functionCall.name'), 'unknown') || ']'
            WHEN json_extract(p.value, '$.inlineData.mimeType') LIKE 'image/%' THEN '[image attached]'
            WHEN json_extract(p.value, '$.inlineData.mimeType') LIKE 'audio/%' THEN '[audio attached]'
            WHEN json_type(p.value, '$.inlineData') = 'object' THEN '[file attached]'
        END AS piece FROM ${parts} ORDER BY p.id`;
    // An untrusted envelope wraps what the tool returned in `content`; index
    // that, not the envelope's own note, which is the same in every row.
    const returned = `
        SELECT '[tool result: ' || COALESCE(json_extract(p.value, '$.functionResponse.name'), 'unknown') || '] '
            || substr(COALESCE(
                json_extract(p.value, '$.functionResponse.response.content'),
                json_extract(p.value, '$.functionResponse.response'), ''), 1, ${FTS_TOOL_RESULT_CHARS}) AS piece
        FROM ${parts} AND json_type(p.value, '$.functionResponse') = 'object' ORDER BY p.id`;
    const joined = (select) => `COALESCE((SELECT group_concat(piece, ' ') FROM (${select}) WHERE piece IS NOT NULL AND piece != ''), '')`;
    return {
        body: `CASE
            WHEN ${r}.content IS NOT NULL AND ${r}.content != '' THEN ${r}.content
            WHEN ${usable} THEN ${joined(said)}
            ELSE '' END`,
        tool: `CASE WHEN ${usable} THEN ${joined(returned)} ELSE '' END`,
    };
}

/** Drop the index, its map and its triggers. `MESSAGES_FTS=0` and a rebuild both start here. */
function dropMessagesFts(db) {
    db.exec(`
        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_au;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TABLE IF EXISTS messages_fts;
        DROP TABLE IF EXISTS messages_fts_map;
    `);
    db.prepare('DELETE FROM agent_settings WHERE key = ?').run(BACKFILL_FLAG);
}

/**
 * Create the index and its triggers. Safe to run at every boot.
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} false when this SQLite build has no FTS5
 */
function createMessagesFts(db) {
    const n = columnsSql('NEW');
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            body, tool, tokenize = 'unicode61 remove_diacritics 2');

        CREATE TABLE IF NOT EXISTS messages_fts_map (
            fts_id INTEGER PRIMARY KEY,
            msg_id TEXT NOT NULL UNIQUE
        );

        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
            INSERT OR IGNORE INTO messages_fts_map(msg_id) VALUES (NEW.id);
            INSERT OR REPLACE INTO messages_fts(rowid, body, tool)
                SELECT fts_id, ${n.body}, ${n.tool} FROM messages_fts_map WHERE msg_id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content, parts ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = (SELECT fts_id FROM messages_fts_map WHERE msg_id = OLD.id);
            INSERT INTO messages_fts(rowid, body, tool)
                SELECT fts_id, ${n.body}, ${n.tool} FROM messages_fts_map WHERE msg_id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = (SELECT fts_id FROM messages_fts_map WHERE msg_id = OLD.id);
            DELETE FROM messages_fts_map WHERE msg_id = OLD.id;
        END;
    `);
    return true;
}

/**
 * Index one rowid range of messages that existed before the triggers did.
 * Rows a trigger already indexed are skipped, so a second run changes nothing.
 * @returns {number} rows added
 */
function backfillRange(db, fromRowid, toRowid) {
    const m = columnsSql('msg');
    const run = db.transaction(() => {
        const before = db.prepare('SELECT COALESCE(MAX(fts_id), 0) AS id FROM messages_fts_map').get().id;
        db.prepare('INSERT OR IGNORE INTO messages_fts_map(msg_id) SELECT id FROM messages WHERE rowid BETWEEN ? AND ?')
            .run(fromRowid, toRowid);
        return db.prepare(`
            INSERT INTO messages_fts(rowid, body, tool)
            SELECT map.fts_id, ${m.body}, ${m.tool}
            FROM messages_fts_map map JOIN messages msg ON msg.id = map.msg_id
            WHERE map.fts_id > ?
        `).run(before).changes;
    });
    return run();
}

/**
 * The MATCH strings to try. `all` holds every word: the phrase first, then
 * the words in any order. `any` is the fallback for when `all` finds nothing:
 * any one word, as a prefix. Every token is quoted, so nothing the caller
 * typed is read as FTS5 syntax.
 * @param {string} query
 * @returns {{ all: string[], any: string[] }}
 */
function matchLevels(query) {
    const tokens = [...new Set((String(query ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
        .filter(t => t.length >= 2))].slice(0, FTS_MAX_QUERY_TOKENS);
    if (tokens.length === 0) return { all: [], any: [] };
    const quoted = tokens.map(t => `"${t}"`);
    return {
        all: tokens.length > 1 ? [`"${tokens.join(' ')}"`, quoted.join(' ')] : [quoted[0]],
        any: [quoted.map(q => `${q}*`).join(' OR ')],
    };
}

/**
 * Ranked search. Rows that hold every word come back with the exact phrase
 * first. Only when there are none does a loose match (any word, as a prefix)
 * count: a few exact rows serve the model better than a full list of noise.
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {{ limit?: number, chatId?: string, notChatId?: string, role?: string, from?: string, to?: string }} [opts]
 *   `from` and `to` are local days, YYYY-MM-DD, both inclusive.
 * @returns {Array<{ id: string, chat_id: string, role: string, timestamp: string, content: string }>}
 */
function searchMessagesFts(db, query, { limit = 10, chatId, notChatId, role, from, to } = {}) {
    const levels = matchLevels(query);
    const max = Math.max(1, Math.min(Number(limit) || 10, 50));
    if (levels.all.length === 0) return [];

    const where = ['messages_fts MATCH ?'];
    const params = [];
    if (chatId) { where.push('msg.chat_id = ?'); params.push(chatId); }
    if (notChatId) { where.push('(msg.chat_id IS NULL OR msg.chat_id != ?)'); params.push(notChatId); }
    if (role) { where.push('msg.role = ?'); params.push(role); }
    if (from) { where.push("date(msg.timestamp, 'localtime') >= ?"); params.push(from); }
    if (to) { where.push("date(msg.timestamp, 'localtime') <= ?"); params.push(to); }

    const stmt = db.prepare(`
        SELECT msg.id, msg.chat_id, msg.role, msg.timestamp,
            snippet(messages_fts, -1, '', '', '…', ${FTS_SNIPPET_TOKENS}) AS content
        FROM messages_fts
        JOIN messages_fts_map map ON map.fts_id = messages_fts.rowid
        JOIN messages msg ON msg.id = map.msg_id
        WHERE ${where.join(' AND ')}
        ORDER BY bm25(messages_fts, ${FTS_WEIGHTS.body}, ${FTS_WEIGHTS.tool}), msg.timestamp DESC
        LIMIT ?
    `);

    const found = new Map();
    const run = (level) => {
        for (const row of stmt.all(level, ...params, max)) {
            if (found.size >= max) return;
            if (found.has(row.id)) continue;
            const text = String(row.content || '');
            found.set(row.id, { ...row, content: text.length > FTS_EXCERPT_CHARS ? `${text.slice(0, FTS_EXCERPT_CHARS - 1)}…` : text });
        }
    };
    levels.all.forEach(run);
    if (found.size === 0) levels.any.forEach(run);
    return [...found.values()];
}

module.exports = {
    FTS_TOOL_RESULT_CHARS, FTS_EXCERPT_CHARS, BACKFILL_FLAG, BACKFILL_BATCH,
    columnsSql, createMessagesFts, dropMessagesFts, backfillRange, matchLevels, searchMessagesFts,
};
