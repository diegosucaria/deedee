const { createUserMessage } = require('@deedee/shared/src/types');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

class WhatsAppService {
    constructor(agentUrl) {
        this.agentUrl = agentUrl;
        this.sock = null;
        this.qr = null;
        this.status = 'disconnected';
        this.authFolder = path.join(process.cwd(), 'data', 'baileys_auth');

        // Ensure auth folder exists
        if (!fs.existsSync(this.authFolder)) {
            fs.mkdirSync(this.authFolder, { recursive: true });
        }

        // Allowed Numbers
        const allowed = process.env.ALLOWED_WHATSAPP_NUMBERS || '';
        this.allowedNumbers = new Set(allowed.split(',').map(id => id.trim().replace(/[^0-9]/g, '')).filter(id => id.length > 0));

        if (this.allowedNumbers.size > 0) {
            console.log(`[WhatsApp] Security Enforced. Allowed Numbers: ${Array.from(this.allowedNumbers).join(', ')}`);
        } else {
            console.error(`[WhatsApp] 🛑 SECURITY ERROR: No ALLOWED_WHATSAPP_NUMBERS set. Ignoring ALL messages.`);
        }
    }

    async _importBaileys() {
        return import('@whiskeysockets/baileys');
    }

    async start() {
        console.log('[WhatsApp] Service initializing...');

        // Check if we have credentials
        const hasCreds = fs.existsSync(path.join(this.authFolder, 'creds.json'));
        if (hasCreds) {
            console.log('[WhatsApp] Session found. Auto-connecting...');
            await this.connect();
        } else {
            console.log('[WhatsApp] No session found. Standing by for manual connection.');
            this.status = 'disconnected';
        }
    }

