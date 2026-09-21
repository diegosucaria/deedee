/**
 * Where a job run's messages are, as a link into Message History.
 *
 * The agent sends `history` with each job log: { chatId, since? }, or null for
 * a job that ran no model (a backup, a direct reminder). A run with its own
 * chat reads top to bottom. A job that reports into one of your chats has no
 * chat of its own, so its link opens that chat from the moment the run began.
 */
export function jobHistoryHref(history) {
    const chatId = typeof history?.chatId === 'string' ? history.chatId.trim() : '';
    if (!chatId) return null;
    const query = new URLSearchParams({ chatId, order: 'asc' });
    if (typeof history.since === 'string' && !Number.isNaN(Date.parse(history.since))) query.set('since', history.since);
    return `/system/history?${query.toString()}`;
}
