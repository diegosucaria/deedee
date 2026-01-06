const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
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
        this.status = 'disconnected'; // disconnected, connecting, connected, scan_qr
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

    async start() {
        try {
            console.log('[WhatsApp] Starting service...');
            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: true, // Also print to logs for backup
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
                    this.qr = await QRCode.toDataURL(qr); // Generate Base64 Data URL for UI
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

            // --- CREDENTIALS UPDATE ---
            this.sock.ev.on('creds.update', saveCreds);

            // --- MESSAGES UPSERT ---
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
            // Filter out status broadcast, groups (if strict), me
            if (remoteJid === 'status@broadcast' || msg.key.fromMe) return;

            const phoneNumber = remoteJid.split('@')[0];

            // Security Check
            if (this.allowedNumbers.size > 0 && !this.allowedNumbers.has(phoneNumber)) {
                console.warn(`[WhatsApp] Blocked message from unauthorized number: ${phoneNumber}`);
                return;
            }

            console.log(`[WhatsApp] Received from ${phoneNumber}`);

            // Extract Content
            const messageContent = msg.message;
            const key = msg.key;

            let text = '';
            let type = 'text';
            let parts = null;

            // Simple Text
            if (messageContent.conversation) {
                text = messageContent.conversation;
            } else if (messageContent.extendedTextMessage) {
                text = messageContent.extendedTextMessage.text;
            }
            // Audio
            else if (messageContent.audioMessage) {
                type = 'audio';
                text = '[Voice]';
                // Download Buffer
                // Note: For simplicity, assuming downloadMediaMessage is available or polyfilled via makeWASocket helpers
                // Baileys v6+ might require a helper. 
                // We'll trust standard implementation or add download logic if needed.
                // For now, let's mark it so Agent knows.
                // Providing actual audio content requires `@whiskeysockets/baileys-store` or helper.
                // Let's defer strict download logic to a simple try-block using built-in method if exposed, 
                // or we need to import downloadMediaMessage from baileys
            }
            // Image
            else if (messageContent.imageMessage) {
                type = 'image';
                text = messageContent.imageMessage.caption || '[Image]';
            }

            const userMessage = createUserMessage(text, 'whatsapp', phoneNumber); // Use phone as ID
            userMessage.metadata = { chatId: remoteJid, phoneNumber };

            // Handle Audio/Image download if needed (Placeholder logic)
            // For now, sending text metadata

            await axios.post(`${this.agentUrl}/webhook`, userMessage);

            // Mark as read
            await this.sock.readMessages([msg.key]);

        } catch (err) {
            console.error('[WhatsApp] Message Handler Error:', err.message);
        }
    }

    async sendMessage(toJid, content) {
        if (!this.sock) throw new Error('WhatsApp not initialized');

        try {
            console.log(`[WhatsApp] Sending to ${toJid}:`, content.substring(0, 50));
            await this.sock.sendMessage(toJid, { text: content });
        } catch (e) {
            console.error('[WhatsApp] Send Failed:', e.message);
        }
    }

    async disconnect() {
        try {
            // Force logout
            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }
            this.status = 'disconnected';
            // Clear data folder
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