    async connect() {
        if (this.status === 'connected' || this.status === 'connecting') {
            console.log('[WhatsApp] Already connected or connecting.');
            return;
        }

        try {
            console.log('[WhatsApp] Connecting...');
            this.status = 'connecting';

            // Dynamic Import via helper for testability
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage } = await this._importBaileys();
            this.downloadMediaMessage = downloadMediaMessage; // Save for later use

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: true, // Useful for logs still
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 60000, // Increased timeout
                keepAliveIntervalMs: 30000,
                syncFullHistory: false
            });

            // --- CONNECTION UPDATE ---
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log('[WhatsApp] QR Code generated');
                    this.status = 'scan_qr';
                    this.qr = await QRCode.toDataURL(qr);
                }

                if (connection === 'close') {
                    // baileys-specific error codes
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log(`[WhatsApp] Connection closed (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);

                    // If we were scanning QR and it failed/closed (e.g. timeout), do NOT auto-reconnect infinite loop.
                    // Only auto-reconnect if we were previously 'connected' or if it's a verifiable generic network error.
                    // For simplicity: If loggedOut -> Stop. 
                    // If we were parsing QR and connection closed -> likely timed out -> Stop (allow user to retry manually).

                    if (this.status === 'scan_qr') {
                        console.log('[WhatsApp] Connection closed while scanning QR. Stopping auto-retry to prevent loop.');
                        this.status = 'disconnected';
                        this.qr = null;
                        this.sock = null;
                        return;
                    }

                    this.status = 'disconnected';
                    this.qr = null;

                    if (shouldReconnect) {
                        this.status = 'connecting';
                        // Backoff
                        setTimeout(() => this.connect(), 5000); // Call connect() instead of start()
                    } else {
                        console.log('[WhatsApp] Logged out. Delete session to restart.');
                        this.sock = null;
                    }
                } else if (connection === 'open') {
                    console.log('[WhatsApp] Connection opened');
                    this.status = 'connected';
                    this.qr = null;
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    if (!msg.message) continue;
                    await this.handleMessage(msg);
                }
            });

        } catch (err) {
            console.error('[WhatsApp] Connect Error:', err);
            this.status = 'disconnected';
        }
    }

    async handleMessage(msg) {
        try {
            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast' || msg.key.fromMe) return;

            const phoneNumber = remoteJid.split('@')[0];

            // Security Check
            if (this.allowedNumbers.size === 0) {
                console.warn(`[WhatsApp] Ignored message from ${phoneNumber} because ALLOWED_WHATSAPP_NUMBERS is empty (Secure Mode).`);
                return;
            }

            if (!this.allowedNumbers.has(phoneNumber)) {
                console.warn(`[WhatsApp] Blocked message from unauthorized number: ${phoneNumber}`);
                return;
            }

            console.log(`[WhatsApp] Received from ${phoneNumber}`);

            const messageContent = msg.message;
            let text = '';
            let type = 'text';
            let buffer = null;
            let mimeType = null;

            // Simple Text
            if (messageContent.conversation) {
                text = messageContent.conversation;
            } else if (messageContent.extendedTextMessage) {
                text = messageContent.extendedTextMessage.text;
            }
            // Audio
            else if (messageContent.audioMessage) {
                type = 'audio';
                text = '[Voice Message]';
                mimeType = messageContent.audioMessage.mimetype;
                if (this.downloadMediaMessage) {
                    try {
                        // Download buffer
                        buffer = await this.downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                        console.log(`[WhatsApp] Downloaded audio: ${buffer.length} bytes`);
                    } catch (e) {
                        console.error('[WhatsApp] Audio Download Failed:', e);
                    }
                }
            }
            // Image
            else if (messageContent.imageMessage) {
                type = 'image';
                text = messageContent.imageMessage.caption || '[Image]';
                mimeType = messageContent.imageMessage.mimetype;
                if (this.downloadMediaMessage) {
                    try {
                        buffer = await this.downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                        console.log(`[WhatsApp] Downloaded image: ${buffer.length} bytes`);
                    } catch (e) {
                        console.error('[WhatsApp] Image Download Failed:', e);
                    }
                }
            } else {
                // Unknown / Protocol Message / Reaction
                console.log(`[WhatsApp] Ignored unhandled message type keys: ${Object.keys(messageContent).join(', ')}`);
                return;
            }

            if (!text && !buffer) {
                console.warn('[WhatsApp] Received message with no content (empty text and no media). Ignoring.');
                return;
            }

            const userMessage = createUserMessage(text, 'whatsapp', phoneNumber);
            userMessage.metadata = { chatId: remoteJid, phoneNumber };

            // Inline Data for Agent
            if (buffer) {
                userMessage.parts = userMessage.parts || [];
                // Agent expects inlineData for multimodal
                userMessage.parts.push({
                    inlineData: {
                        mimeType: mimeType || (type === 'audio' ? 'audio/ogg' : 'image/jpeg'),
                        data: buffer.toString('base64')
                    }
                });
            }

            await axios.post(`${this.agentUrl}/webhook`, userMessage);

            // Mark as read
            await this.sock.readMessages([msg.key]);

        } catch (err) {
            console.error('[WhatsApp] Message Handler Error:', err.message);
        }
    }

    async sendMessage(toJid, content, options = {}) {
        if (!this.sock) throw new Error('WhatsApp not initialized');

        try {
            const type = options.type || 'text';
            console.log(`[WhatsApp] Sending ${type} to ${toJid}`);

            if (type === 'text') {
                await this.sock.sendMessage(toJid, { text: content });
            } else if (type === 'audio') {
                // Content is base64 string
                const buffer = Buffer.from(content, 'base64');
                await this.sock.sendMessage(toJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            } else if (type === 'image') {
                const buffer = Buffer.from(content, 'base64');
                await this.sock.sendMessage(toJid, { image: buffer });
            }

        } catch (e) {
            console.error('[WhatsApp] Send Failed:', e.message);
        }
    }

    async disconnect() {
        try {
            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }
            this.status = 'disconnected';
            fs.rmSync(this.authFolder, { recursive: true, force: true });
        } catch (e) {
            console.error('[WhatsApp] Disconnect Error:', e);
        }
    }

    getStatus() {
        // me: { id: "12345@s.whatsapp.net", name: "Name" }
        const me = this.sock?.user;
        let formattedMe = null;
        if (me) {
            formattedMe = {
                id: me.id.split(':')[0].split('@')[0], // Extract number
                name: me.name
            };
        }

        return {
            status: this.status,
            qr: this.qr,
            allowedNumbers: Array.from(this.allowedNumbers),
            me: formattedMe
        };
    }
}

module.exports = { WhatsAppService };
