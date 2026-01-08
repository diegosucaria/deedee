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
        // this.contacts removed in favor of this.store
        this.store = null;

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

            // Dynamic Import via helper
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage, makeInMemoryStore } = await this._importBaileys();
            this.downloadMediaMessage = downloadMediaMessage; // Save for later use

            // Initialize Store if not already done
            if (!this.store) {
                this.store = makeInMemoryStore({});
                const storePath = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), `baileys_store_${this.sessionId}.json`);
                try {
                    this.store.readFromFile(storePath);
                    console.log(`${this.logPrefix} Store loaded from ${storePath}`);
                } catch (e) {
                    console.log(`${this.logPrefix} No store found at ${storePath}, creating new.`);
                }

                // Save store periodically
                setInterval(() => {
                    try {
                        this.store.writeToFile(storePath);
                    } catch (e) { console.error(`${this.logPrefix} Store save failed`, e); }
                }, 10_000);
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 60000, // Increased timeout
                keepAliveIntervalMs: 30000,
                syncFullHistory: true,
                markOnlineOnConnect: false // Do not show "Online" status automatically,
                // getMessage: async (key) => { ... } // Optional: support history reading for bots
            });

            // Bind Store
            this.store.bind(this.sock.ev);

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
                        if (this.reconnectAttempts >= 10) {
                            console.error(`${this.logPrefix} Too many 515 errors. Corruption likely. Wiping session.`);
                            await this.disconnect(true); // Explicit wipe
                            // Restart to generate NEW QR
                            setTimeout(() => this.start(), 1000);
                            return;
                        }
                    }

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
                        setTimeout(() => this.connect(), 5000);
                    } else {
                        console.log(`${this.logPrefix} Logged out by Server. Clearing session.`);
                        await this.disconnect(true); // Wipe if server says logged out
                    }
                } else if (connection === 'open') {
                    console.log(`${this.logPrefix} Connection opened`);
                    this.status = 'connected';
                    this.qr = null;
                    this.reconnectAttempts = 0; // Reset on success

                    // Log contacts count
                    const contactCount = Object.keys(this.store.contacts).length;
                    console.log(`${this.logPrefix} Store has ${contactCount} contacts.`);
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

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
            if (remoteJid.includes('@lid')) {
                if (msg.key.participant) {
                    const participantNumber = msg.key.participant.split('@')[0];
                    if (participantNumber) {
                        console.log(`${this.logPrefix} Resolving LID (via participant) ${phoneNumber} to ${participantNumber}`);
                        phoneNumber = participantNumber;
                    }
                } else if (this.lidMap.has(remoteJid)) {
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
                return;
            }

            if (!text && !buffer) {
                console.warn(`${this.logPrefix} Received message with no content. Ignoring.`);
                return;
            }

            const userMessage = createUserMessage(text, 'whatsapp', phoneNumber);
            // Append session ID to metadata
            userMessage.metadata = { chatId: remoteJid, phoneNumber, session: this.sessionId };

            // Inline Data for Agent
            if (buffer) {
                userMessage.parts = userMessage.parts || [];
                userMessage.parts.push({
                    inlineData: {
                        mimeType: mimeType || (type === 'audio' ? 'audio/ogg' : 'image/jpeg'),
                        data: buffer.toString('base64')
                    }
                });
            }

            await axios.post(`${this.agentUrl}/webhook`, userMessage);

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
                const buffer = Buffer.from(content, 'base64');
                await this.sock.sendMessage(toJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            } else if (type === 'image') {
                const buffer = Buffer.from(content, 'base64');
                await this.sock.sendMessage(toJid, { image: buffer });
            }

        } catch (e) {
            console.error(`${this.logPrefix} Send Failed:`, e.message);
            throw e;
        }
    }

    async disconnect(clearSession = false) {
        try {
            if (this.sock) {
                // Only calling logout if we intend to clear session or if socket is active?
                // logout() sends a query to server to invalidate creds.
                // If we just want to stop, we should use end()
                if (clearSession) {
                    await this.sock.logout();
                } else {
                    this.sock.end(undefined); // Just close connection
                }
                this.sock = null;
            }
            this.status = 'disconnected';

            if (clearSession) {
                if (fs.existsSync(this.authFolder)) {
                    console.log(`${this.logPrefix} Deleting session files...`);
                    fs.rmSync(this.authFolder, { recursive: true, force: true });
                }
            }
        } catch (e) {
            console.error(`${this.logPrefix} Disconnect Error:`, e);
        }
    }

    getStatus() {
        const me = this.sock?.user;
        let formattedMe = null;
        if (me) {
            formattedMe = {
                id: me.id.split(':')[0].split('@')[0],
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
        if (!query || !this.store) return [];
        const q = query.toLowerCase();

        // this.store.contacts is an object { id: { ... } }
        const contacts = Object.values(this.store.contacts);
        console.log(`${this.logPrefix} Searching contacts for: "${q}". Total in store: ${contacts.length}`);

        const results = [];

        for (const contact of contacts) {
            const name = (contact.name || '').toLowerCase();
            const notify = (contact.notify || '').toLowerCase();
            const phone = contact.id.split('@')[0];

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
        if (!this.store) return [];
        return Object.values(this.store.contacts).map(c => ({
            id: c.id,
            name: c.name,
            notify: c.notify,
            phone: c.id.split('@')[0]
        }));
    }
}

module.exports = { WhatsAppService };
