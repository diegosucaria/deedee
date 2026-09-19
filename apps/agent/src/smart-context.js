const { createAssistantMessage } = require('@deedee/shared/src/types');
const { ConfigService } = require('./services/config-service');
const { isUntrustedEnvelope, classifyToolResult, wrapUntrusted } = require('./utils/untrusted-content');

// Old tool results in the history window. On the device they were about 80%
// of the window: one stale listJobs result of 42,000 characters was 62% of a
// chat's history, sent again on every call for days. The results of the last
// few tool rounds stay whole, since the model is often still working from
// them; an older one keeps its start and a note. The call and its response
// both stay, so the pairing the API checks is untouched.
const TRIM_KEEP_LAST_ROWS = 3;
const TRIM_OVER_CHARS = 1500;
const TRIM_PREVIEW_CHARS = 400;
const TRIM_PREVIEW_ITEMS = 10;

class SmartContextManager {
    constructor(db, client) {
        this.db = db;
        this.client = client;
        // Configuration
        this.TOKEN_THRESHOLD = parseInt(process.env.CONTEXT_TOKEN_THRESHOLD || '50000');
        // Do not build a new summary until this many messages follow the last one.
        this.MIN_NEW_MESSAGES = 20;
        this.config = new ConfigService();
        this.SUMMARY_MODEL = this.config.getModel('FLASH');
    }

    /**
     * Main entry point to get context for a chat.
     * Checks if summarization is needed first.
     */
    async getContext(chatId, modelType = 'PRO', { serverOf } = {}) {
        // 1. Check if we need to summarize
        await this.checkAndSummarize(chatId);

        // 2. Fetch Latest Summary
        const summary = this.db.getLatestSummary(chatId);

        // 3. Fetch Recent History
        // If we have a summary, we only need recent messages since the summary.
        // If no summary, we fetch standard limit.
        const limit = modelType === 'FLASH' ? 20 : 50;

        // If summary exists, we might want to fetch fewer, or only those after summary.created_at?
        // db.getHistoryForChat uses a sliding window; summary acts as long-term memory injection
        // We should just fetch the limit. The summary acts as the "Long Term Memory" injection.

        // Saved rows carry raw parts (tool calls, tool results, media). Make
        // them safe for the model before anything else touches them.
        const recentHistory = SmartContextManager.trimOldToolResults(
            SmartContextManager.normalizeHistoryForModel(this.db.getHistoryForChat(chatId, limit)),
            serverOf ? { serverOf } : {});

        // INJECT TIMESTAMPS
        // The model receives raw text history. To give it temporal awareness we
        // prepend the timestamp to the owner's rows. Its own rows stay bare:
        // stamped replies taught it to write a stamp of its own, and only the
        // final reply is cleaned (stripLeadingStamp in agent.js), so a stamp it
        // wrote into a message to a contact or into speech would go out as is.
        // The current time reaches it every turn in the system prompt anyway.
        // The row id is for bookkeeping only; keep it out of the model history.
        const timestampedHistory = recentHistory.map(({ id, ...msg }) => {
            if (msg.timestamp && msg.role === 'user') {
                const date = new Date(msg.timestamp);
                // Format: [02/04 10:00]
                const month = (date.getMonth() + 1).toString().padStart(2, '0');
                const day = date.getDate().toString().padStart(2, '0');
                const hours = date.getHours().toString().padStart(2, '0');
                const mins = date.getMinutes().toString().padStart(2, '0');
                const timeStr = `[${month}/${day} ${hours}:${mins}]`;

                // Clone to avoid mutating shared state if any
                const newMsg = { ...msg, parts: [...msg.parts] };
                if (newMsg.parts.length > 0 && newMsg.parts[0].text) {
                    newMsg.parts[0] = { ...newMsg.parts[0], text: `${timeStr} ${newMsg.parts[0].text}` };
                }
                return newMsg;
            }
            return msg;
        });

        // 4. Inject Summary as user/model pair for proper Gemini turn alternation
        if (summary) {
            const summaryUserMsg = {
                role: 'user',
                parts: [{
                    text: `[SYSTEM: Context Summary from earlier conversation]\n${summary.content}`
                }]
            };
            const summaryAckMsg = {
                role: 'model',
                parts: [{
                    text: 'Understood. I have the context from our earlier conversation and will maintain continuity.'
                }]
            };
            return SmartContextManager.ensureAlternation([summaryUserMsg, summaryAckMsg, ...timestampedHistory]);
        }

        return SmartContextManager.ensureAlternation(timestampedHistory);
    }

