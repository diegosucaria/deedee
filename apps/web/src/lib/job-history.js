/**
 * Where a job run's messages are, as a link into Message History.
 *
 * The agent sends `history` with each job log: { chatId, since?, until? }, or null for
 * a job that ran no model (a backup, a direct reminder). A run with its own
 * chat reads top to bottom. A job that reports into one of your chats has no
 * chat of its own, so its link opens that chat between the run's start and its end.
 */
export function jobHistoryHref(history) {
    const chatId = typeof history?.chatId === 'string' ? history.chatId.trim() : '';
    if (!chatId) return null;
    const query = new URLSearchParams({ chatId, order: 'asc' });
    // Both ends, or a run from three weeks ago opens on today's messages.
    for (const edge of ['since', 'until']) {
        if (typeof history[edge] === 'string' && !Number.isNaN(Date.parse(history[edge]))) query.set(edge, history[edge]);
    }
    return `/system/history?${query.toString()}`;
}
