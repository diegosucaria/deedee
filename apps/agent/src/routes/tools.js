const express = require('express');
const crypto = require('crypto');

const { toolDefinitions } = require('../tools-definition');
const { ApprovalService } = require('../services/approval-service');
const { classifyToolResult, TurnTaint } = require('../utils/untrusted-content');
const { filterCalendarResult } = require('../utils/calendar-filter');

// What a live session has read. Each tool call arrives on its own request, so
// there is no run to carry taint: this stands in for one.
//
// The live page sends a session id with every call. A mark then lasts for the
// whole call: it used to age out after 15 minutes, and a call runs for 30, so
// the same call got the owner's consent back with the email still in the
// model's context. A page that sends no id (an old tab) shares one mark that
// lasts 15 minutes after the LAST call, not after the last read.
const LIVE_TAINT_MS = 15 * 60 * 1000;
const LIVE_SESSION_MS = 6 * 60 * 60 * 1000;
const LIVE_SESSIONS_KEPT = 8;
const NO_SESSION = '(no session id)';
const liveSessions = new Map(); // session id -> { taint: TurnTaint, at: number }

function sessionKey(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    return /^[A-Za-z0-9._-]{8,64}$/.test(id) ? id : NO_SESSION;
}

function currentLiveTaint(now = Date.now(), sessionId = null) {
    const key = sessionKey(sessionId);
    const entry = liveSessions.get(key);
    if (!entry) return null;
    const maxAge = key === NO_SESSION ? LIVE_TAINT_MS : LIVE_SESSION_MS;
    if (now - entry.at > maxAge) { liveSessions.delete(key); return null; }
    return entry.taint.tainted ? entry.taint : null;
}

/** A call was made in this session: a shared mark stays alive while calls keep coming. */
function touchLiveSession(sessionId, now = Date.now()) {
    // An expired mark is dropped here, not revived.
    if (!currentLiveTaint(now, sessionId)) return;
    liveSessions.get(sessionKey(sessionId)).at = now;
}

function markLiveRead(sessionId, label, now = Date.now()) {
    const key = sessionKey(sessionId);
    let entry = liveSessions.get(key);
    if (!entry || !currentLiveTaint(now, sessionId)) {
        entry = { taint: new TurnTaint([]), at: now };
        liveSessions.delete(key);
        liveSessions.set(key, entry);
        while (liveSessions.size > LIVE_SESSIONS_KEPT) liveSessions.delete(liveSessions.keys().next().value);
    }
    entry.taint.add(label);
    entry.at = now;
    return entry.taint;
}

function noteLiveResult(toolName, args, result, serverName, now = Date.now(), sessionId = null) {
    let verdict;
    try {
        verdict = classifyToolResult(toolName, { serverName, args, result });
    } catch {
        verdict = { untrusted: true, kind: 'an unknown tool' };
    }
    if (!verdict.untrusted) return;
    const taint = markLiveRead(sessionId, `${verdict.kind} (${toolName})`, now);
    try { taint.observe(toolName, verdict.kind, args, result); } catch { /* metadata only */ }
}

/** Tests and a restart start the live session clean. */
function resetLiveTaint() {
    liveSessions.clear();
}

function createToolRouter(agent) {
    const router = express.Router();

    // --- Live Tool Sync ---
    router.get('/internal/tools', async (req, res) => {
        if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const mcpTools = await agent.mcp.getTools();

            // Extract internal tools from Gemini definition format
            const internalTools = toolDefinitions.flatMap(def => def.functionDeclarations || []);

            // Merge both lists
            const allTools = [...internalTools, ...mcpTools];

            res.json({ tools: allTools });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/internal/mcp/status', async (req, res) => {
        if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const servers = await agent.mcp.getStatus();
            res.json({ servers });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The live voice session runs tools through this route instead of the chat
    // loop, so the loop's gate never saw them: the deny-list, the safety rules,
    // the floor and the guardian all sat in the loop. They run here too now.
    // A paused call sends its card to the owner's notification channel (a live
    // session is not a chat he can answer in), and the model reads the same
    // "Action PAUSED" text it reads in a chat.
    //
    // A voice call is the owner's own chat (his decision, 2026-09-20): only
    // his logged-in web session reaches this route, through the gateway, which
    // proves itself with the internal token. So what he asks for in a call is
    // his approval, as in a chat: the floor still asks once, the safety rules
    // still ask, and once the session has read third-party text (an email, a
    // web page) his word stops covering outward actions, as in a chat. With
    // no token checked (a dev setup) the call stays "unknown, which asks".
    router.post('/tools/execute', async (req, res) => {
        if (!agent || !agent.toolExecutor) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const { name, args, sessionId = null, readWeb = false } = req.body;
            console.log(`[Agent] Executing tool request from Live Client: ${name}`, args);
            touchLiveSession(sessionId);
            // Google's built-in search answers the model directly; its text
            // never comes through this route. The page sees it and says so.
            if (readWeb === true) markLiveRead(sessionId, 'web search results (the call\'s own search)');

            const ownerSession = req.internalAuth === true;
            const message = { role: 'user', content: `[live] ${name}`, source: 'live', metadata: { chatId: 'live-session', ownerSession } };
            // Context simulation for the tool executor
            const context = {
                message,
                sendCallback: async (msg) => console.log('[Agent] Live Tool Output:', msg), // No-op for direct response
                processMessage: agent.processMessage,
                callServices: { client: agent.client, interface: agent.interface }
            };

            if (agent.approvals && typeof agent.approvals.review === 'function') {
                const run = ApprovalService.newRun(crypto.randomUUID());
                const serverName = agent.mcp?.toolMap?.get?.(name)?.name || null;
                // The call's audio never passes through here; what the session
                // READ does, as tool results, and currentLiveTaint() keeps it
                // for 15 minutes. That stands in for a chat's history. Without
                // a checked token nothing is known, which asks.
                const liveTaintNow = currentLiveTaint(Date.now(), sessionId);
                const review = await agent.approvals.review({
                    message, toolName: name, args, serverName, run, taint: liveTaintNow,
                    historyUntrusted: ownerSession ? !!liveTaintNow : null,
                    foreignText: ownerSession ? false : null
                });
                if (!review.run) {
                    console.log(`[Agent] Live tool ${name} held by the approval gate (${review.status}).`);
                    return res.json({ result: review.result, gated: true, status: review.status });
                }
            } else {
                console.warn('[Agent] Approvals unavailable; refusing the live tool call.');
                return res.status(503).json({ error: 'Approvals not initialized' });
            }

            const raw = await agent.toolExecutor.execute(name, args, context);
            // What this session has read now counts for the calls that follow.
            noteLiveResult(name, args, raw, agent.mcp?.toolMap?.get?.(name)?.name || null, Date.now(), sessionId);
            // A call reads the same calendars a chat does: the ones he ticked.
            let result = raw;
            try {
                result = filterCalendarResult(name, raw, agent.settings, agent.mcp?.toolMap, args, agent.mcp?.config);
            } catch (e) {
                console.warn(`[Agent] Live calendar result not filtered (${name}): ${e.message}`);
            }
            res.json({ result });
        } catch (error) {
            console.error('[Agent] Live Tool Execution Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createToolRouter, resetLiveTaint, LIVE_TAINT_MS };