    /**
     * Shorten old, large tool results in a history window. Pure: returns new
     * rows and new parts for the ones it changes.
     *
     * - The results of the last `keepLastRows` tool rounds stay whole. A round
     *   is one row of responses: parallel calls answer in one row, and they
     *   belong together.
     * - An older result over `overChars` keeps its first `previewChars` and a
     *   note. The note never says to call the tool again: the tool may send,
     *   book or push.
     * - The verdict "a third party wrote this" is kept. An untrusted envelope
     *   stays one, with only its `content` cut and the note outside `content`,
     *   where the model is told to trust nothing. A plain result is judged
     *   BEFORE it is cut, because for some tools the verdict is read from the
     *   body (searchMemory, sub-agent reports, Home Assistant calendar text),
     *   and one that was third-party text is wrapped as such. The rules that
     *   hold back the owner's word read that mark.
     * - The approval gate's own results (one key, info or error) are left
     *   alone, so they are still recognised as ours.
     * - HISTORY_TRIM=0 turns it off.
     * @param {Array} history
     * @param {{ keepLastRows?: number, overChars?: number, previewChars?: number, serverOf?: (name: string) => string|null }} [opts]
     */
    static trimOldToolResults(history, { keepLastRows = TRIM_KEEP_LAST_ROWS, overChars = TRIM_OVER_CHARS, previewChars = TRIM_PREVIEW_CHARS, serverOf = () => null } = {}) {
        if (!Array.isArray(history) || String(process.env.HISTORY_TRIM || '1') === '0') return history;
        const isRound = (msg) => Array.isArray(msg?.parts) && msg.parts.some(p => p && p.functionResponse);
        const rounds = history.filter(isRound).length;
        if (rounds <= keepLastRows) return history;

        const size = (value) => { try { return JSON.stringify(value ?? null).length; } catch { return 0; } };
        const slice = (text, chars) => {
            const cut = text.slice(0, chars);
            // A cut can land inside an emoji; drop the half that is left.
            return typeof cut.toWellFormed === 'function' ? cut.toWellFormed() : cut;
        };
        // The list a result holds: the result itself, or its one array field.
        const listIn = (value) => {
            if (Array.isArray(value)) return value;
            if (!value || typeof value !== 'object') return null;
            const arrays = Object.values(value).filter(Array.isArray);
            return arrays.length === 1 ? arrays[0] : null;
        };
        const head = (value) => {
            // An MCP result is { output: "<text>" }: show the text, not its escaped wrapper.
            const inner = value && typeof value === 'object' && !Array.isArray(value)
                && Object.keys(value).length === 1 && typeof value.output === 'string' ? value.output : value;
            const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
            // A list shows the start of each entry, not 400 characters of the
            // first: one job's long prompt used to hide every other job's name.
            const list = listIn(inner);
            if (list && list.length > 1) {
                const shown = Math.min(list.length, TRIM_PREVIEW_ITEMS);
                const each = Math.max(40, Math.floor(previewChars / shown));
                const rows = list.slice(0, shown).map(item => `${slice(text(item), each)}${text(item).length > each ? ' …' : ''}`);
                return `${list.length} entries; the first ${shown}, each cut short:\n${rows.join('\n')}\n…[cut]`;
            }
            // The mark shows where it was cut, so a cut number is not read as a whole one.
            return `${slice(text(inner), previewChars)} …[cut]`;
        };
        const isGateText = (response) => {
            const keys = response && typeof response === 'object' && !Array.isArray(response) ? Object.keys(response) : [];
            return keys.length === 1 && (keys[0] === 'info' || keys[0] === 'error');
        };

        let round = 0;
        return history.map((msg) => {
            if (!isRound(msg)) return msg;
            round++;
            if (round > rounds - keepLastRows) return msg;
            let changed = false;
            const parts = msg.parts.map((p) => {
                if (!p || !p.functionResponse) return p;
                const response = p.functionResponse.response;
                const enveloped = isUntrustedEnvelope(response);
                // The envelope's own fields are ours: only what the tool returned counts.
                const chars = size(enveloped ? response.content : response);
                if (chars <= overChars || isGateText(response)) return p;
                const name = p.functionResponse.name;
                const note = `Older tool result shortened to save context (it was ${chars} characters). If you need the rest, fetch it again with a read-only call. Never repeat an action (a send, a booking, a push) just to see its result. The preview is not the whole result: never send or quote it as if it were.`;
                let shorter;
                if (enveloped) {
                    shorter = { ...response, shortened: true, shortenedNote: note, content: { preview: head(response.content) } };
                } else {
                    let verdict;
                    try { verdict = classifyToolResult(name, { serverName: serverOf(name), args: {}, result: response }); }
                    catch { verdict = { untrusted: true, kind: 'an unknown tool' }; }
                    shorter = verdict.untrusted
                        ? { ...wrapUntrusted(name, { preview: head(response) }, verdict.kind), shortened: true, shortenedNote: note }
                        : { shortened: true, note, preview: head(response) };
                }
                changed = true;
                return { ...p, functionResponse: { ...p.functionResponse, response: shorter } };
            });
            return changed ? { ...msg, parts } : msg;
        });
    }

