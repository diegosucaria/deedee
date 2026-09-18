// The web side of the `agent:approval` broadcast: what a listener does with
// an event, and when an approval card may still show its buttons.
const {
    approvalEventKind,
    applySettledApproval,
    isApprovalOpen,
    isSettledStatus,
} = require('../src/lib/approvals.js');

describe('approvalEventKind', () => {
    test('a new request asks for a refresh, a decision settles the row', () => {
        expect(approvalEventKind({ id: 'a1', status: 'pending' })).toBe('pending');
        expect(approvalEventKind({ id: 'a1', status: 'approved' })).toBe('settled');
        expect(approvalEventKind({ id: 'a1', status: 'denied' })).toBe('settled');
        expect(approvalEventKind({ id: 'a1', status: 'expired' })).toBe('settled');
    });

    test('rows without an id or a status are ignored', () => {
        expect(approvalEventKind(null)).toBe('ignore');
        expect(approvalEventKind({ status: 'approved' })).toBe('ignore');
        expect(approvalEventKind({ id: 'a1' })).toBe('ignore');
        expect(isSettledStatus('pending')).toBe(false);
        expect(isSettledStatus('approved')).toBe(true);
    });
});

describe('applySettledApproval', () => {
    const view = () => ({
        pending: [{ id: 'a1', tool_name: 'runShellCommand' }, { id: 'a2', tool_name: 'sendMessage' }],
        recent: [{ id: 'a0', status: 'denied' }],
        counts: { pending: 2, approved: 1, denied: 3, expired: 0 },
    });

    test('a decision on another channel leaves the pending list at once', () => {
        const next = applySettledApproval(view(), { id: 'a1', status: 'approved', decidedVia: 'whatsapp' });
        expect(next.pending.map(r => r.id)).toEqual(['a2']);
        expect(next.counts).toMatchObject({ pending: 1, approved: 2 });
        expect(next.recent[0]).toMatchObject({ id: 'a1', status: 'approved', decided_via: 'whatsapp', tool_name: 'runShellCommand' });
    });

    test('an expiry counts as expired', () => {
        const next = applySettledApproval(view(), { id: 'a2', status: 'expired' });
        expect(next.pending.map(r => r.id)).toEqual(['a1']);
        expect(next.counts).toMatchObject({ pending: 1, expired: 1 });
    });

    test('unknown ids and pending events change nothing', () => {
        const start = view();
        expect(applySettledApproval(start, { id: 'zzz', status: 'denied' })).toBe(start);
        expect(applySettledApproval(start, { id: 'a1', status: 'pending' })).toBe(start);
    });
});

describe('isApprovalOpen', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');

    test('a pending card nobody answered keeps its buttons', () => {
        expect(isApprovalOpen({ id: 'a1', status: 'pending' }, { now })).toBe(true);
    });

    test('a decided or expired card loses them', () => {
        expect(isApprovalOpen({ id: 'a1', status: 'approved' }, { now })).toBe(false);
        expect(isApprovalOpen({ id: 'a1', status: 'pending' }, { decidedIds: new Set(['a1']), now })).toBe(false);
        expect(isApprovalOpen(
            { id: 'a1', status: 'pending', expiresAt: '2026-09-16T11:59:00Z' },
            { now }
        )).toBe(false);
        expect(isApprovalOpen(
            { id: 'a1', status: 'pending', expiresAt: '2026-09-16T12:05:00Z' },
            { now }
        )).toBe(true);
    });

    test('missing rows are never open', () => {
        expect(isApprovalOpen(null, { now })).toBe(false);
        expect(isApprovalOpen({ status: 'pending' }, { now })).toBe(false);
    });
});

describe('chatLinkOf', () => {
    const { chatLinkOf } = require('../src/lib/approvals.js');

    test('a chat card links to the chat he asked in', () => {
        expect(chatLinkOf({ origin_chat_id: 'web-1', reply_chat_id: 'web-1', mode: 'interactive' }))
            .toEqual({ href: '/chat/web-1', label: 'Open the chat' });
    });

    test('a job card links to the run that paused, not to where the card went', () => {
        const row = {
            origin_chat_id: 'scheduled_morning_briefing_1700000000000',
            reply_chat_id: '10000000000@s.whatsapp.net',
            mode: 'deferred',
            origin_meta: { jobName: 'morning_briefing' },
        };
        expect(chatLinkOf(row)).toEqual({ href: '/chat/scheduled_morning_briefing_1700000000000', label: 'Open the run' });
    });

    test('a WhatsApp chat id is encoded, and a row with no chat has no link', () => {
        expect(chatLinkOf({ origin_chat_id: '10000000000@s.whatsapp.net', mode: 'interactive' }).href)
            .toBe('/chat/10000000000%40s.whatsapp.net');
        // An older row that only knows where the card went still links there.
        expect(chatLinkOf({ reply_chat_id: 'web-2', mode: 'interactive' }).href).toBe('/chat/web-2');
        expect(chatLinkOf({})).toBeNull();
        expect(chatLinkOf(null)).toBeNull();
    });
});
