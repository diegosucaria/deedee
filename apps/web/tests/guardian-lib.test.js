// Pure helpers behind the Guardian page.
const g = require('../src/lib/guardian.js');

describe('guardian page helpers', () => {
    test('outcome labels and tones cover every outcome, with a fallback', () => {
        for (const o of g.OUTCOMES) {
            expect(g.outcomeLabel(o.id)).toBe(o.label);
            expect(g.outcomeTone(o.id)).toBe(o.tone);
        }
        expect(g.outcomeLabel('new_thing')).toBe('new_thing');
        expect(g.outcomeTone('new_thing')).toMatch(/zinc/);
    });

    test('every outcome lands in exactly one chart group', () => {
        for (const o of g.OUTCOMES) {
            expect(g.OUTCOME_GROUPS.filter(gr => gr.outcomes.includes(o.id))).toHaveLength(1);
        }
        expect(new Set(g.OUTCOME_GROUPS.map(gr => gr.color)).size).toBe(g.OUTCOME_GROUPS.length);
    });

    test('outcomesPerDay fills gaps and folds outcomes', () => {
        const rows = g.outcomesPerDay([
            { day: '2026-09-01', auto_allowed: 2, deny_list: 1, breaker_stop: 1 },
            { day: '2026-09-03', escalated_expired: 1, escalated: 2 },
            { day: 'garbage', auto_allowed: 9 },
        ], { from: '2026-08-31', to: '2026-09-03' });
        expect(rows.map(r => r.date)).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']);
        expect(rows[0]['Auto-allowed']).toBe(0);
        expect(rows[1]['Auto-allowed']).toBe(2);
        expect(rows[1]['Blocked outright']).toBe(2);
        expect(rows[2]['Auto-denied']).toBe(0);
        expect(rows[3]['Waiting, expired or unasked']).toBe(3);
        expect(g.outcomesPerDay([], {})).toEqual([]);
        expect(g.outcomesPerDay(null, { from: '2026-09-02', to: '2026-09-01' })).toEqual([]);
        expect(g.outcomesPerDay([], { from: '2020-01-01', to: '2026-01-01' })).toHaveLength(400);
    });

    test('outcomeGroupTotals sums per group', () => {
        const totals = g.outcomeGroupTotals({ auto_allowed: 3, escalated_approved: 2, ran_unasked: 1 });
        expect(totals.find(t => t.key === 'Auto-allowed').count).toBe(3);
        expect(totals.find(t => t.key === 'You approved').count).toBe(2);
        expect(totals.find(t => t.key === 'Ran with mode off').count).toBe(1);
        expect(g.outcomeGroupTotals(null).every(t => t.count === 0)).toBe(true);
    });

    test('rangeFor counts today and defaults to 30 days', () => {
        const now = new Date('2026-09-17T15:00:00Z');
        expect(g.rangeFor('7d', now)).toEqual({ from: '2026-09-11', to: '2026-09-17' });
        expect(g.rangeFor('nope', now)).toEqual({ from: '2026-08-19', to: '2026-09-17' });
    });

    test('historyQuery keeps only values the route accepts', () => {
        const qs = new URLSearchParams(g.historyQuery({
            outcome: ['auto_allowed', 'bad', 'auto_allowed'], risk: 'high,huge', sourceKind: 'job', tool: '  browser_*  ',
            from: '2026-09-01', to: '17/09', limit: 5000, offset: 50,
        }));
        expect(Object.fromEntries(qs)).toEqual({ outcome: 'auto_allowed', risk: 'high', sourceKind: 'job', tool: 'browser_*', from: '2026-09-01', limit: '200', offset: '50' });
        expect(g.historyQuery()).toBe('limit=50');
        expect(g.statsQuery({ from: 'x', to: '2026-09-17' })).toBe('to=2026-09-17');
    });

    test('feedback is offered on auto-decided and escalated rows only', () => {
        for (const o of ['auto_allowed', 'auto_denied', 'escalated', 'escalated_approved', 'escalated_denied', 'escalated_expired']) {
            expect(g.canGiveFeedback({ outcome: o })).toBe(true);
        }
        for (const o of ['deny_list', 'breaker_stop', 'ran_unasked', undefined]) {
            expect(g.canGiveFeedback({ outcome: o })).toBe(false);
        }
        expect(g.canGiveFeedback(null)).toBe(false);
        expect(g.normalizeFeedback('should_allow')).toBe('should_allow');
        expect(g.normalizeFeedback('yes')).toBeNull();
    });

    test('rowLink opens the job runs or the chat, never a synthetic chat', () => {
        expect(g.rowLink({ job_name: 'Daily digest', chat_id: 'scheduled_1' })).toEqual({ href: '/tasks?tab=manage&job=Daily%20digest', label: 'Job runs' });
        expect(g.rowLink({ chat_id: 'abc 1', source_kind: 'chat' })).toEqual({ href: '/chat/abc%201', label: 'Open chat' });
        expect(g.rowLink({ chat_id: 'system_x', source_kind: 'chat' })).toBeNull();
        expect(g.rowLink({ chat_id: 'abc', source_kind: 'watcher' })).toBeNull();
        expect(g.rowLink(null)).toBeNull();
        expect(g.sourceLabel({ job_name: 'j' })).toBe('Job: j');
        expect(g.sourceLabel({ source_kind: 'chat', source: 'web' })).toBe('Chat (web)');
        expect(g.sourceLabel({ source_kind: 'subagent' })).toBe('Sub-agent');
    });

    test('always-ask list splits for the editor and joins back without the floor', () => {
        const categories = [{ id: 'shell' }, { id: 'send_email' }];
        expect(g.splitAlwaysAsk(['category:shell', 'mcp_*', 'category:unknown', '', 'runShellCommand:*curl*'], categories))
            .toEqual({ categories: ['shell'], globs: ['mcp_*', 'runShellCommand:*curl*'] });
        expect(g.joinAlwaysAsk(['shell', 'money', 'shell'], 'mcp_*\n\n# note\ncategory:money\nmcp_*', [{ id: 'money' }]))
            .toEqual(['category:shell', 'mcp_*']);
    });

    test('dryRunPayload validates and trims the form', () => {
        expect(g.dryRunPayload({})).toEqual({ ok: false, error: 'Name the tool to try.' });
        expect(g.dryRunPayload({ toolName: 't', args: '[1]' })).toEqual({ ok: false, error: 'Arguments must be a JSON object.' });
        expect(g.dryRunPayload({ toolName: ' t ', args: '', sourceKind: 'weird', ownerMessage: '  ', excerpt: 'x' }))
            .toEqual({ ok: true, payload: { toolName: 't', args: {}, excerpt: 'x' } });
        const many = Array.from({ length: 15 }, (_, i) => `s${i}`).join('\n');
        expect(g.dryRunPayload({ toolName: 't', taintSources: many }).payload.taintSources).toHaveLength(10);
    });

    test('apiErrorMessage pulls the route message out of fetchAPI errors', () => {
        expect(g.apiErrorMessage(new Error('API Error 400: {"error":"bad mode"}'))).toBe('bad mode');
        expect(g.apiErrorMessage(new Error('API Error 502: <html>'))).toBe('Request failed (502)');
        expect(g.apiErrorMessage(new Error('fetch failed'))).toBe('fetch failed');
    });

    test('formatters', () => {
        expect(g.formatPercent(0.456)).toBe('46%');
        expect(g.formatPercent(null)).toBe('-');
        expect(g.formatMs(850)).toBe('850ms');
        expect(g.formatMs(2345)).toBe('2.3s');
        expect(g.formatMs(undefined)).toBe('-');
        expect(g.formatCost(0.01234)).toBe('$0.0123');
        expect(g.formatCost('x')).toBe('-');
    });
});
