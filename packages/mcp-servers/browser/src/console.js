/**
 * Browser V2 — Console Capture
 * Captures browser console messages and page errors for agent diagnostics.
 * Supports multi-tab: listeners are installed per-page using a WeakSet guard.
 */

const MAX_MESSAGES = 50;
const MAX_ERRORS = 20;

let consoleMessages = [];
let pageErrors = [];

// Track which pages already have listeners to avoid duplicates
const instrumentedPages = new WeakSet();

/**
 * Install console capture listeners on a page.
 * Safe to call multiple times — only installs once per page instance.
 * @param {import('playwright').Page} page
 */
function installConsoleCapture(page) {
    if (instrumentedPages.has(page)) return;
    instrumentedPages.add(page);

    page.on('console', (msg) => {
        const entry = {
            level: msg.type(), // 'log', 'warn', 'error', 'info', 'debug'
            text: msg.text(),
            timestamp: new Date().toISOString(),
            location: msg.location() ? `${msg.location().url}:${msg.location().lineNumber}:${msg.location().columnNumber}` : '',
        };

        consoleMessages.push(entry);
        if (consoleMessages.length > MAX_MESSAGES) {
            consoleMessages.shift();
        }
    });

    page.on('pageerror', (err) => {
        const entry = {
            message: err.message,
            stack: err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : '',
            timestamp: new Date().toISOString(),
        };

        pageErrors.push(entry);
        if (pageErrors.length > MAX_ERRORS) {
            pageErrors.shift();
        }
    });
}

/**
 * Get console messages, optionally filtered by level.
 * @param {string} [level] - 'error', 'warn', 'log', 'info', 'debug'
 * @returns {{ messages: Array, errors: Array }}
 */
function getConsoleMessages(level) {
    const messages = level
        ? consoleMessages.filter(m => m.level === level)
        : consoleMessages;

    return { messages, errors: pageErrors };
}

/**
 * Get recent console errors only (for appending to interaction error messages).
 * @returns {string} Formatted string of recent errors, empty if none.
 */
function getRecentErrors() {
    const recent = consoleMessages
        .filter(m => m.level === 'error')
        .slice(-3);

    if (recent.length === 0 && pageErrors.length === 0) return '';

    const parts = [];
    if (recent.length > 0) {
        parts.push('Console errors: ' + recent.map(m => m.text).join('; '));
    }
    if (pageErrors.length > 0) {
        const last = pageErrors.slice(-2);
        parts.push('Page errors: ' + last.map(e => e.message).join('; '));
    }
    return parts.join(' | ');
}

/**
 * Clear all captured messages.
 */
function clearConsoleMessages() {
    consoleMessages = [];
    pageErrors = [];
}

module.exports = { installConsoleCapture, getConsoleMessages, getRecentErrors, clearConsoleMessages };
