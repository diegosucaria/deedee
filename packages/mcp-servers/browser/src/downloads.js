/**
 * Browser V2 — Download/Upload Handling
 * Handles file downloads and file upload dialogs.
 * Supports browser restart: tracks context via WeakSet.
 */

const path = require('path');
const fs = require('fs');

const MAX_HISTORY = 20;

let downloadDir = '';
let downloads = [];

// Track which contexts have download handlers installed
const instrumentedContexts = new WeakSet();

// Track pages to avoid duplicate download listeners
const instrumentedPages = new WeakSet();

/**
 * Install download handler on the browser context.
 * Safe to call after browser restart — re-installs on new context.
 * @param {import('playwright').BrowserContext} context
 * @param {string} userDataDir - Browser profile directory
 */
function installDownloadHandler(context, userDataDir) {
    if (instrumentedContexts.has(context)) return;
    instrumentedContexts.add(context);

    downloadDir = path.join(userDataDir, 'downloads');
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    context.on('page', (page) => {
        attachDownloadListener(page);
    });

    // Attach to existing pages
    for (const page of context.pages()) {
        attachDownloadListener(page);
    }
}

function attachDownloadListener(page) {
    if (instrumentedPages.has(page)) return;
    instrumentedPages.add(page);

    page.on('download', async (download) => {
        try {
            const suggestedName = sanitizeFilename(download.suggestedFilename());
            // Add timestamp suffix to avoid overwrite race conditions
            const ext = path.extname(suggestedName);
            const base = path.basename(suggestedName, ext);
            const uniqueName = `${base}_${Date.now()}${ext}`;
            const savePath = path.join(downloadDir, uniqueName);

            // Save via temp file for atomicity
            const tmpPath = savePath + '.tmp';
            await download.saveAs(tmpPath);
            fs.renameSync(tmpPath, savePath);

            const stats = fs.statSync(savePath);
            const entry = {
                filename: uniqueName,
                path: savePath,
                url: download.url(),
                size: stats.size,
                timestamp: new Date().toISOString(),
            };

            downloads.push(entry);
            if (downloads.length > MAX_HISTORY) {
                downloads.shift();
            }

            console.error(`[Browser] Downloaded: ${uniqueName} (${stats.size} bytes)`);
        } catch (err) {
            console.error('[Browser] Download failed:', err.message);
        }
    });
}

/**
 * Sanitize a filename to prevent path traversal and other issues.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
    // Remove path components
    let safe = name.replace(/[/\\]/g, '_');
    // Remove null bytes
    safe = safe.replace(/\0/g, '');
    // Remove leading dots
    safe = safe.replace(/^\.+/, '');
    // Limit length
    if (safe.length > 200) {
        const ext = path.extname(safe);
        safe = safe.slice(0, 200 - ext.length) + ext;
    }
    return safe || 'download';
}

/**
 * Get download history.
 * @returns {Array}
 */
function getDownloads() {
    return [...downloads];
}

/**
 * Get the download directory path.
 * @returns {string}
 */
function getDownloadDir() {
    return downloadDir;
}

module.exports = { installDownloadHandler, getDownloads, getDownloadDir, sanitizeFilename };
