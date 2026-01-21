const { createUserMessage } = require('@deedee/shared/src/types');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');

class SQLiteStore {
    constructor(filePath) {
        this.path = filePath;
        this.db = new Database(filePath);
        this.init();
    }

    init() {
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT,
                notify TEXT,
                lid TEXT,
                data TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                key_id TEXT,
                remote_jid TEXT,
                from_me INTEGER,
                timestamp INTEGER,
                content TEXT,
                data TEXT,
                PRIMARY KEY (key_id, remote_jid)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(remote_jid, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);
        `);
    }

    // --- Helper Methods ---

    async upsertContacts(contacts) {
        if (!contacts || contacts.length === 0) return;
        const BATCH_SIZE = 300;

        const stmt = this.db.prepare(`
            INSERT INTO contacts (id, name, notify, lid, data)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
            name=coalesce(excluded.name, name),
            notify=coalesce(excluded.notify, notify),
            lid=coalesce(excluded.lid, lid),
            data=excluded.data
        `);

        const insertBatch = this.db.transaction((items) => {
            for (const c of items) {
                stmt.run(c.id, c.name, c.notify, c.lid, JSON.stringify(c));
            }
        });

        // Async Batching
        const total = contacts.length;
        console.log(`[SQLiteStore] Upserting ${total} contacts...`);
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = contacts.slice(i, i + BATCH_SIZE);
            insertBatch(batch);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        console.log(`[SQLiteStore] Finished upserting ${total} contacts.`);
    }

    async upsertMessages(messages, type) {
        // 'append' is for history sync
        if (type !== 'notify' && type !== 'append') return;

        const total = messages.length;
        console.log(`[SQLiteStore] upsertMessages called with ${total} msgs (Type: ${type})`);

        const BATCH_SIZE = 3000;

        const stmt = this.db.prepare(`
            INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key_id, remote_jid) DO NOTHING
        `);

        const insertBatch = this.db.transaction((msgs) => {
            const now = Date.now() / 1000;
            for (const msg of msgs) {
                const jid = msg.key.remoteJid;
                if (!jid) continue;
                // Ignore protocol messages
                if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

                const ts = (typeof msg.messageTimestamp === 'number')
                    ? msg.messageTimestamp
                    : (msg.messageTimestamp?.low || now);

                // Debug first message in batch
                // if (msgs.indexOf(msg) === 0) console.log(`[SQLiteStore] Sample TS: ${ts} (Now: ${now})`);

                // Content Snippet
                let content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                if (!content) {
                    if (msg.message?.audioMessage) content = '[Audio]';
                    else if (msg.message?.imageMessage) content = '[Image]';
                    else if (msg.message?.stickerMessage) content = '[Sticker]';
                    else if (msg.message?.videoMessage) content = '[Video]';
                    else content = '[Media]';
                }

                stmt.run(
                    msg.key.id,
                    jid,
                    msg.key.fromMe ? 1 : 0,
                    ts,
                    content,
                    JSON.stringify(msg)
                );
            }
        });

        const batchSize = Math.min(total, BATCH_SIZE);
        // Log only if significant batch (avoids spam on live chat)
        // if (total > 50) console.log(`[SQLiteStore] Upserting ${total} messages...`); // We logged at top already

        // Async Chunking
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = messages.slice(i, i + BATCH_SIZE);
            insertBatch(batch);
            if (total > BATCH_SIZE) await new Promise(resolve => setTimeout(resolve, 5));
        }

        if (total > 50) console.log(`[SQLiteStore] Finished upserting ${total} messages.`);
    }

    bind(ev) {
        ev.on('contacts.upsert', (contacts) => this.upsertContacts(contacts));

        ev.on('contacts.update', (updates) => {
            const stmt = this.db.prepare(`
                UPDATE contacts SET 
                name=coalesce(?, name),
                notify=coalesce(?, notify),
                lid=coalesce(?, lid),
                data=?
                WHERE id=?
            `);
            const transaction = this.db.transaction((updates) => {
                for (const u of updates) {
                    // We need to merge with existing data json... 
                    const existing = this.db.prepare('SELECT data FROM contacts WHERE id = ?').get(u.id);
                    if (existing) {
                        const data = JSON.parse(existing.data);
                        const merged = { ...data, ...u };
                        stmt.run(u.name || null, u.notify || null, u.lid || null, JSON.stringify(merged), u.id);
                    }
                }
            });
            transaction(updates);
        });

        ev.on('messages.upsert', ({ messages, type }) => this.upsertMessages(messages, type));
    }

    // --- Access Methods ---

    getGlobalUserHistory(limit) {
        // from_me = 1 means sent by the user account owner
        const rows = this.db.prepare(`
            SELECT data FROM messages 
            WHERE from_me = 1 
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(limit);