    /**
     * Make hydrated history safe for the model. Pure: returns new rows.
     *
     * Rows come straight from the DB window, so the window can cut a tool
     * exchange in half or hold calls the agent never answered (duplicates it
     * dropped, loop limits, aborts). Gemini rejects such history with 400.
     *
     * - A "call row" is a model row with functionCall parts. A "response row"
     *   is a user/function row with functionResponse parts.
     * - A call row must be followed by a response row; only calls with a
     *   matching response (by name, in order) survive, and the response row
     *   keeps only those matches. Unpaired call rows and orphan response rows
     *   are dropped.
     * - inlineData parts (images, voice notes) become a short text marker so
     *   media is not re-uploaded on every turn. The live turn's message never
     *   passes through here.
     * - Leading rows are dropped until the first user row with text, so the
     *   result starts with a plain user text row. Rows with no parts are gone.
     */
    static normalizeHistoryForModel(history) {
        if (!Array.isArray(history) || history.length === 0) return [];

        const rows = [];
        for (const msg of history) {
            if (!msg || !Array.isArray(msg.parts)) continue;
            const parts = SmartContextManager._replaceInlineData(msg.parts);
            if (parts.length > 0) rows.push({ ...msg, parts });
        }

        const isCall = (p) => !!(p && p.functionCall);
        const isResponse = (p) => !!(p && p.functionResponse);
        const isCallRow = (m) => m.role === 'model' && m.parts.some(isCall);
        const isResponseRow = (m) => (m.role === 'user' || m.role === 'function') && m.parts.some(isResponse);

        const paired = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (isResponseRow(row)) continue; // orphan: its call row was not kept
            if (!isCallRow(row)) { paired.push(row); continue; }

            const next = rows[i + 1];
            if (!next || !isResponseRow(next)) continue; // unanswered call row

            const matched = SmartContextManager._matchCallsToResponses(row.parts, next.parts);
            if (matched.calls.length === 0) continue; // nothing answered; the response row falls out as an orphan

            paired.push({ ...row, parts: row.parts.filter(p => !isCall(p) || matched.calls.includes(p)) });
            paired.push({ ...next, parts: next.parts.filter(p => !isResponse(p) || matched.responses.includes(p)) });
            i++; // the response row is consumed
        }

