/**
 * Browser V2 — CDP Screencast
 * Streams JPEG frames to Interfaces via Socket.io.
 * Supports tab switching (stop old session, start new one).
 */

/**
 * Initialize live CDP screencast streaming.
 * Connects to the Interfaces server via Socket.io, then starts Page.startScreencast.
 *
 * @param {import('playwright').BrowserContext} browser
 * @param {import('playwright').Page} page
 */
async function initScreencast(browser, page) {
    try {
        if (!global.socket) {
            const { io } = require('socket.io-client');
            const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
            console.log(`[Browser] Connecting to Interfaces for streaming at ${interfacesUrl}...`);

            global.socket = io(interfacesUrl, {
                auth: { token: process.env.DEEDEE_API_TOKEN },
                reconnection: true,
                reconnectionAttempts: 5,
            });

            global.socket.on('connect', () => console.log('[Browser] Stream Socket connected.'));
            global.socket.on('connect_error', (err) => console.error('[Browser] Stream Socket Error:', err.message));
        }

        await startScreencastSession(browser, page);
    } catch (err) {
        console.error('[Browser] Failed to start screencast:', err);
    }
}

/**
 * Start a CDP screencast session on a specific page.
 * @param {import('playwright').BrowserContext} browser
 * @param {import('playwright').Page} page
 */
async function startScreencastSession(browser, page) {
    try {
        console.log('[Browser] Starting CDP Screencast...');
        global.cdpSession = await browser.newCDPSession(page);

        await global.cdpSession.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 50,
            maxWidth: 800,
            everyNthFrame: 1,
        });

        global.cdpSession.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
            if (global.socket && global.socket.connected) {
                global.socket.emit('browser:frame', {
                    data,   // base64
                    timestamp: metadata.timestamp,
                });
            }

            global.cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => { });
        });
    } catch (err) {
        console.error('[Browser] Failed to start screencast session:', err);
    }
}

/**
 * Switch screencast to a different page (tab).
 * Stops the old CDP session and starts a new one on the target page.
 *
 * @param {import('playwright').BrowserContext} browser
 * @param {import('playwright').Page} newPage
 */
async function switchScreencast(browser, newPage) {
    try {
        // Stop existing session
        if (global.cdpSession) {
            try {
                await global.cdpSession.send('Page.stopScreencast');
                await global.cdpSession.detach();
            } catch { /* session may already be closed */ }
            global.cdpSession = null;
        }

        // Start new session on the new page
        await startScreencastSession(browser, newPage);
    } catch (err) {
        console.error('[Browser] Failed to switch screencast:', err);
    }
}

module.exports = { initScreencast, switchScreencast };
