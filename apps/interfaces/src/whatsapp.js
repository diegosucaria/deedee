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
            console.warn(`[WhatsApp] ⚠️ WARNING: No ALLOWED_WHATSAPP_NUMBERS set. Bot is PUBLIC.`);
        }
    }

    async _importBaileys() {
        return import('@whiskeysockets/baileys');
    }

    async start() {
        try {
            console.log('[WhatsApp] Starting service...');

            // Dynamic Import via helper for testability
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage } = await this._importBaileys();
            this.downloadMediaMessage = downloadMediaMessage; // Save for later use

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                // printQRInTerminal: true, // Deprecated
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 10000,
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
                    const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                    console.log(`[WhatsApp] Connection closed due to ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);
                    this.status = 'disconnected';
                    this.qr = null;

                    if (shouldReconnect) {
                        this.status = 'connecting';
                        // Backoff
                        setTimeout(() => this.start(), 5000);
                    } else {
                        console.log('[WhatsApp] Logged out. Delete session to restart.');
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
            console.error('[WhatsApp] Start Error:', err);
            // Retry
            setTimeout(() => this.start(), 10000);
        }
    }

    async handleMessage(msg) {
        try {
            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast' || msg.key.fromMe) return;

            const phoneNumber = remoteJid.split('@')[0];

            // Security Check
            if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(phoneNumber)) {
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
        return {
            status: this.status,
            qr: this.qr,
            allowedNumbers: Array.from(this.allowedNumbers)
        };
    }
}

module.exports = { WhatsAppService };
