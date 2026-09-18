/**
 * The four tools that read and write the owner's facts. They live here, not
 * in the agent, because two paths reach them: a chat turn through
 * Agent._executeTool, and a voice call through /tools/execute, which goes to
 * the tool executor and never touches the agent's own branches. A tool that
 * only the agent knew about was a dead tool on a voice call.
 *
 * They need nothing but the database.
 */

const FACT_TOOLS = new Set(['rememberFact', 'getFact', 'updateFact', 'forgetFact']);

/**
 * @param {object} db - AgentDB
 * @param {string} name
 * @param {object} args
 * @returns {object|null} the tool's result, or null when it is not a fact tool
 */
function runFactTool(db, name, args = {}) {
    if (!FACT_TOOLS.has(name)) return null;

    if (name === 'rememberFact') {
        // Only the two kinds the index knows. 'state' would hide the fact for good.
        const kind = ['profile', 'note'].includes(String(args.kind || '')) ? args.kind : undefined;
        // Writing over a pinned key is a correction, so it goes through the
        // same guard as updateFact rather than round the side of it.
        const standing = db.getFact?.(args.key);
        if (standing?.pinned) {
            return { error: `'${args.key}' is pinned. Use updateFact with force: true, once the owner has asked for the change.` };
        }
        db.setKey(args.key, args.value, {
            source: 'tool', confidence: 'user_explicit',
            kind, summary: args.summary
        });
        return { success: true };
    }

    if (name === 'getFact') {
        const val = db.getKey(args.key);
        if (val !== null && val !== undefined) {
            db.touchFacts?.(args.key);
            return { value: val };
        }
        // Only a key match answers as the fact. A search also matches a word
        // inside another fact's value or summary, and stating one of those as
        // the answer reports a different fact than the one asked for.
        const byKey = db.findFacts?.(args.key, 5, { keysOnly: true }) || [];
        if (byKey.length === 1) {
            db.touchFacts?.(byKey[0].key);
            return { key: byKey[0].key, value: byKey[0].value, info: `No exact key '${args.key}'; this one is close.` };
        }
        // The prompt lists one line per fact, so the model often has a near
        // miss. Everything else is offered as a name to ask for, never as an
        // answer.
        const near = byKey.length > 1 ? byKey : (db.findFacts?.(args.key, 5) || []);
        if (near.length === 0) return { info: 'No fact with that key, and nothing close.' };
        return { info: `No exact key '${args.key}'. Closest keys: ${near.map(f => f.key).join(', ')}. Ask for one by name.` };
    }

    if (name === 'updateFact') {
        // By key only: a fact must never be rewritten because a word appears in
        // some other fact's value.
        const exact = db.getFact?.(args.key);
        const near = exact ? [exact] : (db.findFacts?.(args.key, 5, { keysOnly: true }) || []);
        if (near.length === 0) return { error: `No fact with a key like '${args.key}'. Use rememberFact to write a new one.` };
        if (near.length > 1) return { info: 'Several keys match; nothing changed.', candidates: near.map(f => f.key) };
        if (!exact) {
            // The key search matches anywhere in the key, so 'car' finds
            // 's-car-f'. One near match is a suggestion, not permission to
            // write over a fact he never named.
            return { info: `No fact is called '${args.key}'. Did you mean '${near[0].key}'? Call again with that exact key.`, candidates: [near[0].key] };
        }
        if (near[0].pinned && args.force !== true) {
            return { error: `'${near[0].key}' is pinned. Ask the owner, then call again with force: true.` };
        }
        // The old value goes to the same file a deletion writes, so a wrong
        // correction can be read back. A copy that failed to write is not a
        // copy: the tool says so rather than promising one.
        if (db.backupFact?.(near[0], 'updateFact') === false) {
            return { error: `Could not keep a copy of '${near[0].key}', so it was not changed.` };
        }
        db.setKey(near[0].key, args.value, { source: 'tool', confidence: 'user_explicit', summary: args.summary, kind: near[0].kind });
        return { success: true, key: near[0].key, ...(exact ? {} : { info: `Matched '${near[0].key}'.` }) };
    }

    // forgetFact. By key only, like updateFact.
    const exact = db.getFact?.(args.key);
    const matches = exact ? [exact] : (db.findFacts?.(args.key, 5, { keysOnly: true }) || []);
    if (matches.length === 0) return { error: `No fact with a key like '${args.key}'.` };
    if (matches.length > 1) return { info: 'Several keys match; nothing deleted.', candidates: matches.map(f => f.key) };
    if (!exact) {
        // As with updateFact: a near match names a fact, it does not choose one
        // to delete.
        return { info: `No fact is called '${args.key}'. Did you mean '${matches[0].key}'? Call again with that exact key.`, candidates: [matches[0].key] };
    }
    const row = matches[0];
    const kind = row.kind || 'profile';
    // A job's bookkeeping or a config row is not his to lose through a
    // conversation: deleting one breaks the job that keeps it.
    if (kind === 'state') {
        return { error: `'${row.key}' is state a job or a setting keeps, not a fact. Nothing deleted.` };
    }
    if ((row.pinned || kind === 'profile') && args.force !== true) {
        return { error: `'${row.key}' is ${row.pinned ? 'pinned' : 'a durable fact about the owner'}. Ask him, then call again with force: true.` };
    }
    // A copy goes to the file the nightly pruning writes, so nothing is lost
    // outright. If the copy could not be written, the fact stays: the reply
    // promises a copy, and it must be true.
    if (db.backupFact?.(row, 'forgetFact') === false) {
        return { error: `Could not keep a copy of '${row.key}', so nothing was deleted.` };
    }
    const gone = db.deleteFact?.(row.key);
    return gone ? { success: true, key: row.key, info: 'A copy is in data/pruned_memories.json.' } : { error: `Could not delete '${row.key}'.` };
}

module.exports = { FACT_TOOLS, runFactTool };
