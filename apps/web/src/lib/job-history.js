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

/**
 * True when the run was a reminder the scheduler delivered after a restart.
 * The scheduler writes `{"late":true,...}` as the job log output
 * (apps/agent/src/scheduler.js, `_deliverLateReminder`). The owner gets a
 * "(late)" prefix in the message; this is how the same run is marked here.
 */
export function isLateRun(log) {
    const output = log?.output;
    if (typeof output !== 'string' || !output.includes('"late"')) return false;
    try {
        return JSON.parse(output)?.late === true;
    } catch {
        return false;
    }
}
