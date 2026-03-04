/**
 * SlackService - Slack Channel Integration (Cookie-Based Auth)
 * 
 * Uses xoxc-/xoxd- tokens (browser cookie auth) to connect as the user.
 * No Slack App needed, works with company workspaces.
 * 
 * All incoming messages are forwarded to the Agent as source: 'slack' (passive).
 * The agent's watcher system decides whether to act on them.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const { createUserMessage } = require('@deedee/shared/src/types');

const CREDENTIALS_FILE = path.join(process.env.DATA_DIR || '/data', 'slack-credentials.json');
const SLACK_API_BASE = 'https://slack.com/api';

// Derive encryption key from DEEDEE_API_TOKEN
const ENCRYPTION_SALT = 'deedee-slack-v1';

class SlackService {
    constructor(agentUrl) {
        this.agentUrl = agentUrl;
        this.xoxc = null;    // API token
        this.xoxd = null;    // Cookie token
        this.ws = null;       // RTM WebSocket
        this.pollInterval = null;
        this.connected = false;
        this.workspace = null; // { team, user, userId }
        this.credentialsSavedAt = null;

        // Caches
        this.userCache = new Map();     // userId → { name, realName }
        this.channelCache = new Map();  // channelId → { name, type }
        this.channelNameToId = new Map(); // #name → channelId

        // Track last message timestamps for polling
        this.lastReadTs = new Map(); // channelId → timestamp
    }

    // --- Lifecycle ---

    async start() {
        try {
            const creds = this._loadCredentials();
            if (!creds) {
                console.log('[Slack] No credentials found. Slack disabled until configured via UI.');
                return;
            }
            this.xoxc = creds.xoxc;
            this.xoxd = creds.xoxd;
            this.credentialsSavedAt = creds.savedAt;
            await this._connect();
        } catch (err) {
            console.error('[Slack] Failed to start:', err.message);
        }
    }

    async stop() {
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        console.log('[Slack] Stopped.');
    }

    async _connect() {
        // Validate tokens
        const auth = await this._api('auth.test');
        this.workspace = {
            team: auth.team,
            teamId: auth.team_id,
            user: auth.user,
            userId: auth.user_id,
        };
        console.log(`[Slack] Authenticated as ${auth.user} in ${auth.team}`);

        // Try RTM first, fall back to polling
        try {
            await this._connectRTM();
        } catch (err) {
            console.warn(`[Slack] RTM failed (${err.message}), falling back to polling.`);
            this._startPolling();
        }
    }

    // --- RTM WebSocket ---

    async _connectRTM() {
        const res = await this._api('rtm.connect');
        if (!res.url) throw new Error('RTM did not return a WebSocket URL');

        return new Promise((resolve, reject) => {
            const wsOptions = {
                headers: {
                    'Cookie': `d=${this.xoxd}`,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                }
            };
            this.ws = new WebSocket(res.url, wsOptions);

            this.ws.on('open', () => {
                console.log('[Slack] RTM WebSocket connected.');
                this.connected = true;

                // Keep-alive ping every 10 seconds for RTM stability
                this.pingInterval = setInterval(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
                    }
                }, 10000);

                resolve();
            });

            this.ws.on('message', (rawData) => {
                try {
                    const event = JSON.parse(rawData.toString());
                    // Respond to server requested pings just in case
                    if (event.type === 'ping') {
                        this.ws.send(JSON.stringify({ type: 'pong', reply_to: event.id }));
                        return;
                    }
                    if (event.type === 'message' && !event.subtype && event.user !== this.workspace?.userId) {
                        this._handleMessage(event);
                    }
                } catch (err) {
                    console.error('[Slack] RTM parse error:', err.message);
                }
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : 'No reason provided';
                console.warn(`[Slack] RTM closed (code: ${code}, reason: ${reasonStr}). Reconnecting in 5s...`);
                this.connected = false;
                if (this.pingInterval) {
                    clearInterval(this.pingInterval);
                    this.pingInterval = null;
                }
                setTimeout(() => {
                    if (this.xoxc) this._connectRTM().catch(() => this._startPolling());
                }, 5000);
            });

            this.ws.on('error', (err) => {
                console.error('[Slack] RTM error:', err.message);
                reject(err);
            });

            // Timeout for initial connection
            setTimeout(() => {
                if (!this.connected) reject(new Error('RTM connection timeout'));
            }, 10000);
        });
    }

    // --- Polling Fallback ---

    _startPolling() {
        if (this.pollInterval) return;
        console.log('[Slack] Starting polling mode (every 5s).');
        this.connected = true;

        this.pollInterval = setInterval(async () => {
            try {
                await this._pollConversations();
            } catch (err) {
                if (err.message?.includes('token_revoked') || err.message?.includes('invalid_auth')) {
                    console.error('[Slack] Token expired during polling. Stopping.');
                    this.stop();
                    this._notifyTokenExpired();
                }
            }
        }, 5000);
    }

    async _pollConversations() {
        // Get DMs and subscribed channels
        const convos = await this._api('conversations.list', {
            types: 'im,mpim',
            limit: 20,
            exclude_archived: true,
        });

        if (!convos.channels) return;

        for (const channel of convos.channels) {
            const lastRead = this.lastReadTs.get(channel.id);
            const params = { channel: channel.id, limit: 5 };
            if (lastRead) params.oldest = lastRead;

            try {
                const history = await this._api('conversations.history', params);
                if (!history.messages?.length) continue;

                for (const msg of history.messages) {
                    // Skip own messages, subtypes (joins, topic changes, etc.)
                    if (msg.user === this.workspace?.userId || msg.subtype) continue;

                    // Skip already-seen messages
                    if (lastRead && parseFloat(msg.ts) <= parseFloat(lastRead)) continue;

                    this._handleMessage({ ...msg, channel: channel.id });
                }

                // Update cursor
                const newestTs = history.messages[0]?.ts;
                if (newestTs) this.lastReadTs.set(channel.id, newestTs);
            } catch (err) {
                // Rate limit or channel permission error — skip silently
                if (!err.message?.includes('channel_not_found')) {
                    console.warn(`[Slack] Poll error for ${channel.id}:`, err.message);
                }
            }
        }
    }

    // --- Message Handling ---

    async _handleMessage(event) {
        try {
            const userName = await this._resolveUser(event.user);
            const channelInfo = await this._resolveChannel(event.channel);
            const channelName = channelInfo?.name || event.channel;

            const contactString = channelInfo?.type === 'im'
                ? userName
                : `#${channelName}/${userName}`;

            console.log(`[Slack] Message from ${contactString}: ${event.text?.substring(0, 80)}`);

            const message = createUserMessage(event.text || '', 'slack', event.user);
            message.metadata = {
                chatId: event.channel,
                thread_ts: event.thread_ts || event.ts,
                slackUserId: event.user,
                slackUserName: userName,
                channelName: channelName,
                channelType: channelInfo?.type || 'unknown',
                phoneNumber: contactString, // Used by watcher matching (contact_string)
            };

            await axios.post(`${this.agentUrl}/webhook`, message);
        } catch (err) {
            console.error('[Slack] Error handling message:', err.message);
        }
    }

    // --- Outbound ---

    async sendMessage(channelId, text, opts = {}) {
        const params = {
            channel: channelId,
            text,
            as_user: true,
        };
        if (opts.thread_ts) params.thread_ts = opts.thread_ts;

        const result = await this._api('chat.postMessage', params);
        return result;
    }

    // --- Search & History (Agent Tool Support) ---

    async search(query, limit = 10) {
        const result = await this._api('search.messages', {
            query,
            count: Math.min(limit, 50),
            sort: 'timestamp',
            sort_dir: 'desc',
        });

        if (!result.messages?.matches) return [];

        return result.messages.matches.map(m => ({
            text: m.text,
            user: m.username || m.user,
            channel: m.channel?.name || m.channel?.id,
            timestamp: m.ts,
            permalink: m.permalink,
        }));
    }

    async getHistory(channelNameOrId, limit = 20) {
        let channelId = channelNameOrId;

        // Resolve channel name or username to ID
        if (channelNameOrId.startsWith('#')) {
            // #channel-name → channel ID
            channelId = await this._resolveChannelName(channelNameOrId.replace(/^#/, ''));
            if (!channelId) return { error: `Channel "${channelNameOrId}" not found` };
        } else if (!channelNameOrId.startsWith('C') && !channelNameOrId.startsWith('D')) {
            // Try as username → DM channel ID
            const cleanName = channelNameOrId.replace(/^@/, '');
            channelId = await this._resolveUserToDM(cleanName);
            if (!channelId) {
                // Fallback: try as channel name
                channelId = await this._resolveChannelName(cleanName);
            }
            if (!channelId) return { error: `User or channel "${channelNameOrId}" not found` };
        }

        const result = await this._api('conversations.history', {
            channel: channelId,
            limit: Math.min(limit, 100),
        });

        if (!result.messages) return [];

        // Resolve user names and return clean format
        const messages = [];
        for (const msg of result.messages) {
            const userName = msg.user ? await this._resolveUser(msg.user) : 'system';
            messages.push({
                text: msg.text,
                user: userName,
                timestamp: msg.ts,
                thread_ts: msg.thread_ts,
                type: msg.subtype || 'message',
            });
        }

        return messages.reverse(); // Chronological order
    }

    // --- Credentials ---

    async setCredentials(xoxc, xoxd) {
        // Validate first
        this.xoxc = xoxc;
        this.xoxd = xoxd;

        const auth = await this._api('auth.test');

        // Save encrypted
        this._saveCredentials(xoxc, xoxd);

        // Reconnect
        await this.stop();
        this.workspace = {
            team: auth.team,
            teamId: auth.team_id,
            user: auth.user,
            userId: auth.user_id,
        };

        try {
            await this._connectRTM();
        } catch {
            this._startPolling();
        }

        return { team: auth.team, user: auth.user };
    }

    clearCredentials() {
        this.stop();
        this.xoxc = null;
        this.xoxd = null;
        this.workspace = null;
        this.credentialsSavedAt = null;
        try {
            fs.unlinkSync(CREDENTIALS_FILE);
            console.log('[Slack] Credentials cleared.');
        } catch { /* file may not exist */ }
    }

    getStatus() {
        return {
            connected: this.connected,
            workspace: this.workspace?.team || null,
            user: this.workspace?.user || null,
            mode: this.ws ? 'rtm' : (this.pollInterval ? 'polling' : 'disconnected'),
            tokenAge: this.credentialsSavedAt
                ? Math.floor((Date.now() - new Date(this.credentialsSavedAt).getTime()) / 86400000) + ' days'
                : null,
        };
    }

    // --- Slack Web API Client ---

    async _api(method, body = {}) {
        if (!this.xoxc || !this.xoxd) {
            throw new Error('Slack not configured (missing tokens)');
        }

        const headers = {
            'Authorization': `Bearer ${this.xoxc}`,
            'Cookie': `d=${this.xoxd}`,
        };

        let fetchBody;
        // search.* methods require form-urlencoded (they reject JSON)
        if (method.startsWith('search.')) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
            fetchBody = new URLSearchParams(body).toString();
        } else {
            headers['Content-Type'] = 'application/json; charset=utf-8';
            fetchBody = JSON.stringify(body);
        }

        const res = await fetch(`${SLACK_API_BASE}/${method}`, {
            method: 'POST',
            headers,
            body: fetchBody,
        });

        const data = await res.json();

        if (!data.ok) {
            if (data.error === 'token_revoked' || data.error === 'invalid_auth') {
                this._notifyTokenExpired();
            }
            throw new Error(`Slack API ${method}: ${data.error}`);
        }

        return data;
    }

    // --- Resolution Caches ---

    async _resolveUser(userId) {
        if (this.userCache.has(userId)) return this.userCache.get(userId);

        try {
            const res = await this._api('users.info', { user: userId });
            const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
            this.userCache.set(userId, name);
            return name;
        } catch {
            return userId;
        }
    }

    async _resolveChannel(channelId) {
        if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);

        try {
            const res = await this._api('conversations.info', { channel: channelId });
            const info = {
                name: res.channel?.name || channelId,
                type: res.channel?.is_im ? 'im' : (res.channel?.is_mpim ? 'mpim' : 'channel'),
            };
            this.channelCache.set(channelId, info);
            return info;
        } catch {
            return { name: channelId, type: 'unknown' };
        }
    }

    async _resolveChannelName(name) {
        if (this.channelNameToId.has(name)) return this.channelNameToId.get(name);

        try {
            // Fetch conversations list and find by name
            let cursor;
            do {
                const res = await this._api('conversations.list', {
                    types: 'public_channel,private_channel,im,mpim',
                    limit: 200,
                    cursor,
                });

                for (const ch of res.channels || []) {
                    this.channelNameToId.set(ch.name, ch.id);
                    if (ch.name === name) return ch.id;
                }

                cursor = res.response_metadata?.next_cursor;
            } while (cursor);

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Resolve a username (display name or real name) to a DM channel ID.
     * Searches users.list, then opens a conversation with the matched user.
     */
    async _resolveUserToDM(name) {
        const nameLower = name.toLowerCase();

        // Check cache first (userName → userId stored during message handling)
        for (const [userId, cachedName] of this.userCache.entries()) {
            if (cachedName.toLowerCase() === nameLower) {
                try {
                    const dm = await this._api('conversations.open', { users: userId });
                    return dm.channel?.id || null;
                } catch {
                    return null;
                }
            }
        }

        // Search users.list for matching name
        try {
            let cursor;
            do {
                const res = await this._api('users.list', { limit: 200, cursor });
                for (const user of res.members || []) {
                    if (user.deleted || user.is_bot) continue;
                    const displayName = (user.profile?.display_name || '').toLowerCase();
                    const realName = (user.real_name || '').toLowerCase();
                    const userName = (user.name || '').toLowerCase();

                    if (displayName === nameLower || realName === nameLower || userName === nameLower ||
                        realName.includes(nameLower) || displayName.includes(nameLower)) {
                        // Cache for future lookups
                        this.userCache.set(user.id, user.profile?.display_name || user.real_name || user.name);
                        // Open DM
                        const dm = await this._api('conversations.open', { users: user.id });
                        return dm.channel?.id || null;
                    }
                }
                cursor = res.response_metadata?.next_cursor;
            } while (cursor);
        } catch (err) {
            console.warn(`[Slack] Failed to resolve user '${name}':`, err.message);
        }

        return null;
    }

    // --- Credential Encryption ---

    _getEncryptionKey() {
        const secret = process.env.DEEDEE_API_TOKEN;
        if (!secret) throw new Error('DEEDEE_API_TOKEN required for Slack credential encryption');
        return crypto.scryptSync(secret, ENCRYPTION_SALT, 32);
    }

    _encrypt(text) {
        const key = this._getEncryptionKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return {
            iv: iv.toString('hex'),
            data: encrypted,
            tag: cipher.getAuthTag().toString('hex'),
        };
    }

    _decrypt(encrypted) {
        const key = this._getEncryptionKey();
        const iv = Buffer.from(encrypted.iv, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
        let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    _saveCredentials(xoxc, xoxd) {
        const dir = path.dirname(CREDENTIALS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const payload = {
            xoxc: this._encrypt(xoxc),
            xoxd: this._encrypt(xoxd),
            savedAt: new Date().toISOString(),
        };

        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(payload, null, 2));
        this.credentialsSavedAt = payload.savedAt;
        console.log('[Slack] Credentials saved (encrypted).');
    }

    _loadCredentials() {
        try {
            if (!fs.existsSync(CREDENTIALS_FILE)) return null;
            const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
            return {
                xoxc: this._decrypt(raw.xoxc),
                xoxd: this._decrypt(raw.xoxd),
                savedAt: raw.savedAt,
            };
        } catch (err) {
            console.error('[Slack] Failed to load credentials:', err.message);
            return null;
        }
    }

    // --- Token Expiry Notification ---

    async _notifyTokenExpired() {
        console.error('[Slack] ⚠️ Token expired or revoked. Notifying user...');
        try {
            // Notify via Agent (which will route to Telegram/WhatsApp)
            await axios.post(`${this.agentUrl}/webhook`, {
                content: 'SYSTEM: Your Slack token has expired. Please re-login via Settings → Interfaces → Slack.',
                source: 'system',
                role: 'user',
                metadata: { internal_system_alert: true },
            });
        } catch (err) {
            console.error('[Slack] Failed to send expiry notification:', err.message);
        }
    }
}

module.exports = { SlackService };
