/**
 * Browser V2 — CDP Screencast
 * Extracted verbatim from index.js. Streams JPEG frames to Interfaces via Socket.io.
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

        // Start CDP Session for Screencast
        if (!global.cdpSession) {
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
        }
    } catch (err) {
        console.error('[Browser] Failed to start screencast:', err);
    }
}

module.exports = { initScreencast };
