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
 * Attachments (`inlineData`) become short markers, so a picture never enters
 * the index. A tool call or result whose own payload is base64 adds at most
 * FTS_TOOL_RESULT_CHARS of it: a few long tokens that no query matches.
 */

const crypto = require('crypto');

const FTS_TOOL_RESULT_CHARS = 2000;
const FTS_WEIGHTS = Object.freeze({ body: 1.0, tool: 0.25 });
const FTS_SNIPPET_TOKENS = 48;
const FTS_EXCERPT_CHARS = 400;
const FTS_MAX_QUERY_WORDS = 12;
const FTS_PREFIX_MIN_CHARS = 4;
const BACKFILL_FLAG = 'messages_fts_backfilled';
const SCHEMA_FLAG = 'messages_fts_schema';
const FTS_TOKENIZE = 'unicode61 remove_diacritics 2';
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
    // A call's arguments are often the only stored copy of what the agent did:
    // the text it sent to a contact, the reminder it set.
    // An untrusted envelope wraps what the tool returned in `content`; index
    // that, not the envelope's own note, which is the same in every row.
    const returned = `
        SELECT CASE
            WHEN json_type(p.value, '$.functionCall') = 'object'
                THEN '[tool call: ' || COALESCE(json_extract(p.value, '$.functionCall.name'), 'unknown') || '] '
                    || substr(COALESCE(json_extract(p.value, '$.functionCall.args'), ''), 1, ${FTS_TOOL_RESULT_CHARS})
            WHEN json_type(p.value, '$.functionResponse') = 'object'
                THEN '[tool result: ' || COALESCE(json_extract(p.value, '$.functionResponse.name'), 'unknown') || '] '
                    || substr(COALESCE(
                        json_extract(p.value, '$.functionResponse.response.content'),
                        json_extract(p.value, '$.functionResponse.response'), ''), 1, ${FTS_TOOL_RESULT_CHARS})
        END AS piece FROM ${parts} ORDER BY p.id`;
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
    db.prepare('DELETE FROM agent_settings WHERE key IN (?, ?)').run(BACKFILL_FLAG, SCHEMA_FLAG);
}

/**
 * A hash of the SQL that builds and feeds the index. SQLite keeps a trigger's
 * text as it was first created, so after an edit to `columnsSql` an old
 * database would index new rows by the old rules, and never re-index the old
 * ones. The caller stores this value and rebuilds the index when it changes.
 * @returns {string}
 */
function schemaFingerprint() {
    const n = columnsSql('NEW');
    return crypto.createHash('sha1').update([n.body, n.tool, FTS_TOKENIZE].join('\n')).digest('hex').slice(0, 16);
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
            body, tool, tokenize = '${FTS_TOKENIZE}');

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
 * The MATCH strings for one query. Every token is quoted, so nothing the
 * caller typed is read as FTS5 syntax.
 *
 * A typed word can hold more than one index token: the index splits on every
 * separator, so `17.4.1.5` is `17 4 1 5` and `AB-1234` is `ab 1234`. Each word
 * becomes one phrase and keeps all its pieces. A plain word of four letters or
 * more also matches as a prefix, because the index has no stemming and the
 * owner writes in two languages: `tyre` finds `tyres`, `reunion` finds
 * `reuniones`. A number never does: `50` must not find `500`.
 *
 * - `phrase`: the words in the order typed, exact. Null when `all` says the same.
 * - `all`: every word, in any order.
 * - `any`: any one word. The last resort.
 * @param {string} query
 * @returns {{ phrase: string|null, all: string|null, any: string|null }}
 */
function matchLevels(query) {
    const none = { phrase: null, all: null, any: null };
    let words = [...new Set(String(query ?? '').toLowerCase().split(/\s+/)
        .map(w => (w.match(/[\p{L}\p{N}]+/gu) || []).join(' '))
        .filter(Boolean))];
    // A one-letter word counts beside others ("plan b"); alone it says nothing.
    const long = (w) => w.replace(/ /g, '').length >= 2;
    if (!words.some(long)) return none;
    if (words.length > FTS_MAX_QUERY_WORDS) {
        // Over the cap, the short words go first: they are the stop words.
        const keep = new Set([...words].sort((a, b) => b.length - a.length).slice(0, FTS_MAX_QUERY_WORDS));
        words = words.filter(w => keep.has(w));
    }
    const plain = (w) => /^\p{L}+$/u.test(w);
    const term = (w, minChars) => `"${w}"${plain(w) && w.length >= minChars ? '*' : ''}`;
    const all = words.map(w => term(w, FTS_PREFIX_MIN_CHARS)).join(' ');
    const phrase = `"${words.join(' ')}"`;
    return {
        phrase: phrase === all ? null : phrase,
        all,
        any: words.filter(long).map(w => term(w, FTS_PREFIX_MIN_CHARS)).join(' OR '),
    };
}

