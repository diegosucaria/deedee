const { createUserMessage } = require('@deedee/shared/src/types');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

/**
 * Converts a WAV audio buffer to OGG/Opus format using ffmpeg.
 * Required because WhatsApp PTT messages must be OGG/Opus encoded.
 * Falls back to the original buffer if ffmpeg is unavailable.
 */
function convertToOpus(wavBuffer) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-c:a', 'libopus',
            '-b:a', '48k',
            '-application', 'voip',
            '-f', 'ogg',
            'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        const chunks = [];
        ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });
        ffmpeg.on('error', (err) => {
            // ffmpeg not installed — fall back to raw buffer
            console.warn('[WhatsApp] ffmpeg not available, sending audio without conversion:', err.message);
            resolve(wavBuffer);
        });
        ffmpeg.stdin.write(wavBuffer);
        ffmpeg.stdin.end();
    });
}

class SQLiteStore {
    constructor(filePath) {
        this.path = filePath;
        this.db = new Database(filePath);
        this.init();

        // Queue System
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.queueFlushInterval = null;

        // Start Queue Processor
        this.startQueueProcessor();
    }

    startQueueProcessor() {
        if (this.queueFlushInterval) clearInterval(this.queueFlushInterval);
        this.queueFlushInterval = setInterval(() => this.processQueue(), 500); // Check every 500ms
    }

