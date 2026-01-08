const { createUserMessage } = require('@deedee/shared/src/types');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

class WhatsAppService {
    constructor(agentUrl, sessionId = 'default') {
        this.agentUrl = agentUrl;
        this.sessionId = sessionId;
        this.sock = null;
        this.qr = null;
        this.status = 'disconnected';
        this.reconnectAttempts = 0;
        this.lidMap = new Map(); // Store LID -> Phone Number mapping
        this.contacts = new Map(); // Store Contact Details: id -> { id, name, notify }

        const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
        this.authFolder = path.join(dataDir, `baileys_auth_${sessionId}`);

        // Ensure auth folder exists
        if (!fs.existsSync(this.authFolder)) {
            fs.mkdirSync(this.authFolder, { recursive: true });
        }

        // Allowed Numbers
        const allowed = process.env.ALLOWED_WHATSAPP_NUMBERS || '';
        this.allowedNumbers = new Set(allowed.split(',').map(id => id.trim().replace(/[^0-9]/g, '')).filter(id => id.length > 0));

        this.logPrefix = `[WhatsApp:${this.sessionId}]`;

        if (this.allowedNumbers.size > 0) {
            console.log(`${this.logPrefix} Security Enforced. Allowed Numbers: ${Array.from(this.allowedNumbers).join(', ')}`);
        } else {
            console.error(`${this.logPrefix} 🛑 SECURITY ERROR: No ALLOWED_WHATSAPP_NUMBERS set. Ignoring ALL messages.`);
        }
    }

    async _importBaileys() {
        return import('@whiskeysockets/baileys');
    }

    async start() {
        console.log(`${this.logPrefix} Service initializing...`);

        // Check if we have credentials
        const hasCreds = fs.existsSync(path.join(this.authFolder, 'creds.json'));
        if (hasCreds) {
            console.log(`${this.logPrefix} Session found. Auto-connecting...`);
            await this.connect();
        } else {
            console.log(`${this.logPrefix} No session found. Standing by for manual connection.`);
            this.status = 'disconnected';
        }
    }