        return rows.reverse().map(r => {
            const m = JSON.parse(r.data);
            let content = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            // Only care about text for style analysis
            return {
                role: 'user', // "User" from the Agent's perspective (it's the user speaking)
                content,
                timestamp: (typeof m.messageTimestamp === 'number' ? m.messageTimestamp : m.messageTimestamp?.low) * 1000
            };
        }).filter(m => m.content && m.content.length > 5); // Filter noise
    }

    getContacts() {
        return this.db.prepare('SELECT * FROM contacts').all().map(r => ({ ...JSON.parse(r.data), ...r }));
    }

    getContact(jid) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(jid);
        return row ? { ...JSON.parse(row.data), ...row } : null;
    }

    getAllContactsRaw() {
        // For searchContacts compatibility which expects array of objects
        return this.getContacts();
    }

    getChatHistory(jid, limit = 50) {
        const rows = this.db.prepare(`
            SELECT data FROM messages 
            WHERE remote_jid = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(jid, limit);

        return rows.reverse().map(r => JSON.parse(r.data));
    }

    getRecentChats(limit = 10) {
        const rows = this.db.prepare(`
            SELECT remote_jid, MAX(timestamp) as last_ts, COUNT(*) as count 
            FROM messages 
            WHERE remote_jid NOT LIKE '%@g.us' 
            GROUP BY remote_jid 
            ORDER BY last_ts DESC 
            LIMIT ?
        `).all(limit);

        return rows.map(r => {
            // Get snippets
            const msgs = this.db.prepare('SELECT content FROM messages WHERE remote_jid = ? ORDER BY timestamp DESC LIMIT 3').all(r.remote_jid);
            return {
                jid: r.remote_jid,
                lastTimestamp: r.last_ts * 1000,
                msgCount: r.count,
                snippets: msgs.map(m => m.content).reverse()
            };
        });
    }

    // Check if a JID exists in messages (normalization helper)
    hasOutputForJid(jid) {
        const row = this.db.prepare('SELECT 1 FROM messages WHERE remote_jid = ? LIMIT 1').get(jid);
        return !!row;
    }

    getContactByLid(lid) {
        const row = this.db.prepare('SELECT id FROM contacts WHERE lid = ?').get(lid);
        return row ? row.id : null;
    }

    findFuzzyJid(digits) {
        const row = this.db.prepare('SELECT remote_jid FROM messages WHERE remote_jid LIKE ? LIMIT 1').get(digits + '%');
        return row ? row.remote_jid : null;
    }

    // --- Stats ---
    getStats() {
        try {
            const contacts = this.db.prepare('SELECT COUNT(*) as count FROM contacts').get()?.count || 0;
            const messages = this.db.prepare('SELECT COUNT(*) as count FROM messages').get()?.count || 0;

            // DB Size
            const fs = require('fs');
            let size = 0;
            try {
                const stats = fs.statSync(this.path);
                size = stats.size;
            } catch (e) {
                // Ignore
            }

            return {
                contacts,
                messages,
                sizeBytes: size
            };
        } catch (e) {
            console.error('Failed to get stats:', e);
            return { error: e.message };
        }
    }
}

class WhatsAppService {
    constructor(agentUrl, sessionId = 'default') {
        this.agentUrl = agentUrl;
        this.sessionId = sessionId;
        this.sock = null;
        this.qr = null;
        this.status = 'disconnected';
        this.reconnectAttempts = 0;
        this.store = null;
        this.reconnectTimeout = null;

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

            // Using SQLiteStore
            // makeInMemoryStore removed.

            // ... inside connect ...
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage } = await this._importBaileys();
            this.downloadMediaMessage = downloadMediaMessage;

            // Initialize Store
            if (!this.store) {
                const storePath = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), `messages_${this.sessionId}.db`);
                console.log(`${this.logPrefix} Initializing SQLite Store at ${storePath}`);
                this.store = new SQLiteStore(storePath);
            }

            // ... inside connect ...
            // (Previous code removed)

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            this.sock = makeWASocket({
                auth: state,
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 60000, // Increased timeout
                keepAliveIntervalMs: 30000,
                syncFullHistory: true, // Request full history
                markOnlineOnConnect: false, // Do not show "Online" status automatically
                browser: ['DeeDee', 'Chrome', '1.0.0'], // Fixes notification loss on phone
                // getMessage: async (key) => { ... } // Optional: support history reading for bots
            });

            // Bind Store
            this.store.bind(this.sock.ev);

            // History Sync - Critical for initial contacts
            this.sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
                if (contacts && contacts.length > 0) {
                    console.log(`${this.logPrefix} History Sync: Received ${contacts.length} contacts.`);
                    this.store.upsertContacts(contacts);
                }
                // Handle synced messages
                if (messages && messages.length > 0) {
                    console.log(`${this.logPrefix} History Sync: Received ${messages.length} messages.`);
                    this.store.upsertMessages(messages, 'append');
                }
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
                    // Clear presence interval
                    if (this.presenceInterval) {
                        clearInterval(this.presenceInterval);
                        this.presenceInterval = null;
                    }

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
                            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                            this.reconnectTimeout = setTimeout(() => this.start(), 1000);
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
                        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
                    } else {
                        console.log(`${this.logPrefix} Logged out by Server. Clearing session.`);
                        await this.disconnect(true); // Wipe if server says logged out
                    }
                } else if (connection === 'open') {
                    console.log(`${this.logPrefix} Connection opened`);
                    this.status = 'connected';
                    this.qr = null;
                    this.reconnectAttempts = 0; // Reset on success

                    // FORCE PASSIVE STATE to restore Phone Notifications
                    const setPassive = async () => {
                        try {
                            await this.sock.sendPresenceUpdate('unavailable');
                            console.log(`${this.logPrefix} Asserted 'unavailable' presence.`);
                        } catch (e) {
                            console.warn(`${this.logPrefix} Failed to set presence:`, e);
                        }
                    };

                    // 1. Immediate (delayed)
                    const { delay } = await this._importBaileys();
                    await delay(2000);
                    await setPassive();

                    // 2. Periodic Re-assertion (Every 10 mins)
                    // This counters any implicit "Active" status drift
                    if (this.presenceInterval) clearInterval(this.presenceInterval);
                    this.presenceInterval = setInterval(setPassive, 10 * 60 * 1000);

                    // Log contacts count
                    const contactCount = this.store.getContacts().length;
                    console.log(`${this.logPrefix} Store has ${contactCount} contacts.`);
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                console.log(`${this.logPrefix} [DEBUG] Upsert: ${messages.length} messages. Type: ${type}`);

                for (const msg of messages) {
                    // Check if it's potentially interesting
                    const isProtocol = !!msg.message?.protocolMessage;
                    const msgKeys = Object.keys(msg.message || {}).join(',');

                    // Debug Log
                    let ts = msg.messageTimestamp;
                    if (ts && typeof ts !== 'number') ts = ts.low || ts;
                    const nowSeconds = Math.floor(Date.now() / 1000);
                    const age = ts ? (nowSeconds - ts) : 0;

                    console.log(`${this.logPrefix} [DEBUG] Msg: ID=${msg.key.id} Protocol=${isProtocol} Type=${type} Age=${age}s Keys=${msgKeys}`);

                    if (!msg.message || msg.message.protocolMessage) continue;

                    // Pass to handler (Decides whether to process based on age/type)
                    await this.handleMessage(msg, type);
                }
            });

        } catch (err) {
            console.error(`${this.logPrefix} Connect Error:`, err);
            this.status = 'disconnected';
        }
    }

    async handleMessage(msg, type = 'notify') {
        try {
            // 0. Age Check (Prevent History Flood)
            let ts = msg.messageTimestamp;
            if (ts && typeof ts !== 'number') ts = ts.low || ts;
            const age = ts ? (Math.floor(Date.now() / 1000) - ts) : 0;

            if (type === 'append' && age > 300) {
                // Silently ignore old history messages
                // console.log(`${this.logPrefix} Ignoring old history message (Age: ${age}s)`);
                return;
            }

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
                } else if (this.store) {
                    const resolvedJid = this.store.getContactByLid(remoteJid);
                    if (resolvedJid) {
                        const resolvedPhone = resolvedJid.split('@')[0];
                        console.log(`${this.logPrefix} Resolving LID (via DB) ${phoneNumber} to ${resolvedPhone}`);
                        phoneNumber = resolvedPhone;
                    }
                }
            }

            // Security Check
            // RELAXED for 'user' session (Passive Mode) - We want to read EVERYTHING
            if (this.sessionId !== 'user') {
                if (this.allowedNumbers.size === 0) {
                    console.warn(`${this.logPrefix} Ignored message from ${phoneNumber} because ALLOWED_WHATSAPP_NUMBERS is empty (Secure Mode).`);
                    return;
                }

                if (!this.allowedNumbers.has(phoneNumber)) {
                    console.warn(`${this.logPrefix} Blocked message from unauthorized number: ${phoneNumber}`);
                    return;
                }
            } else {
                // For user session, we might want to log that we are processing a message from a non-allowed number
                if (!this.allowedNumbers.has(phoneNumber)) {
                    // console.log(`${this.logPrefix} Passive Mode: Processing message from ${phoneNumber}`);
                }
            }

            if (this.sessionId !== 'user') {
                console.log(`${this.logPrefix} Received from ${phoneNumber}`);
            }

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

            // Distinguish Source like 'whatsapp:user' vs 'whatsapp:assistant'
            const source = `whatsapp:${this.sessionId}`;
            const userMessage = createUserMessage(text, source, phoneNumber);

            // Append session ID to metadata
            const isGroup = remoteJid.endsWith('@g.us');
            userMessage.metadata = {
                chatId: remoteJid,
                phoneNumber,
                session: this.sessionId,
                isGroup,
                groupName: isGroup ? 'Unknown Group' : undefined // We could fetch subject if needed
            };

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
            console.log(`${this.logPrefix} Disconnecting... (Clear: ${clearSession})`);
            if (this.sock) {
                if (clearSession) {
                    try {
                        await this.sock.logout();
                    } catch (err) {
                        console.warn(`${this.logPrefix} Logout failed (ignoring): ${err.message}`);
                    }
                } else {
                    this.sock.end(undefined);
                }
                this.sock = null;
            }

            if (clearSession) {
                if (fs.existsSync(this.authFolder)) {
                    console.log(`${this.logPrefix} Deleting session files...`);
                    try {
                        fs.rmSync(this.authFolder, { recursive: true, force: true });
                    } catch (e) {
                        console.error(`${this.logPrefix} Failed to delete session files:`, e);
                    }
                }
            }
        } catch (e) {
            console.error(`${this.logPrefix} Disconnect Error:`, e);
        } finally {
            // CRITICAL: Always reset status to allow reconnect
            this.status = 'disconnected';
            this.qr = null;
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }
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
            session: this.sessionId,
            stats: this.store ? this.store.getStats() : null
        };
    }

    searchContacts(query) {
        if (!query || !this.store) return [];
        const q = query.toLowerCase();

        // Use store method
        const contacts = this.store.getAllContactsRaw();
        console.log(`${this.logPrefix} Searching ${contacts.length} contacts for: "${q}"...`);

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
        return this.store.getContacts().map(c => ({
            id: c.id,
            name: c.name,
            notify: c.notify,
            phone: c.id.split('@')[0]
        }));
    }

    getContact(jid) {
        if (!this.store) return null;
        const c = this.store.getContact(jid);
        if (!c) return null;
        return {
            id: c.id,
            name: c.name,
            notify: c.notify,
            phone: c.id.split('@')[0]
        };
    }

    // Helper for safe timestamp conversion (handles Number vs Long)
    _getSafeTimestamp(ts) {
        if (typeof ts === 'number') return ts;
        if (ts && typeof ts.toNumber === 'function') return ts.toNumber();
        if (ts && typeof ts.low === 'number') return ts.low;
        return 0;
    }

    // --- New Methods for Smart Learn ---

    getRecentChats(limit = 10) {
        if (!this.store) return [];
        return this.store.getRecentChats(limit);
    }

    getChatHistory(jid, limit = 50) {
        if (!this.store) {
            console.warn(`${this.logPrefix} Store empty.`);
            return [];
        }

        // Logic to handle Split JIDs (ID vs LID, and Country Code Prefix issues)
        // 1. Sanitize Input
        const inputDigits = jid.replace(/[^0-9]/g, '');
        const isLid = jid.includes('@lid');

        let candidateJids = new Set();

        // 2. Identify Primary Candidates (Phone JIDs)
        if (isLid) {
            candidateJids.add(jid);
            // Try to find the Phone JID for this LID
            const row = this.store.db.prepare('SELECT id FROM contacts WHERE lid = ?').get(jid);
            if (row && row.id) candidateJids.add(row.id);
        } else {
            // It is a phone number (or partial)
            if (inputDigits.length >= 7) {
                // Fuzzy Search for Phone JIDs (handles 549 vs 54)
                // Using 7 to be safe and inclusive
                const suffix = inputDigits.slice(-7); // Last 7 digits
                const rows = this.store.db.prepare("SELECT DISTINCT remote_jid FROM messages WHERE remote_jid LIKE ? AND remote_jid NOT LIKE '%@lid'").all(`%${suffix}%`);
                rows.forEach(r => candidateJids.add(r.remote_jid));
            } else {
                // Short number or exact
                const norm = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
                candidateJids.add(norm);
            }
        }

        // 3. Expand to include linked LIDs/IDs
        // For every Candidate JID found so far, find its partner (Phone <-> LID)
        const currentList = Array.from(candidateJids);
        if (currentList.length > 0) {
            const placeholders = currentList.map(() => '?').join(',');

            // Find LIDs for these Phone IDs
            const lids = this.store.db.prepare(`SELECT lid FROM contacts WHERE id IN (${placeholders})`).all(...currentList);
            lids.forEach(r => { if (r.lid) candidateJids.add(r.lid); });

            // Find IDs for these LIDs (bidirectional check)
            const ids = this.store.db.prepare(`SELECT id FROM contacts WHERE lid IN (${placeholders})`).all(...currentList);
            ids.forEach(r => { if (r.id) candidateJids.add(r.id); });
        }

        // 4. Fallback (if still empty)
        if (candidateJids.size === 0) {
            const norm = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
            candidateJids.add(norm);
        }

        const targetJids = Array.from(candidateJids);
        console.log(`${this.logPrefix} Fetching history for ${jid}. Resolved targets: ${targetJids.join(', ')}`);

        // Query IN (...)
        const queryPlaceholders = targetJids.map(() => '?').join(',');
        const rows = this.store.db.prepare(`
            SELECT data FROM messages 
            WHERE remote_jid IN (${queryPlaceholders})
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(...targetJids, limit);

        return rows.reverse().map(r => {
            const m = JSON.parse(r.data);

            // Simplify for agent consumption
            let content = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
            const msgType = Object.keys(m.message || {})[0];

            if (!content) {
                if (m.message?.audioMessage) content = '[Audio Message]';
                else if (m.message?.imageMessage) content = `[Image: ${m.message.imageMessage.caption || ''}]`;
                else if (m.message?.videoMessage) content = `[Video: ${m.message.videoMessage.caption || ''}]`;
                else if (m.message?.stickerMessage) content = '[Sticker]';
                else content = `[Media: ${msgType}]`;
            }

            const fromMe = m.key.fromMe;
            return {
                role: fromMe ? 'assistant' : 'user',
                content,
                timestamp: this._getSafeTimestamp(m.messageTimestamp) * 1000
            };
        });
    }

    async getProfilePicture(jid) {
        if (!this.sock) return null;
        try {
            return await this.sock.profilePictureUrl(jid, 'image');
        } catch (e) {
            // 404/401 implies no picture
            return null;
        }
    }
    getGlobalUserHistory(limit = 500) {
        if (!this.store) return [];
        return this.store.getGlobalUserHistory(limit);
    }
}

module.exports = { WhatsAppService, SQLiteStore };