        const hasText = (m) => m.parts.some(p => p && typeof p.text === 'string' && p.text.length > 0);
        let start = 0;
        while (start < paired.length && !(paired[start].role === 'user' && hasText(paired[start]))) start++;
        return paired.slice(start);
    }

    /**
     * Pair functionCall parts with functionResponse parts by name, in order.
     * Responses are a subsequence of the calls (the agent drops duplicate
     * calls before running them), so each response takes the first unused
     * call with the same name that comes after the previous match.
     */
    static _matchCallsToResponses(callParts, responseParts) {
        const calls = callParts.filter(p => p && p.functionCall);
        const responses = responseParts.filter(p => p && p.functionResponse);
        const matchedCalls = [];
        const matchedResponses = [];
        let from = 0;
        for (const resp of responses) {
            const idx = calls.findIndex((c, i) => i >= from && c.functionCall.name === resp.functionResponse.name);
            if (idx === -1) continue;
            matchedCalls.push(calls[idx]);
            matchedResponses.push(resp);
            from = idx + 1;
        }
        return { calls: matchedCalls, responses: matchedResponses };
    }

    /**
     * Swap inlineData parts for a text marker, folded into the previous text
     * part when there is one. Drops empty or malformed parts.
     */
    static _replaceInlineData(parts) {
        const out = [];
        for (const part of parts) {
            if (!part || typeof part !== 'object' || Object.keys(part).length === 0) continue;
            if (!part.inlineData) { out.push(part); continue; }

            const mime = String(part.inlineData.mimeType || '');
            const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file';
            const marker = `[${kind} attached]`;
            const prev = out[out.length - 1];
            if (prev && typeof prev.text === 'string' && Object.keys(prev).length === 1) {
                out[out.length - 1] = { text: prev.text ? `${prev.text} ${marker}` : marker };
            } else {
                out.push({ text: marker });
            }
        }
        return out;
    }

    /**
     * Ensures strict user/model turn alternation required by Gemini.
     * - Drops leading model messages (history must start with 'user').
     * - Merges consecutive same-role messages by combining their parts.
     *
     * Without this, injecting summary user/model pair before history that
     * starts with a 'model' message would cause two consecutive model turns,
     * triggering Gemini's 400 error.
     */
    static ensureAlternation(messages) {
        if (!messages || messages.length === 0) return [];

        // Step 1: Drop leading model messages (history must start with 'user')
        let startIdx = 0;
        while (startIdx < messages.length && messages[startIdx].role === 'model') {
            startIdx++;
        }
        if (startIdx >= messages.length) return [];

        const trimmed = messages.slice(startIdx);

        // Step 2: Merge consecutive same-role messages
        const merged = [];
        for (const msg of trimmed) {
            if (merged.length === 0) {
                merged.push({ ...msg, parts: [...msg.parts] });
                continue;
            }

            const prev = merged[merged.length - 1];
            if (prev.role === msg.role) {
                // Merge: append parts from current message into previous
                prev.parts = [...prev.parts, ...msg.parts];
            } else {
                merged.push({ ...msg, parts: [...msg.parts] });
            }
        }

        return merged;
    }

    async checkAndSummarize(chatId) {
        // Simple Heuristic: If total messages > 50, or check token usage logs?
        // Better: Check raw text length of last 50 messages.
        // Fast estimation: 4 chars ~= 1 token.

        // Fetch extended history to estimate token count. The summary window
        // skips oversized parts (media blobs) at the SQL level when the db
        // offers it; the plain history is the fallback.
        const deepHistory = typeof this.db.getHistoryForSummary === 'function'
            ? this.db.getHistoryForSummary(chatId, 100)
            : this.db.getHistoryForChat(chatId, 100);
        if (deepHistory.length < 20) return; // Too short to summarize

        // Gate: wait for enough new messages after the last summary. Without
        // this every message past the threshold produced a fresh summary.
        if (!this.hasEnoughNewMessages(chatId, deepHistory)) return;

        const estimatedTokens = SmartContextManager.estimateTokens(deepHistory);

        if (estimatedTokens > this.TOKEN_THRESHOLD) {
            console.log(`[SmartContext] Chat ${chatId} exceeds threshold (${Math.round(estimatedTokens)} tokens). Summarizing...`);
            await this.performSummarization(chatId, deepHistory);
        }
    }

    /**
     * Rough token estimate (4 chars per token) of what the model would see:
     * media parts count as their marker, not their base64 payload. Before
     * this, one photo in the window tripped the threshold on its own.
     */
    static estimateTokens(history) {
        // The stored window, not the shortened one that goes out: the summary
        // trigger asks how much has happened in the chat. Measured after the
        // cut, a chat full of tool results never reached it again.
        return JSON.stringify(SmartContextManager.normalizeHistoryForModel(history)).length / 4;
    }

    /**
     * True when at least MIN_NEW_MESSAGES messages follow the last summary.
     * summaries.range_end holds the id of the last message that summary covered.
     * Older summaries stored a timestamp there; those fall through and allow
     * one more run, which then records a proper id.
     */
    hasEnoughNewMessages(chatId, history) {
        const last = this.db.getLatestSummary(chatId);
        if (!last || !last.range_end) return true;

        let since = null;
        const idx = history.findIndex(m => m.id === last.range_end);
        if (idx !== -1) {
            since = history.length - idx - 1;
        } else if (typeof this.db.countMessagesAfter === 'function') {
            since = this.db.countMessagesAfter(chatId, last.range_end);
        }
        if (since === null) return true;
        return since >= this.MIN_NEW_MESSAGES;
    }

    /**
     * Render one history message as a line of plain text for the summary prompt.
     * Text parts run together as one string; tool parts become short markers
     * set off by a space.
     */
    static renderMessageText(msg) {
        const parts = Array.isArray(msg.parts) ? msg.parts : [];
        let out = '';
        for (const p of parts) {
            if (!p) continue;
            if (typeof p.text === 'string' && p.text.length > 0) {
                out += p.text;
            } else if (p.functionCall) {
                out += ` [tool: ${p.functionCall.name || 'unknown'}] `;
            } else if (p.functionResponse) {
                out += ` [tool result: ${p.functionResponse.name || 'unknown'}] `;
            }
        }
        return out.replace(/ {2,}/g, ' ').trim();
    }

    async performSummarization(chatId, history) {
        try {
            // Keep the last 10 messages intact (don't summarize them yet), summarize the older ones.
            const attemptsToSummarize = history.slice(0, history.length - 10);
            if (attemptsToSummarize.length < 5) return; // Not enough to summarize

            // Format for Flash: text parts only, tool parts as short markers.
            const conversationText = attemptsToSummarize
                .map(m => ({ role: m.role, text: SmartContextManager.renderMessageText(m) }))
                .filter(m => m.text)
                .map(m => `[${m.role.toUpperCase()}]: ${m.text}`)
                .join('\n');
            if (!conversationText) return;
            const prompt = `
            Compress the following conversation into a concise, high-level summary. 
            Focus on:
            1. What goals were accomplished?
            2. What key technical decisions were made?
            3. What is the current state of the system?
            4. Any specific file paths or variable names mentioned that are critical.
            
            CONVERSATION:
            ${conversationText}
            `;

            // Use @google/genai SDK pattern (models.generateContent)
            const thinking = this.config.getThinkingConfig('FLASH', 'summarization', { model: this.SUMMARY_MODEL });
            const result = await this.client.models.generateContent({
                model: this.SUMMARY_MODEL,
                contents: [{ parts: [{ text: prompt }] }],
                ...(thinking ? { config: { thinkingConfig: thinking } } : {})
            });
            let summaryText = '';
            try {
                summaryText = result.candidates[0].content.parts.map(p => p.text).join(' ');
            } catch (e) {
                console.error('[SmartContext] Failed to extract summary text:', e);
            }

            if (summaryText) {
                // Save Summary with real token usage
                const usage = result.usageMetadata;
                const originalTokens = usage?.promptTokenCount || 0;
                const summaryTokens = usage?.candidatesTokenCount || 0;

                this.config.logUsageFromResponse(this.db, this.SUMMARY_MODEL, result, chatId, 'summarization');

                // range_start / range_end hold message ids; range_end feeds the
                // "enough new messages" gate on the next run.
                const first = attemptsToSummarize[0];
                const lastMsg = attemptsToSummarize[attemptsToSummarize.length - 1];
                const start = first.id || first.timestamp || new Date().toISOString();
                const end = lastMsg.id || lastMsg.timestamp || new Date().toISOString();

                this.db.saveSummary(chatId, summaryText, start, end, originalTokens, summaryTokens);

                console.log(`[SmartContext] Summary created for ${chatId}. Compressed ${originalTokens} -> ${summaryTokens} tokens.`);
            }

        } catch (error) {
            console.error('[SmartContext] Summarization failed:', error);
        }
    }

    getStats() {
        const stats = this.db.getSummaryStats();
        // Specific metric: Real saved tokens
        const estimatedTokensSaved = stats.totalOriginal - stats.totalSummary;

        return {
            totalSummaries: stats.totalCount,
            estimatedTokensSaved
        };
    }

    getSummaries(limit) {
        return this.db.getSummaries(limit);
    }

    clearSummaries() {
        this.db.clearSummaries();
    }
}

module.exports = { SmartContextManager };