    async connect() {
        if (this.status === 'connected' || this.status === 'connecting') {
            console.log(`${this.logPrefix} Already connected or connecting.`);
            return;
        }

        try {
            console.log(`${this.logPrefix} Connecting...`);
            this.status = 'connecting';

            // Dynamic Import via helper for testability
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage } = await this._importBaileys();
            this.downloadMediaMessage = downloadMediaMessage; // Save for later use

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                // printQRInTerminal: true, // DEPRECATED: Handled manually
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 60000, // Increased timeout
                keepAliveIntervalMs: 30000,
                syncFullHistory: true,
                markOnlineOnConnect: false // Do not show "Online" status automatically
            });

            // --- CONNECTION UPDATE ---
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log(`${this.logPrefix} QR Code generated`);
                    this.status = 'scan_qr';
                    this.qr = await QRCode.toDataURL(qr);
                }

                if (connection === 'close') {
                    // baileys-specific error codes
                    const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    console.log(`${this.logPrefix} Connection closed (Status: ${statusCode}). Reconnect: ${shouldReconnect}`);

                    // Auto-Recovery for loop 515
                    if (statusCode === 515) {
                        this.reconnectAttempts++;
                        console.log(`${this.logPrefix} Stream Error 515 count: ${this.reconnectAttempts}`);
                        if (this.reconnectAttempts >= 5) {
                            console.error(`${this.logPrefix} Too many 515 errors. Corruption likely. Wiping session.`);
                            await this.disconnect();
                            // Restart to generate NEW QR
                            setTimeout(() => this.start(), 1000);
                            return;
                        }
                    }

                    // If we were scanning QR and it failed/closed (e.g. timeout), do NOT auto-reconnect infinite loop.
                    // Only auto-reconnect if we were previously 'connected' or if it's a verifiable generic network error.
                    // For simplicity: If loggedOut -> Stop.
                    // If we were parsing QR and connection closed -> likely timed out -> Stop (allow user to retry manually).
                    // EXCEPTION: Status 515 (Stream Errored) is common and should retry even during QR scan

                    if (this.status === 'scan_qr' && statusCode !== 515) {
                        console.log(`${this.logPrefix} Connection closed while scanning QR. Stopping auto-retry to prevent loop.`);
                        this.status = 'disconnected';
                        this.qr = null;
                        this.sock = null;
                        return;
                    }

                    this.status = 'disconnected';
                    this.qr = null;

                    if (shouldReconnect) {
                        console.log(`${this.logPrefix} Reconnecting in 5s...`);
                        // Backoff
                        setTimeout(() => this.connect(), 5000); // Call connect() instead of start()
                    } else {
                        console.log(`${this.logPrefix} Logged out. Delete session to restart.`);
                        this.sock = null;
                    }
                } else if (connection === 'open') {
                    console.log(`${this.logPrefix} Connection opened`);
                    this.status = 'connected';
                    this.qr = null;
                    this.reconnectAttempts = 0; // Reset on success
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('contacts.upsert', (contacts) => {
                for (const contact of contacts) {
                    // Update LID Map
                    if (contact.lid) {
                        const phone = contact.id.split('@')[0];
                        this.lidMap.set(contact.lid, phone);
                        this.lidMap.set(`${contact.lid}@lid`, phone);
                    }

                    // Update Contact Map
                    // We merge existing data because updates might be partial
                    const existing = this.contacts.get(contact.id) || {};
                    const updated = {
                        ...existing,
                        ...contact,
                        name: contact.name || existing.name,
                        notify: contact.notify || existing.notify
                    };

                    // Only store if we have some useful info beyond just ID
                    if (updated.name || updated.notify) {
                        this.contacts.set(contact.id, updated);
                    }
                }
            });

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    if (!msg.message || msg.message.protocolMessage) continue;
                    await this.handleMessage(msg);
                }
            });

        } catch (err) {
            console.error(`${this.logPrefix} Connect Error:`, err);
            this.status = 'disconnected';
        }
    }

    async handleMessage(msg) {
        try {
            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast' || msg.key.fromMe) return;

            let phoneNumber = remoteJid.split('@')[0];

            // Handle LID: If remoteJid is an LID, check if we have a participant (likely the real phone JID)
            // This happens when a primary device sends a message to the bot (assistant)
            if (remoteJid.includes('@lid')) {
                if (msg.key.participant) {
                    const participantNumber = msg.key.participant.split('@')[0];
                    if (participantNumber) {
                        console.log(`${this.logPrefix} Resolving LID (via participant) ${phoneNumber} to ${participantNumber}`);
                        phoneNumber = participantNumber;
                    }
                } else if (this.lidMap.has(remoteJid)) {
                    // Fallback to internal map
                    const resolvedMapNumber = this.lidMap.get(remoteJid);
                    console.log(`${this.logPrefix} Resolving LID (via map) ${phoneNumber} to ${resolvedMapNumber}`);
                    phoneNumber = resolvedMapNumber;
                }
            }

            // Security Check
            if (this.allowedNumbers.size === 0) {
                console.warn(`${this.logPrefix} Ignored message from ${phoneNumber} because ALLOWED_WHATSAPP_NUMBERS is empty (Secure Mode).`);
                return;
            }

            if (!this.allowedNumbers.has(phoneNumber)) {
                console.warn(`${this.logPrefix} Blocked message from unauthorized number: ${phoneNumber}`);
                return;
            }

            console.log(`${this.logPrefix} Received from ${phoneNumber}`);

            // Unwrapping Logic
            let messageContent = msg.message;
            if (messageContent.ephemeralMessage) {
                messageContent = messageContent.ephemeralMessage.message;
            } else if (messageContent.viewOnceMessage) {
                messageContent = messageContent.viewOnceMessage.message;
            } else if (messageContent.viewOnceMessageV2) {
                messageContent = messageContent.viewOnceMessageV2.message;
            } else if (messageContent.documentWithCaptionMessage) {
                messageContent = messageContent.documentWithCaptionMessage.message;
            }

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
                        console.log(`${this.logPrefix} Downloaded audio: ${buffer.length} bytes`);
                    } catch (e) {
                        console.error(`${this.logPrefix} Audio Download Failed:`, e);
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
                        console.log(`${this.logPrefix} Downloaded image: ${buffer.length} bytes`);
                    } catch (e) {
                        console.error(`${this.logPrefix} Image Download Failed:`, e);
                    }
                }
            } else {
                // Unknown / Protocol Message / Reaction
                console.log(`${this.logPrefix} Ignored unhandled message type keys: ${Object.keys(messageContent).join(', ')}`);
                return;
            }

            if (!text && !buffer) {
                console.warn(`${this.logPrefix} Received message with no content (empty text and no media). Ignoring.`);
                return;
            }

            const userMessage = createUserMessage(text, 'whatsapp', phoneNumber);
            // Append session ID to metadata
            userMessage.metadata = { chatId: remoteJid, phoneNumber, session: this.sessionId };

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

            // Mark as read - DISABLED to prevent "Online" status (Ghost Mode)
            // await this.sock.readMessages([msg.key]);

        } catch (err) {
            console.error(`${this.logPrefix} Message Handler Error:`, err.message);
        }
    }

    async sendMessage(toJid, content, options = {}) {
        if (!this.sock) throw new Error(`${this.logPrefix} WhatsApp not initialized`);

        try {
            const type = options.type || 'text';
            console.log(`${this.logPrefix} Sending ${type} to ${toJid}`);

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
            console.error(`${this.logPrefix} Send Failed:`, e.message);
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
            console.error(`${this.logPrefix} Disconnect Error:`, e);
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
            me: formattedMe,
            session: this.sessionId
        };
    }

    searchContacts(query) {
        if (!query) return [];
        const q = query.toLowerCase();
        const results = [];

        for (const [id, contact] of this.contacts.entries()) {
            const name = (contact.name || '').toLowerCase();
            const notify = (contact.notify || '').toLowerCase();
            const phone = id.split('@')[0];

            if (name.includes(q) || notify.includes(q) || phone.includes(q)) {
                results.push({
                    id: contact.id,
                    name: contact.name,
                    notify: contact.notify,
                    phone
                });
            }
        }
        return results;
    }

    getContacts() {
        return Array.from(this.contacts.values()).map(c => ({
            id: c.id,
            name: c.name,
            notify: c.notify,
            phone: c.id.split('@')[0]
        }));
    }
}

module.exports = { WhatsAppService };
