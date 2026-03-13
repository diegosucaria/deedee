/**
 * Browser V2 — Network Monitor
 * Captures XHR/fetch requests and responses for agent inspection.
 * Enables waiting for specific API responses (critical for SPAs).
 * Supports multi-tab: listeners are installed per-page using a WeakSet guard.
 */

const MAX_ENTRIES = 100;
const MAX_BODY_SIZE = 50 * 1024; // 50KB
const MAX_BODY_READ = 200 * 1024; // 200KB - refuse to read bodies larger than this

let networkLog = [];

// Track which pages already have listeners
const instrumentedPages = new WeakSet();

// Pending waiters: [{ pattern, resolve, reject, timer }]
let waiters = [];

/**
 * Install network monitor on a page.
 * Safe to call multiple times — only installs once per page instance.
 * @param {import('playwright').Page} page
 */
function installNetworkMonitor(page) {
    if (instrumentedPages.has(page)) return;
    instrumentedPages.add(page);

    // Track pending requests for timing
    const pendingRequests = new WeakMap();

    page.on('request', (request) => {
        pendingRequests.set(request, Date.now());
    });

    page.on('response', async (response) => {
        const request = response.request();
        const resourceType = request.resourceType();
        const url = request.url();
        const method = request.method();
        const status = response.status();
        const startTime = pendingRequests.get(request);
        const duration = startTime ? Date.now() - startTime : undefined;

        const entry = {
            method,
            url,
            status,
            resourceType,
            duration,
            timestamp: new Date().toISOString(),
            bodyPreview: null,
        };

        // Capture body for XHR/fetch responses under size limit
        if ((resourceType === 'xhr' || resourceType === 'fetch') && status < 400) {
            try {
                // Check Content-Length header before reading to prevent OOM
                const contentLength = response.headers()['content-length'];
                if (contentLength && parseInt(contentLength, 10) > MAX_BODY_READ) {
                    entry.bodyPreview = `[Body too large: ${contentLength} bytes]`;
                } else {
                    const body = await response.text();
                    if (body.length <= MAX_BODY_SIZE) {
                        entry.bodyPreview = body;
                    } else {
                        entry.bodyPreview = body.slice(0, MAX_BODY_SIZE) + '...[truncated]';
                    }
                }
            } catch { /* body not available */ }
        }

        networkLog.push(entry);
        if (networkLog.length > MAX_ENTRIES) {
            networkLog.shift();
        }

        // Check if any waiters match this response
        for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (url.includes(w.pattern)) {
                clearTimeout(w.timer);
                w.resolve(entry);
                waiters.splice(i, 1);
            }
        }
    });

    page.on('requestfailed', (request) => {
        const url = request.url();
        const entry = {
            method: request.method(),
            url,
            status: 0,
            resourceType: request.resourceType(),
            error: request.failure()?.errorText || 'Request failed',
            timestamp: new Date().toISOString(),
            bodyPreview: null,
        };

        networkLog.push(entry);
        if (networkLog.length > MAX_ENTRIES) {
            networkLog.shift();
        }
    });
}

/**
 * Get network log entries, optionally filtered.
 * @param {Object} [filter]
 * @param {string} [filter.urlFilter] - URL substring match
 * @param {string} [filter.resourceType] - Resource type filter (xhr, fetch, document, etc.)
 * @param {number} [filter.limit] - Max entries to return
 * @returns {Array}
 */
function getNetworkLog(filter = {}) {
    let entries = [...networkLog];

    if (filter.urlFilter) {
        entries = entries.filter(e => e.url.includes(filter.urlFilter));
    }
    if (filter.resourceType) {
        entries = entries.filter(e => e.resourceType === filter.resourceType);
    }

    const limit = filter.limit || 30;
    return entries.slice(-limit);
}

/**
 * Get the most recent response body matching a URL pattern.
 * @param {string} urlPattern - URL substring to match
 * @returns {{ url: string, status: number, body: string } | null}
 */
function getResponseBody(urlPattern) {
    // Search from most recent
    for (let i = networkLog.length - 1; i >= 0; i--) {
        const entry = networkLog[i];
        if (entry.url.includes(urlPattern) && entry.bodyPreview) {
            return { url: entry.url, status: entry.status, body: entry.bodyPreview };
        }
    }
    return null;
}

/**
 * Wait for a network response matching a URL pattern.
 * @param {string} urlPattern - URL substring to match
 * @param {number} [timeout=30000] - Max wait time in ms
 * @returns {Promise<Object>} The matching network entry
 */
function waitForNetworkResponse(urlPattern, timeout = 30000) {
    // Check if we already have a matching entry
    const existing = getResponseBody(urlPattern);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const idx = waiters.findIndex(w => w.pattern === urlPattern && w.resolve === resolve);
            if (idx !== -1) waiters.splice(idx, 1);
            reject(new Error(`Timeout waiting for network response matching "${urlPattern}" after ${timeout}ms`));
        }, Math.min(timeout, 60000));

        waiters.push({ pattern: urlPattern, resolve, reject, timer });
    });
}

/**
 * Reject all pending waiters (e.g., on page close/navigation reset).
 */
function rejectPendingWaiters() {
    for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('Page navigated or closed, network waiters cancelled.'));
    }
    waiters = [];
}

/**
 * Clear the network log.
 */
function clearNetworkLog() {
    networkLog = [];
}

module.exports = { installNetworkMonitor, getNetworkLog, getResponseBody, waitForNetworkResponse, rejectPendingWaiters, clearNetworkLog };
