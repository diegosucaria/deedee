const express = require('express');

/**
 * /internal/guardian: the approval guardian's history, stats, policy, dry
 * run and owner feedback. Behind DEEDEE_INTERNAL_TOKEN like every /internal
 * route; the web app reaches it through the API gateway at /v1/guardian.
 */
const OUTCOMES = ['auto_allowed', 'auto_denied', 'escalated', 'escalated_approved', 'escalated_denied', 'escalated_expired',
    'escalated_failed', 'deny_list', 'breaker_stop', 'ran_unasked', 'owner_instructed', 'escalated_duplicate'];
const RISKS = ['low', 'medium', 'high'];
const SOURCE_KINDS = ['chat', 'job', 'watcher', 'subagent', 'system'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

/** A comma list where every item is allowed, or null. */
function pickList(value, allowed) {
    if (value === undefined || value === null || value === '') return undefined;
    const items = String(value).split(',').map(s => s.trim()).filter(Boolean);
    if (items.length === 0 || items.some(i => !allowed.includes(i))) return null;
    return items.join(',');
}

function createGuardianRouter(agent) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!agent || !agent.approvals) return res.status(503).json({ error: 'Approvals not initialized' });
        next();
    });

    const db = () => agent.approvals.db;
    const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

    // GET /internal/guardian/history?outcome=&tool=&risk=&sourceKind=&from=&to=&limit=&offset=
    router.get('/history', (req, res) => {
        try {
            const outcome = pickList(req.query.outcome, OUTCOMES);
            const risk = pickList(req.query.risk, RISKS);
            const sourceKind = pickList(req.query.sourceKind ?? req.query.source_kind, SOURCE_KINDS);
            if (outcome === null) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
            if (risk === null) return res.status(400).json({ error: `risk must be one of ${RISKS.join(', ')}` });
            if (sourceKind === null) return res.status(400).json({ error: `sourceKind must be one of ${SOURCE_KINDS.join(', ')}` });
            for (const k of ['from', 'to']) {
                if (req.query[k] && !DAY_RE.test(String(req.query[k]))) return res.status(400).json({ error: `${k} must be a date (YYYY-MM-DD)` });
            }
            const tool = req.query.tool ? String(req.query.tool).slice(0, 200) : undefined;
            res.json(db().listGuardianDecisions({
                outcome, risk, sourceKind, tool, from: req.query.from, to: req.query.to,
                limit: req.query.limit, offset: req.query.offset
            }));
        } catch (e) { fail(res, e); }
    });

    // GET /internal/guardian/history/:id -> one row with the exact input the guardian saw
    router.get('/history/:id', (req, res) => {
        try {
            const row = db().getGuardianDecision(req.params.id);
            if (!row) return res.status(404).json({ error: 'No such decision' });
            res.json(row);
        } catch (e) { fail(res, e); }
    });

    // GET /internal/guardian/stats?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 30 days)
    router.get('/stats', (req, res) => {
        try {
            for (const k of ['from', 'to']) {
                if (req.query[k] && !DAY_RE.test(String(req.query[k]))) return res.status(400).json({ error: `${k} must be a date (YYYY-MM-DD)` });
            }
            const from = req.query.from || new Date(Date.now() - 29 * 86400e3).toISOString().slice(0, 10);
            res.json(db().guardianStats({ from, to: req.query.to || null }));
        } catch (e) { fail(res, e); }
    });

    // GET /internal/guardian/policy -> { mode, smart_policy, always_ask, floor (read-only), categories, feedbackCandidates }
    router.get('/policy', (req, res) => {
        try { res.json(agent.approvals.policyView()); } catch (e) { fail(res, e); }
    });

    // PUT /internal/guardian/policy { mode?, smart_policy?, always_ask? }. The floor cannot be changed.
    router.put('/policy', (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
            if (!body) return res.status(400).json({ error: 'Body must be { mode?, smart_policy?, always_ask? }' });
            if (body.smart_policy !== undefined && typeof body.smart_policy !== 'string') {
                return res.status(400).json({ error: 'smart_policy must be a string' });
            }
            if (body.always_ask !== undefined && !Array.isArray(body.always_ask) && typeof body.always_ask !== 'string') {
                return res.status(400).json({ error: 'always_ask must be a list of tool globs or category ids' });
            }
            const view = agent.approvals.updatePolicy({ mode: body.mode, smart_policy: body.smart_policy, always_ask: body.always_ask });
            if (agent.interface?.broadcast) agent.interface.broadcast('entity:update', { type: 'setting', key: 'approvals' }).catch(() => { });
            res.json(view);
        } catch (e) { fail(res, e); }
    });

    // POST /internal/guardian/dry-run { toolName, args?, ownerMessage?, jobName?, sourceKind?, taintSources?, excerpt? }
    // Runs the gate and the guardian on a described call. Nothing runs, nothing is stored.
    router.post('/dry-run', async (req, res) => {
        try {
            const b = req.body || {};
            if (!b.toolName || typeof b.toolName !== 'string') return res.status(400).json({ error: 'toolName is required' });
            let args = b.args ?? {};
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { return res.status(400).json({ error: 'args must be a JSON object' }); }
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) return res.status(400).json({ error: 'args must be a JSON object' });
            const result = await agent.approvals.dryRun({
                toolName: b.toolName.slice(0, 200), args,
                ownerMessage: typeof b.ownerMessage === 'string' ? b.ownerMessage.slice(0, 2000) : null,
                jobName: typeof b.jobName === 'string' ? b.jobName.slice(0, 200) : null,
                sourceKind: typeof b.sourceKind === 'string' ? b.sourceKind : null,
                taintSources: Array.isArray(b.taintSources) ? b.taintSources.slice(0, 10).map(s => String(s).slice(0, 200)) : [],
                excerpt: typeof b.excerpt === 'string' ? b.excerpt.slice(0, 2000) : null,
                serverName: typeof b.serverName === 'string' ? b.serverName.slice(0, 100) : null
            });
            res.json(result);
        } catch (e) { fail(res, e); }
    });

    // POST /internal/guardian/feedback/:id { feedback: 'should_allow' | 'should_deny' | null, note? }
    router.post('/feedback/:id', (req, res) => {
        try {
            const b = req.body || {};
            const feedback = b.feedback === null || b.feedback === '' ? null : b.feedback;
            if (feedback !== null && !['should_allow', 'should_deny'].includes(feedback)) {
                return res.status(400).json({ error: "feedback must be 'should_allow', 'should_deny' or null" });
            }
            const existing = db().getGuardianDecision(req.params.id);
            if (!existing) return res.status(404).json({ error: 'No such decision' });
            const row = db().setGuardianFeedback(req.params.id, feedback, typeof b.note === 'string' ? b.note : null);
            res.json({ success: true, row });
        } catch (e) { fail(res, e); }
    });

    return router;
}

module.exports = { createGuardianRouter, OUTCOMES, RISKS, SOURCE_KINDS };
