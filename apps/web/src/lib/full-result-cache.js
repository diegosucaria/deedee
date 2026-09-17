// The sub-agent list leaves out result_full, so an expanded row reads the whole
// result on its own. The cache holds one entry per task id, tagged with the
// status the row had when we read it. A row opened while the sub-agent is still
// running has no full text yet, so the entry goes stale as soon as the status
// changes and the row reads again.

/**
 * Does this task still need a read?
 * @param {Object} cache entries by task id
 * @param {string|null} taskId the open row
 * @param {string|undefined} status the status the list shows for that row
 * @returns {boolean}
 */
export function needsFullResult(cache, taskId, status) {
    if (!taskId) return false;
    const entry = cache?.[taskId];
    if (!entry) return true;
    return entry.status !== status;
}

/**
 * The cache entry for one read.
 * @param {string|undefined} status the status the list showed when we asked
 * @param {Object|null} row what the server returned, or null if the read failed
 * @returns {{status: string|undefined, text: string|null, failed: boolean}}
 */
export function fullResultEntry(status, row) {
    if (!row) return { status, text: null, failed: true };
    return { status, text: row.result_full ?? null, failed: false };
}