    async processQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) return;

        this.isProcessingQueue = true;

        try {
            // Process max 200 items at a time
            const BATCH_SIZE = 200;
            const batch = this.messageQueue.splice(0, BATCH_SIZE);

            if (batch.length > 0) {
                // Log only occasionally or for large batches
                if (batch.length > 50) console.log(`[SQLiteStore] Processing queue batch: ${batch.length} items. Remaining: ${this.messageQueue.length}`);

                const stmt = this.db.prepare(`
                    INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key_id, remote_jid) DO NOTHING
                `);

                const insertTransaction = this.db.transaction((msgs) => {
                    const now = Date.now() / 1000;
                    for (const msg of msgs) {
                        try {
                            const jid = msg.key.remoteJid;
                            if (!jid) continue;

                            // Ignore protocol messages
                            if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

                            const ts = (typeof msg.messageTimestamp === 'number')
                                ? msg.messageTimestamp
                                : (msg.messageTimestamp?.low || now);

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
                        } catch (e) {
                            console.error('[SQLiteStore] Error processing individual message in queue:', e.message);
                        }
                    }
                });

                // Execute transaction synchronously (on background tick) - Wrapped for Safety
                try {
                    insertTransaction(batch);
                } catch (txError) {
                    console.error('[SQLiteStore] Transaction Failed!', txError);
                    if (txError.code) console.error(`[SQLiteStore] Error Code: ${txError.code}`);
                    // Optional: Re-queue batch? For now, we drop to prevent loop death, or user can decide.
                    // If we re-queue, we risk infinite loop if it's a data issue.
                }
            }
        } catch (e) {
            console.error('[SQLiteStore] Queue Processing Failed:', e);
        } finally {
            this.isProcessingQueue = false;

            // If more items, trigger immediately
            if (this.messageQueue.length > 0) {
                setImmediate(() => this.processQueue());
            }
        }

    }

    close() {
        if (this.db) {
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
                this.db.close();
                this.db = null;
                console.log('[SQLiteStore] Database closed with WAL checkpoint.');
            } catch (err) {
                console.error('[SQLiteStore] Error closing database:', err.message);
            }
        }
    }

    init() {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('temp_store = MEMORY');
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
        try {
            // 'append' is for history sync, 'notify' is for new messages
            if (type !== 'notify' && type !== 'append') return;

            // Push to memory queue (FAST - Non-blocking)
            // console.log(`[SQLiteStore] Enqueueing ${messages.length} messages (Total in queue: ${this.messageQueue.length + messages.length})`);
            this.messageQueue.push(...messages);

            // Trigger processing on next tick if not running
            if (!this.isProcessingQueue) {
                setImmediate(() => this.processQueue());
            }
        } catch (e) {
            console.error('[SQLiteStore] Upsert Enqueue Failed:', e);
        }
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
            SELECT data, timestamp FROM messages 
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
                timestamp: r.timestamp * 1000
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

    getContactByLid(lid) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE lid = ?').get(lid);
        return row ? { ...JSON.parse(row.data), ...row } : null;
    }

    getAllContactsRaw() {
        // For searchContacts compatibility which expects array of objects
        return this.getContacts();
    }

    getChatHistory(jid, limit = 50) {
        let targetJid = jid;

        // 1. Primary Query
        let rows = this.db.prepare(`
            SELECT data FROM messages 
            WHERE remote_jid = ? 
            ORDER BY timestamp DESC 
            LIMIT ?
        `).all(targetJid, limit);

        // 2. Smart Resolution (Retry if empty)

        if (rows.length === 0) {
            let resolvedJid = null;

            // Case A: Explicit LID (@lid)
            if (targetJid.includes('@lid')) {
                const contact = this.getContactByLid(targetJid);
                if (contact && contact.id) resolvedJid = contact.id;
            }
            // Case B: Digits only or Wrong Domain (e.g. LID_NUMBER@s.whatsapp.net)
            else {
                // Heuristic: LIDs are usually 15 digits (longer than phone numbers which are ~10-13)
                const digits = targetJid.split('@')[0].replace(/[^0-9]/g, '');
                if (digits.length > 14) {
                    // Try constructing valid LID
                    const potentialLid = `${digits}@lid`;
                    const contact = this.getContactByLid(potentialLid);
                    if (contact && contact.id) resolvedJid = contact.id;
                }
            }

            if (resolvedJid) {
                console.log(`[SQLiteStore] History Auto-Resolve: ${targetJid} -> ${resolvedJid}`);
                targetJid = resolvedJid;
                rows = this.db.prepare(`
                    SELECT data FROM messages 
                    WHERE remote_jid = ? 
                    ORDER BY timestamp DESC 
                    LIMIT ?
                `).all(targetJid, limit);
            }
        }

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

    // New Helper: Get single message by key (for retries)
    getMessageByKey(keyId, remoteJid) {
        // We only store 'data' blob which is the full proto
        // The table composite key is (key_id, remote_jid)
        const row = this.db.prepare('SELECT data FROM messages WHERE key_id = ? AND remote_jid = ?').get(keyId, remoteJid);
        if (row && row.data) {
            return JSON.parse(row.data); // Returns full WebMessageInfo object
        }
        return null;
    }

    // Check if a JID exists in messages (normalization helper)
    hasOutputForJid(jid) {
        const row = this.db.prepare('SELECT 1 FROM messages WHERE remote_jid = ? LIMIT 1').get(jid);
        return !!row;
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
        this.sleepTimeout = null;
        this.presenceInterval = null;
        this.heartbeatTimer = null;
        this.lastHeartbeat = Date.now();
        this.isReconnecting = false;

        // Reconnection Config (Standard)
        this.reconnectConfig = {
            initialMs: 1000,
            maxMs: 60000,
            factor: 1.5,
            jitter: 0.2
        };

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

    calculateBackoff() {
        const { initialMs, maxMs, factor, jitter } = this.reconnectConfig;
        const delay = Math.min(initialMs * Math.pow(factor, this.reconnectAttempts), maxMs);
        const jitterAmount = delay * jitter;
        const jittered = delay + (Math.random() * jitterAmount * 2 - jitterAmount);
        return Math.floor(jittered);
    }

    startHeartbeatLoop() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        console.log(`${this.logPrefix} Starting Application Heartbeat Loop (60s)`);

        this.heartbeatTimer = setInterval(async () => {
            if (this.status !== 'connected' || !this.sock) {
                return;
            }

            // 1. WS Ping (Lower Level - Keep TCP Alive)
            // Baileys does this automatically via keepAliveIntervalMs, but we can double check
            // or rely on the App Level check below to catch "Zombie" sockets.

            // 2. App Level Pulse (Higher Level - Ensure Logic is Alive)
            try {
                this.lastHeartbeat = Date.now();

                // Dual Strategy for Notification Safety
                if (this.sessionId === 'user') {
                    // FORCE UNAVAILABLE: Serves as a ping AND prevents notification stealing
                    await this.sock.sendPresenceUpdate('unavailable');
                } else {
                    // Assistant: Just show available
                    await this.sock.sendPresenceUpdate('available');
                }

            } catch (e) {
                console.error(`${this.logPrefix} 💔 HEARTBEAT FAILED:`, e.message);

                // Force Recycle
                this.status = 'disconnected';
                console.log(`${this.logPrefix} 🚑 Initiating Emergency Restart...`);
                await this.disconnect(false); // Do not wipe session, just restart
                this.connect();
            }
        }, 60000); // 1 minute interval
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
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage, fetchLatestBaileysVersion } = await this._importBaileys();
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
            const { version, isLatest } = await fetchLatestBaileysVersion();
            console.log(`${this.logPrefix} using WA v${version.join('.')}, isLatest: ${isLatest}`);

            // Protocol Self-Healing (Issue #2135 Fix)
            // 1. Retry Cache: Tracks how many times a message ID has been requested for retry
            this.msgRetryCounterCache = this.msgRetryCounterCache || new Map();

            this.sock = makeWASocket({
                version,
                auth: state,
                defaultQueryTimeoutMs: undefined, // endless
                connectTimeoutMs: 180000, // 3 minutes
                retryRequestDelayMs: 2000,
                keepAliveIntervalMs: 30000,
                syncFullHistory: true, // Always sync logic
                markOnlineOnConnect: true, // REQUIRED true to trigger initial history sync from server
                browser: ['DeeDee', 'Chrome', '1.0.0'],

                // 2. Retry Capability: Allows Baileys to look up the original message to sign the retry receipt
                msgRetryCounterCache: this.msgRetryCounterCache,
                getMessage: async (key) => {
                    if (this.store) {
                        const msg = this.store.getMessageByKey(key.id, key.remoteJid);
                        return msg?.message || undefined;
                    }
                    // Fallback to proto if not found (or undefined to signal not found)
                    return undefined;
                }
            });

            // Bind Store - DISABLED causing sync blocking
            // this.store.bind(this.sock.ev);

            // History Sync - Critical for initial contacts
            this.sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
                // Ensure this is strictly async to not block the WebSocket Buffer
                setImmediate(() => {
                    console.log(`${this.logPrefix} History Sync Complete: ${contacts?.length || 0} contacts, ${messages?.length || 0} messages.`);

                    if (contacts && contacts.length > 0 && this.store) this.store.upsertContacts(contacts);
                    if (messages && messages.length > 0) {
                        if (this.store) this.store.upsertMessages(messages, 'append');
                        // We don't need to 'handleMessage' for history, usually.
                        // But if we do, it should also be async.
                        //  for (const msg of messages) this.handleMessage(msg, 'append');
                    }

                    // SMART SLEEP
                    if (this.sessionId === 'user') {
                        console.log(`${this.logPrefix} [Strategy] Sync finished. Triggering Early Sleep.`);
                        this._goToSleep();
                    }
                });
            });

            // --- EXTRA DEBUG LISTENERS ---
            // Forward presence to Agent for Autopilot Debounce
            this.sock.ev.on('presence.update', async (data) => {
                const jid = data.id;
                const presences = data.presences || {};

                // Extract relevant status
                const statuses = Object.values(presences);
                if (statuses.length > 0) {
                    const status = statuses[0].lastKnownPresence;

                    // Only forward 'composing' acts to save bandwidth
                    if (status === 'composing') {
                        const payload = {
                            type: 'presence',
                            content: '[Presence Update]', // Dummy content for server validation
                            source: `whatsapp:${this.sessionId}`,
                            metadata: {
                                chatId: jid,
                                status: status,
                                session: this.sessionId
                            }
                        };

                        try {
                            // Fire and forget
                            axios.post(`${this.agentUrl}/webhook`, payload).catch(() => { });
                        } catch (e) { }
                    }
                }
            });
            // this.sock.ev.on('contacts.update', (data) => console.log(`${this.logPrefix} [DEBUG] Contacts Update: ${data.length} items`));
            // this.sock.ev.on('message-receipt.update', (data) => console.log(`${this.logPrefix} [DEBUG] Receipt: ${data.key.id} Status: ${data.receipt.status}`));

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
                        const delayMs = this.calculateBackoff();
                        console.log(`${this.logPrefix} Connection Lost. Reconnecting in ${delayMs}ms (Attempt ${this.reconnectAttempts + 1})...`);

                        // Increment attempts
                        this.reconnectAttempts++;

                        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = setTimeout(() => this.connect(), delayMs);
                    } else {
                        console.log(`${this.logPrefix} Logged out by Server. Clearing session.`);
                        await this.disconnect(true); // Wipe if server says logged out
                    }

                } else if (connection === 'open') {
                    console.log(`${this.logPrefix} Connection OPEN! 🟢`);
                    this.status = 'connected';
                    this.qr = null;
                    this.reconnectAttempts = 0; // Reset counter on success

                    // Start Heartbeat
                    this.startHeartbeatLoop();

                    // WAKE & SLEEP STRATEGY
                    // 1. We started "Online" (markOnlineOnConnect: true) to trigger data push.
                    // 2. Wait 5s for buffers to assume we are active.
                    // 3. Switch to "Unavailable" to restore phone notifications.

                    if (this.sessionId === 'user') {
                        // FORCE UNAVAILABLE IMMEDIATELY to prevent notification stealing
                        // We add a SIGNIPICANT delay (60s) to ensure the connection "Online" state is established 
                        // and the initial sync (decryption of pending messages) completes before we switch it off.

                        // The heartbeat will now handle this periodically, but we do an initial one.
                        setTimeout(async () => {
                            if (this.sock) {
                                console.log(`${this.logPrefix} [Strategy] Connection Open (+180s). Forcing 'unavailable' now.`);
                                await this.sock.sendPresenceUpdate('unavailable');
                            }
                        }, 180000);

                        // Fallback Timeout: If sync doesn't finish in 180s, sleep anyway
                        if (this.sleepTimeout) clearTimeout(this.sleepTimeout);
                        this.sleepTimeout = setTimeout(() => {
                            console.log(`${this.logPrefix} [Strategy] Sync timed out (or empty). Forcing Sleep.`);
                            this._goToSleep();
                        }, 180000);
                    } else {
                        // Assistant stays online
                        // Heartbeat handles this too, but good to set initially
                        await this.sock.sendPresenceUpdate('available');
                    }

                    // Log contacts count
                    const contactCount = this.store.getContacts().length;
                    console.log(`${this.logPrefix} Store has ${contactCount} contacts.`);
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                // console.log(`${this.logPrefix} [DEBUG] Upsert: ${messages.length} messages. Type: ${type}`); // Verbose

                // MANUAL STORE UPDATE (Since bind is disabled)
                if (this.store) {
                    this.store.upsertMessages(messages, type);
                }

                for (const msg of messages) {
                    // Check if it's potentially interesting
                    const isProtocol = !!msg.message?.protocolMessage;
                    const msgKeys = Object.keys(msg.message || {}).join(',');

                    // Debug Log
                    // let ts = msg.messageTimestamp;
                    // if (ts && typeof ts !== 'number') ts = ts.low || ts;
                    // const nowSeconds = Math.floor(Date.now() / 1000);
                    // const age = ts ? (nowSeconds - ts) : 0;

                    // console.log(`${this.logPrefix} [DEBUG] Msg: ID=${msg.key.id} Protocol=${isProtocol} Type=${type} Age=${age}s Keys=${msgKeys}`);

                    if (!msg.message) {
                        // console.log(`${this.logPrefix} [DEBUG] SKIPPING: No 'message' content.`); // Verbose
                        continue;
                    }

                    if (msg.message.protocolMessage) {
                        // console.log(`${this.logPrefix} [DEBUG] SKIPPING: Protocol Message (History/Sync Notification).`); // Verbose
                        continue;
                    }

                    // Pass to handler (Decides whether to process based on age/type)
                    await this.handleMessage(msg, type);
                }
            });

        } catch (err) {
            console.error(`${this.logPrefix} Connect Error:`, err);
            this.status = 'disconnected';
        }
    }

    async handleMessage(msg, upsertType = 'notify') {
        try {
            // 0. Age Check (Prevent History Flood)
            let ts = msg.messageTimestamp;
            if (ts && typeof ts !== 'number') ts = ts.low || ts;
            const age = ts ? (Math.floor(Date.now() / 1000) - ts) : 0;

            if (upsertType === 'append' && age > 300) {
                // Silently ignore old history messages (older than 5 minutes ago)
                // console.log(`${this.logPrefix} [history-drain] FORCE PROCESSING old message (Age: ${age}s)`);
                return;
            }

            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast') return;

            // Allow fromMe MEDIA (audio/image) through for semantic extraction
            // but ONLY for the user session (passive monitoring of user's outgoing media).
            // For the assistant session, skip ALL fromMe messages to prevent feedback loops
            // where the bot's own TTS audio echoes back and gets re-processed as a new message.
            let messageContent_peek = msg.message;
            if (messageContent_peek?.ephemeralMessage) messageContent_peek = messageContent_peek.ephemeralMessage.message;
            else if (messageContent_peek?.viewOnceMessage) messageContent_peek = messageContent_peek.viewOnceMessage.message;
            else if (messageContent_peek?.viewOnceMessageV2) messageContent_peek = messageContent_peek.viewOnceMessageV2.message;

            const isFromMeMedia = msg.key.fromMe && this.sessionId === 'user' && (!!messageContent_peek?.audioMessage || !!messageContent_peek?.imageMessage);
            if (msg.key.fromMe && !isFromMeMedia) return;

            let phoneNumber = remoteJid.split('@')[0];

            // Handle LID: If remoteJid is an LID, check if we have a participant (likely the real phone JID)
            if (remoteJid.includes('@lid')) {
                // console.log(`${this.logPrefix} [LID Debug] Handling LID ${remoteJid}. Participant: ${msg.key.participant}`);
                if (msg.key.participant) {
                    const participantNumber = msg.key.participant.split('@')[0];
                    if (participantNumber) {
                        console.log(`${this.logPrefix} Resolving LID (via participant) ${phoneNumber} to ${participantNumber}`);
                        phoneNumber = participantNumber;
                    }
                } else if (this.store) {
                    const resolvedData = this.store.getContactByLid(remoteJid);
                    if (resolvedData) {
                        const resolvedId = resolvedData.id || '';
                        const resolvedPhone = resolvedId.split('@')[0];
                        console.log(`${this.logPrefix} Resolving LID (via DB) ${phoneNumber} to ${resolvedPhone}`);
                        phoneNumber = resolvedPhone;
                    } else {
                        console.log(`${this.logPrefix} [LID Warning] Could not resolve LID ${remoteJid} from DB.`);
                    }
                }
            } else {
                // Fallback: If phoneNumber is very long (>14 digits), it might be a raw LID without suffix
                // or Baileys normalized it. Try to resolve it.
                if (phoneNumber.length > 14 && this.store) {
                    // Try appending @lid
                    const potentialLid = phoneNumber + '@lid';
                    const resolvedData = this.store.getContactByLid(potentialLid);
                    if (resolvedData) {
                        const resolvedId = resolvedData.id || '';
                        const resolvedPhone = resolvedId.split('@')[0];
                        console.log(`${this.logPrefix} Resolving Ambiguous ID ${phoneNumber} to ${resolvedPhone} (via Fallback LID Match)`);
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

            // Verify processing for ALL sessions (User + Assistant)
            console.log(`${this.logPrefix} Received from ${phoneNumber} [Type: ${upsertType}]`);

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
                fromMe: !!msg.key.fromMe,
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
            // Ensure target JID exists and has a domain
            const targetJid = toJid.includes('@') ? toJid : `${toJid}@s.whatsapp.net`;

            const type = options.type || 'text';
            console.log(`${this.logPrefix} Sending ${type} to ${targetJid}`);

            if (type === 'text') {
                await this.sock.sendMessage(targetJid, { text: content });
            } else if (type === 'audio') {
                const rawBuffer = Buffer.from(content, 'base64');
                const opusBuffer = await convertToOpus(rawBuffer);
                await this.sock.sendMessage(targetJid, { audio: opusBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
            } else if (type === 'image') {
                const buffer = Buffer.from(content, 'base64');
                await this.sock.sendMessage(targetJid, { image: buffer });
            }

        } catch (e) {
            console.error(`${this.logPrefix} Send Failed:`, e.message);
            throw e;
        }
    }

    async runDiagnostics() {
        const report = {
            session: this.sessionId,
            status: this.status,
            timestamp: new Date().toISOString(),
            probes: {},
            store: this.store ? this.store.getStats() : { error: 'No Store' }
        };

        if (this.status !== 'connected' || !this.sock) {
            report.error = 'Socket not connected';
            return report;
        }

        console.log(`${this.logPrefix} Running Diagnostics...`);

        // Probe 1: Presence
        try {
            const start = Date.now();
            await this.sock.sendPresenceUpdate('available');
            report.probes.presence = { success: true, latency: Date.now() - start };
        } catch (e) {
            report.probes.presence = { success: false, error: e.message };
        }

        // Probe 2: Blocklist (IQ)
        try {
            const start = Date.now();
            const list = await this.sock.fetchBlocklist();
            report.probes.blocklist = { success: true, count: list.length, latency: Date.now() - start };
        } catch (e) {
            report.probes.blocklist = { success: false, error: e.message };
        }

        return report;
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

        // 1. Seed with the input (Normalized)
        const norm = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
        candidateJids.add(norm);

        // 2. Identify Primary Candidates (Phone JIDs)
        if (isLid) {
            candidateJids.add(jid);
            // Try to find the Phone JID for this LID
            const row = this.store.db.prepare('SELECT id FROM contacts WHERE lid = ?').get(jid);
            if (row && row.id) candidateJids.add(row.id);
        } else {
            // It is a phone number (or partial)
            if (inputDigits.length >= 7) {
                // Fuzzy Search: Look in CONTACTS first (Reliable mapping source)
                const suffix = inputDigits.slice(-7);

                // Find matching Phone JIDs in Contacts
                const contactRows = this.store.db.prepare("SELECT id FROM contacts WHERE id LIKE ?").all(`%${suffix}%`);
                contactRows.forEach(r => candidateJids.add(r.id));

                // Find matching Phone JIDs in Messages (Legacy/Direct)
                const msgRows = this.store.db.prepare("SELECT DISTINCT remote_jid FROM messages WHERE remote_jid LIKE ? AND remote_jid NOT LIKE '%@lid'").all(`%${suffix}%`);
                msgRows.forEach(r => candidateJids.add(r.remote_jid));
            }

            // [FIX] Check for Malformed LID (Wrong domain but long number)
            // LIDs are usually 15 digits, phone numbers are usually <14 (even with country code)
            if (inputDigits.length > 14) {
                const potentialLid = `${inputDigits}@lid`;
                candidateJids.add(potentialLid);
                // Resolve to phone via DB
                const row = this.store.db.prepare('SELECT id FROM contacts WHERE lid = ?').get(potentialLid);
                if (row && row.id) candidateJids.add(row.id);
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
        // Query IN (...)
        const queryPlaceholders = targetJids.map(() => '?').join(',');
        const rows = this.store.db.prepare(`
            SELECT data, timestamp FROM messages 
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
                timestamp: r.timestamp * 1000 // Use DB timestamp
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

    // Helper for Wake & Sleep
    async _goToSleep() {
        // Clear safety timeout since we are running now
        if (this.sleepTimeout) {
            clearTimeout(this.sleepTimeout);
            this.sleepTimeout = null;
        }

        if (!this.sock) return;

        try {
            console.log(`${this.logPrefix} [Strategy] Switching to 'unavailable' (Passive Mode).`);
            await this.sock.sendPresenceUpdate('unavailable');

            // Start Heartbeat (Keep asserting unavailable)
            if (this.presenceInterval) clearInterval(this.presenceInterval);
            this.presenceInterval = setInterval(() => {
                if (this.sock) this.sock.sendPresenceUpdate('unavailable');
            }, 10 * 60 * 1000); // 10 min heartbeat

        } catch (e) {
            console.error(`${this.logPrefix} Failed to set passive mode:`, e);
        }
    }
    async repairSession() {
        console.log(`${this.logPrefix} 🛠️ REPAIRING SESSION (Level 2: Surgical Strike)...`);

        // 1. Force Disconnect (Keep Session)
        await this.disconnect(false);

        // 2. Surgical Deletion (Level 2.5: Scorched Earth - Keep only identity)
        if (fs.existsSync(this.authFolder)) {
            const files = fs.readdirSync(this.authFolder);
            let deletedCount = 0;

            for (const file of files) {
                // DELETE EVERYTHING except creds.json
                if (file !== 'creds.json') {
                    try {
                        fs.unlinkSync(path.join(this.authFolder, file));
                        deletedCount++;
                    } catch (e) {
                        console.error(`${this.logPrefix} Failed to delete ${file}:`, e.message);
                    }
                }
            }
            console.log(`${this.logPrefix} Deleted ${deletedCount} session files (All except creds.json).`);
        }

        // 3. Restart (Triggers Re-Sync)
        console.log(`${this.logPrefix} Restarting to trigger full re-sync...`);
        // Small delay to ensure file system release
        await new Promise(r => setTimeout(r, 1000));
        await this.start();

        return { success: true, message: 'Session repair triggered. Watch logs for re-sync.' };
    }
}

module.exports = { WhatsAppService, SQLiteStore };
