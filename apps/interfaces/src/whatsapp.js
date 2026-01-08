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
                        if (this.reconnectAttempts >= 5) {
                            console.error(`${this.logPrefix} Too many 515 errors. Corruption likely. Wiping session.`);
                            await this.disconnect();
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
                        console.log(`${this.logPrefix} Logged out. Delete session to restart.`);
                        this.sock = null;
                        this.store = null; // Clear store on logout?
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

    // ... handleMessage ...

    // ... sendMessage ...

    // ... disconnect ...

    // ... getStatus ...

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