/**
 * Ranked search, in four passes over one answer:
 * 1. the exact phrase, best first, for up to half the answer;
 * 2. the newest rows where the words were SAID (the `body` column), for up
 *    to half. `bm25` favours short rows, so on a topic that comes back often
 *    it put yesterday's long message last, and the model read the old date;
 * 3. every word, best first, to fill what is left;
 * 4. any one word, only when pass 2 found nothing said. A stray hit in a
 *    tool dump must not end the search.
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {{ limit?: number, chatId?: string, notChatId?: string, notChatIds?: string[], role?: string, from?: string, to?: string }} [opts]
 *   `from` and `to` are local days, YYYY-MM-DD, both inclusive.
 * @returns {Array<{ id: string, chat_id: string, role: string, timestamp: string, content: string }>}
 */
function searchMessagesFts(db, query, { limit = 10, chatId, notChatId, notChatIds, role, from, to } = {}) {
    const levels = matchLevels(query);
    const max = Math.max(1, Math.min(Number(limit) || 10, 50));
    if (!levels.all) return [];

    const where = ['messages_fts MATCH ?'];
    const params = [];
    if (chatId) { where.push('msg.chat_id = ?'); params.push(chatId); }
    if (notChatId) { where.push('(msg.chat_id IS NULL OR msg.chat_id != ?)'); params.push(notChatId); }
    if (Array.isArray(notChatIds) && notChatIds.length > 0) {
        where.push(`(msg.chat_id IS NULL OR msg.chat_id NOT IN (${notChatIds.map(() => '?').join(', ')}))`);
        params.push(...notChatIds);
    }
    if (role) { where.push('msg.role = ?'); params.push(role); }
    if (from) { where.push("date(msg.timestamp, 'localtime') >= ?"); params.push(from); }
    if (to) { where.push("date(msg.timestamp, 'localtime') <= ?"); params.push(to); }

    const select = (order) => db.prepare(`
        SELECT msg.id, msg.chat_id, msg.role, msg.timestamp,
            snippet(messages_fts, -1, '', '', '…', ${FTS_SNIPPET_TOKENS}) AS content
        FROM messages_fts
        JOIN messages_fts_map map ON map.fts_id = messages_fts.rowid
        JOIN messages msg ON msg.id = map.msg_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ?
    `);
    const best = select(`bm25(messages_fts, ${FTS_WEIGHTS.body}, ${FTS_WEIGHTS.tool}), msg.timestamp DESC`);
    const newest = select('msg.timestamp DESC');

    const found = new Map();
    const excerpt = (value) => {
        const text = String(value || '');
        if (text.length <= FTS_EXCERPT_CHARS) return text;
        let cut = text.slice(0, FTS_EXCERPT_CHARS - 1);
        // Never leave half of an emoji at the cut.
        if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
        return `${cut}…`;
    };
    const take = (rows, room) => {
        let taken = 0;
        for (const row of rows) {
            if (taken >= room || found.size >= max) break;
            if (found.has(row.id)) continue;
            found.set(row.id, { ...row, content: excerpt(row.content) });
            taken++;
        }
    };

    const half = Math.ceil(max / 2);
    if (levels.phrase) take(best.all(levels.phrase, ...params, half), half);
    const said = newest.all(`{body} : (${levels.all})`, ...params, max);
    take(said, half);
    if (found.size < max) take(best.all(levels.all, ...params, max), max);
    if (said.length === 0 && found.size < max) take(best.all(levels.any, ...params, max), max);
    return [...found.values()];
}

module.exports = {
    FTS_TOOL_RESULT_CHARS, FTS_EXCERPT_CHARS, BACKFILL_FLAG, SCHEMA_FLAG, BACKFILL_BATCH,
    columnsSql, createMessagesFts, dropMessagesFts, schemaFingerprint, backfillRange, matchLevels, searchMessagesFts,
};
