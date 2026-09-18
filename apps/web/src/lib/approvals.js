// Shared approval helpers.
//
// The agent broadcasts `agent:approval` on every change: a new pending row,
// a decision (from the web, WhatsApp or any other channel) and an expiry.
// Both the approvals card and the chat page listen, so a card decided
// elsewhere stops offering buttons that would only earn a refusal.
//
// Event shape (apps/agent/src/services/approval-service.js):
//   { id, status: 'pending'|'approved'|'denied'|'expired', chatId, toolName,
//     summary?, expiresAt? }

import { rowLink } from './guardian.js';

/** A status that is no longer waiting for the owner. */
export function isSettledStatus(status) {
    return typeof status === 'string' && status !== '' && status !== 'pending';
}

/**
 * What a listener should do with an `agent:approval` event.
 * 'ignore'  — not an approval row we can use.
 * 'pending' — a new request; fetch the full row from the server.
 * 'settled' — decided or expired; drop it from the pending list now.
 */
export function approvalEventKind(event) {
    if (!event || !event.id) return 'ignore';
    if (isSettledStatus(event.status)) return 'settled';
    if (event.status === 'pending') return 'pending';
    return 'ignore';
}

/**
 * Move a settled row out of `pending` and into `recent` without a round trip.
 * Counts follow, so the header stays honest until the next refresh.
 * Returns the same object when there is nothing to change.
 */
export function applySettledApproval(view, event) {
    if (approvalEventKind(event) !== 'settled') return view;
    const pending = view.pending || [];
    const row = pending.find(r => r.id === event.id);
    const nextPending = pending.filter(r => r.id !== event.id);
    if (nextPending.length === pending.length) return view;

    const counts = { ...(view.counts || {}) };
    counts.pending = Math.max(0, (counts.pending || nextPending.length + 1) - 1);
    counts[event.status] = (counts[event.status] || 0) + 1;

    const settled = {
        ...row,
        status: event.status,
        decided_at: event.decidedAt || new Date().toISOString(),
        decided_via: event.decidedVia || row?.decided_via || null,
    };
    return { ...view, pending: nextPending, recent: [settled, ...(view.recent || [])], counts };
}

/**
 * True while an approval card may still show Approve / Deny buttons.
 * `decidedIds` holds ids this tab already answered or saw settled over the
 * socket; `now` is the clock for the expiry check.
 */
export function isApprovalOpen(approval, { decidedIds, now = Date.now() } = {}) {
    if (!approval?.id || approval.status !== 'pending') return false;
    if (decidedIds && decidedIds.has(approval.id)) return false;
    if (approval.expiresAt && now > new Date(approval.expiresAt).getTime()) return false;
    return true;
}

/**
 * Where an approval came from, as a link, by the same rule as the Guardian
 * history: a job opens its runs, a chat opens that chat. A watcher, a
 * sub-agent or a voice session has no conversation to open. Where the card
 * was sent is only the channel he answers on, so it is never the link.
 * @returns {{ href: string, label: string } | null}
 */
export function chatLinkOf(row) {
    if (!row) return null;
    const meta = row.origin_meta || {};
    return rowLink({ job_name: meta.jobName || null, chat_id: row.origin_chat_id || null });
}
