/**
 * SlackManager & SlackConnection - Multi-Workspace Slack Integration
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const { createUserMessage } = require('@deedee/shared/src/types');

const CREDENTIALS_FILE = path.join(process.env.DATA_DIR || '/data', 'slack-credentials.json');
const SLACK_API_BASE = 'https://slack.com/api';
const ENCRYPTION_SALT = 'deedee-slack-v1';

class SlackConnection {
    constructor(agentUrl, config, onTokenExpired) {
        this.agentUrl = agentUrl;
        this.xoxc = config.xoxc;
        this.xoxd = config.xoxd;
        this.listening = config.listening !== false;
        this.monitoredChannels = config.monitoredChannels || [];
        this.onTokenExpired = onTokenExpired;

        this.ws = null;
        this.pollInterval = null;
        this.connected = false;
        this.workspace = config.workspace || null;

        this.userCache = new Map();     // userId -> {name, realName}
        this.channelCache = new Map();  // channelId -> {name, type}
        this.channelNameToId = new Map(); // #name -> channelId
        this.lastReadTs = new Map();
    }

    async start() {
        this.intentionallyStopped = false;
        try {
            await this._connect();
        } catch (err) {
            console.error(`[Slack:${this.workspace?.team || 'Unknown'}] Failed to start:`, err.message);
        }
    }

    async stop() {
        this.intentionallyStopped = true;
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        console.log(`[Slack:${this.workspace?.team || 'Unknown'}] Stopped.`);
    }

    async _connect() {
        const auth = await this._api('auth.test');
        this.workspace = {
            team: auth.team,
            teamId: auth.team_id,
            user: auth.user,
            userId: auth.user_id,
        };
        console.log(`[Slack] Authenticated as ${auth.user} in ${auth.team}`);

        try {
            await this._connectRTM();
        } catch (err) {
            console.warn(`[Slack:${auth.team}] RTM failed (${err.message}), falling back to polling.`);
            this._startPolling();
        }
    }

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
                console.log(`[Slack:${this.workspace?.team}] RTM WebSocket connected.`);
                this.connected = true;

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
                    if (event.type === 'ping') {
                        this.ws.send(JSON.stringify({ type: 'pong', reply_to: event.id }));
                        return;
                    }
                    if (event.type === 'message' && !event.subtype && event.user !== this.workspace?.userId) {
                        this._handleMessage(event);
                    }
                } catch (err) {
                    console.error(`[Slack:${this.workspace?.team}] RTM parse error:`, err.message);
                }
            });

            this.ws.on('close', (code, reason) => {
                if (this.intentionallyStopped) return;
                const reasonStr = reason ? reason.toString() : 'No reason provided';
                console.warn(`[Slack:${this.workspace?.team}] RTM closed (code: ${code}, reason: ${reasonStr}). Reconnecting in 5s...`);
                this.connected = false;
                if (this.pingInterval) clearInterval(this.pingInterval);
                setTimeout(() => {
                    if (this.xoxc) this._connectRTM().catch(() => this._startPolling());
                }, 5000);
            });

            this.ws.on('error', (err) => {
                console.error(`[Slack:${this.workspace?.team}] RTM error:`, err.message);
                reject(err);
            });

            setTimeout(() => {
                if (!this.connected) reject(new Error('RTM connection timeout'));
            }, 10000);
        });
    }

    _startPolling() {
        if (this.pollInterval) return;
        console.log(`[Slack:${this.workspace?.team}] Starting polling mode (every 5s).`);
        this.connected = true;

        this.pollInterval = setInterval(async () => {
            try {
                await this._pollConversations();
            } catch (err) {
                if (err.message?.includes('token_revoked') || err.message?.includes('invalid_auth')) {
                    console.error(`[Slack:${this.workspace?.team}] Token expired during polling.`);
                    this.stop();
                    if (this.onTokenExpired) this.onTokenExpired(this.workspace.teamId);
                }
            }
        }, 5000);
    }

    async _pollConversations() {
        const convos = await this._api('conversations.list', { types: 'im,mpim', limit: 20, exclude_archived: true });
        if (!convos.channels) return;

        for (const channel of convos.channels) {
            const lastRead = this.lastReadTs.get(channel.id);
            const params = { channel: channel.id, limit: 5 };
            if (lastRead) params.oldest = lastRead;

            try {
                const history = await this._api('conversations.history', params);
                if (!history.messages?.length) continue;

                for (const msg of history.messages) {
                    if (msg.user === this.workspace?.userId || msg.subtype) continue;
                    if (lastRead && parseFloat(msg.ts) <= parseFloat(lastRead)) continue;
                    this._handleMessage({ ...msg, channel: channel.id });
                }

                const newestTs = history.messages[0]?.ts;
                if (newestTs) this.lastReadTs.set(channel.id, newestTs);
            } catch (err) {
                if (!err.message?.includes('channel_not_found')) {
                    console.warn(`[Slack:${this.workspace?.team}] Poll error for ${channel.id}:`, err.message);
                }
            }
        }
    }

    async _handleMessage(event) {
        if (!this.listening) return;

        try {
            const userName = await this._resolveUser(event.user);
            const channelInfo = await this._resolveChannel(event.channel);
            const channelName = channelInfo?.name || event.channel;

            const contactString = channelInfo?.type === 'im' ? userName : `#${channelName}/${userName}`;

            console.log(`[Slack:${this.workspace?.team}] Message from ${contactString}: ${event.text?.substring(0, 80)}`);

            const message = createUserMessage(event.text || '', 'slack', event.user);
            message.metadata = {
                teamId: this.workspace?.teamId,
                teamName: this.workspace?.team,
                chatId: event.channel,
                thread_ts: event.thread_ts || event.ts,
                slackUserId: event.user,
                slackUserName: userName,
                channelName: channelName,
                channelType: channelInfo?.type || 'unknown',
                phoneNumber: contactString,
            };

            await axios.post(`${this.agentUrl}/webhook`, message);
        } catch (err) {
            console.error(`[Slack:${this.workspace?.team}] Error handling message:`, err.message);
        }
    }

    async sendMessage(channelId, text, opts = {}) {
        const params = { channel: channelId, text, as_user: true };
        if (opts.thread_ts) params.thread_ts = opts.thread_ts;
        return await this._api('chat.postMessage', params);
    }

    async getWorkspaceUsers() {
        const users = [];
        let cursor;
        do {
            const params = { limit: 200, cursor };
            if (this.workspace && this.workspace.teamId) {
                params.team_id = this.workspace.teamId;
            }
            const res = await this._api('users.list', params);
            for (const user of res.members || []) {
                if (user.deleted || user.is_bot || user.id === 'USLACKBOT') continue;
                users.push({
                    id: user.id,
                    name: user.real_name || user.name,
                    displayName: user.profile?.display_name || '',
                    email: user.profile?.email || '',
                    title: user.profile?.title || '',
                    avatar: user.profile?.image_72 || '',
                });
            }
            cursor = res.response_metadata?.next_cursor;
        } while (cursor);
        return users;
    }

    async getChannels() {
        // Pre-warm user cache to avoid rate limits and speed up resolution
        const activeUsers = new Set();
        try {
            let userCursor;
            do {
                const params = { limit: 200, cursor: userCursor };
                if (this.workspace && this.workspace.teamId) {
                    params.team_id = this.workspace.teamId;
                }
                const res = await this._api('users.list', params);
                for (const user of res.members || []) {
                    if (user.deleted) continue;
                    const name = user.profile?.display_name || user.real_name || user.name || user.id;
                    this.userCache.set(user.id, name);
                    activeUsers.add(user.id);
                    if (user.name) {
                        this.userCache.set(`username:${user.name.toLowerCase()}`, name);
                        activeUsers.add(`username:${user.name.toLowerCase()}`);
                    }
                }
                userCursor = res.response_metadata?.next_cursor;
            } while (userCursor);
        } catch (e) {
            console.warn(`[Slack:${this.workspace?.team}] Failed to pre-warm user cache:`, e.message);
        }

        const channels = [];
        let cursor;
        do {
            const params = new URLSearchParams({
                types: 'public_channel,private_channel,mpim,im',
                exclude_archived: 'true',
                limit: '200',
            });
            if (this.workspace && this.workspace.teamId) {
                params.set('team_id', this.workspace.teamId);
            }
            if (cursor) params.set('cursor', cursor);

            const res = await fetch(`${SLACK_API_BASE}/conversations.list`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.xoxc}`,
                    'Cookie': `d=${this.xoxd}`,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                },
                body: params.toString(),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(`Slack API conversations.list: ${data.error}`);

            for (const ch of data.channels || []) {
                let name = ch.name;
                let isActive = true;

                if (ch.is_im && ch.user) {
                    if (!activeUsers.has(ch.user)) {
                        isActive = false;
                    }
                    name = this.userCache.get(ch.user) || ch.user;
                } else if (ch.is_mpim && name && name.startsWith('mpdm-')) {
                    const parts = name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--');

                    // Check if *any* user in the MPIM is inactive
                    const hasActiveUsers = parts.some(p => activeUsers.has(`username:${p.toLowerCase()}`));
                    if (!hasActiveUsers && parts.length > 0) {
                        isActive = false;
                    }

                    const resolvedNames = parts.map(p => this.userCache.get(`username:${p.toLowerCase()}`) || p);
                    name = resolvedNames.join(', ');
                }

                if (!isActive) continue;
                channels.push({
                    id: ch.id,
                    name: name || ch.id,
                    topic: ch.topic?.value || '',
                    purpose: ch.purpose?.value || '',
                    isMember: ch.is_member || ch.is_im || false,
                    isPrivate: ch.is_private || ch.is_mpim || false,
                    isIm: ch.is_im || false,
                    isMpim: ch.is_mpim || false,
                    numMembers: ch.num_members || 0,
                });
            }
            cursor = data.response_metadata?.next_cursor;
        } while (cursor);
        return channels;
    }

    async search(query, limit = 10) {
        const result = await this._api('search.messages', {
            query, count: Math.min(limit, 50), sort: 'timestamp', sort_dir: 'desc',
        });
        if (!result.messages?.matches) return [];
        return result.messages.matches.map(m => ({
            teamId: this.workspace?.teamId,
            teamName: this.workspace?.team,
            text: m.text,
            user: m.username || m.user,
            channel: m.channel?.name || m.channel?.id,
            timestamp: m.ts,
            permalink: m.permalink,
        }));
    }

    async getHistory(channelNameOrId, limit = 20, days_back = null) {
        let channelId = channelNameOrId;

        if (this.channelNameToId.has(channelNameOrId)) {
            channelId = this.channelNameToId.get(channelNameOrId);
        } else if (channelNameOrId.startsWith('#')) {
            const cleanName = channelNameOrId.replace(/^#/, '');
            channelId = await this._resolveChannelName(cleanName);
            if (!channelId) return { error: `Channel "${channelNameOrId}" not found in ${this.workspace?.team}` };
        } else if (!channelNameOrId.startsWith('C') && !channelNameOrId.startsWith('D')) {
            const cleanName = channelNameOrId.replace(/^@/, '');
            channelId = await this._resolveUserToDM(cleanName);
            if (!channelId) channelId = await this._resolveChannelName(cleanName);
            if (!channelId) return { error: `User or channel "${channelNameOrId}" not found in ${this.workspace?.team}` };
        }

        const params = { channel: channelId, limit: Math.min(limit, 100) };

        const history = await this._api('conversations.history', params);
        if (!history.messages) return [];

        let rawMessages = history.messages;
        if (days_back) {
            const oldest = Math.floor(Date.now() / 1000) - (days_back * 86400);
            rawMessages = rawMessages.filter(m => parseFloat(m.ts) >= oldest);
        }

        const messages = [];
        for (const msg of rawMessages.reverse()) {
            let uName = msg.user;
            if (msg.user) uName = await this._resolveUser(msg.user);
            else if (msg.bot_id) uName = msg.username || 'bot';

            messages.push({
                user: uName,
                text: msg.text,
                timestamp: msg.ts,
                teamId: this.workspace?.teamId,
                teamName: this.workspace?.team
            });
        }
        return messages;
    }

    getStatus() {
        return {
            teamId: this.workspace?.teamId,
            teamName: this.workspace?.team,
            connected: this.connected,
            workspace: this.workspace?.team || null,
            user: this.workspace?.user || null,
            mode: this.ws ? 'rtm' : (this.pollInterval ? 'polling' : 'disconnected'),
            listening: this.listening,
        };
    }

    async _api(method, body = {}) {
        const headers = {
            'Authorization': `Bearer ${this.xoxc}`,
            'Cookie': `d=${this.xoxd}`,
        };
        let fetchBody;
        if (method.startsWith('search.')) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
            fetchBody = new URLSearchParams(body).toString();
        } else {
            headers['Content-Type'] = 'application/json; charset=utf-8';
            fetchBody = JSON.stringify(body);
        }

        const res = await fetch(`${SLACK_API_BASE}/${method}`, { method: 'POST', headers, body: fetchBody });
        const data = await res.json();
        if (!data.ok) {
            if (data.error === 'token_revoked' || data.error === 'invalid_auth') {
                if (this.onTokenExpired) this.onTokenExpired(this.workspace?.teamId);
            }
            throw new Error(`Slack API ${method}: ${data.error}`);
        }
        return data;
    }

    async _resolveUser(userId) {
        if (this.userCache.has(userId)) return this.userCache.get(userId);
        try {
            const res = await this._api('users.info', { user: userId });
            const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
            this.userCache.set(userId, name);
            return name;
        } catch { return userId; }
    }

    async _resolveChannel(channelId) {
        if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);
        try {
            const res = await this._api('conversations.info', { channel: channelId });
            const info = { name: res.channel?.name || channelId, type: res.channel?.is_im ? 'im' : (res.channel?.is_mpim ? 'mpim' : 'channel') };
            this.channelCache.set(channelId, info);
            return info;
        } catch { return { name: channelId, type: 'unknown' }; }
    }

    async _resolveChannelName(name) {
        if (this.channelNameToId.has(name)) return this.channelNameToId.get(name);
        try {
            let cursor;
            do {
                const res = await this._api('conversations.list', { types: 'public_channel,private_channel,im,mpim', limit: 200, cursor });
                for (const ch of res.channels || []) {
                    this.channelNameToId.set(ch.name, ch.id);
                    if (ch.name === name) return ch.id;
                }
                cursor = res.response_metadata?.next_cursor;
            } while (cursor);
            return null;
        } catch { return null; }
    }

    async _resolveUserToDM(name) {
        const nameLower = name.toLowerCase();
        for (const [userId, cachedName] of this.userCache.entries()) {
            if (cachedName.toLowerCase() === nameLower) {
                try {
                    const dm = await this._api('conversations.open', { users: userId });
                    return dm.channel?.id || null;
                } catch { return null; }
            }
        }
        try {
            let cursor;
            do {
                const params = { limit: 200, cursor };
                if (this.workspace && this.workspace.teamId) {
                    params.team_id = this.workspace.teamId;
                }
                const res = await this._api('users.list', params);
                for (const user of res.members || []) {
                    if (user.deleted || user.is_bot) continue;
                    const displayName = (user.profile?.display_name || '').toLowerCase();
                    const realName = (user.real_name || '').toLowerCase();
                    const userName = (user.name || '').toLowerCase();

                    if (displayName === nameLower || realName === nameLower || userName === nameLower || realName.includes(nameLower) || displayName.includes(nameLower)) {
                        this.userCache.set(user.id, user.profile?.display_name || user.real_name || user.name);
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
}

class SlackManager {
    constructor(agentUrl) {
        this.agentUrl = agentUrl;
        this.connections = new Map(); // teamId -> SlackConnection
    }

    async start() {
        const creds = this._loadCredentials();
        if (!creds || creds.length === 0) {
            console.log('[SlackManager] No credentials found. Slack disabled until configured via UI.');
            return;
        }
        for (const cred of creds) {
            await this._initConnection(cred);
        }
    }

    async _initConnection(cred) {
        const conn = new SlackConnection(this.agentUrl, cred, async (teamId) => {
            console.error(`[SlackManager] Token expired for team ${teamId}`);
            await this._notifyTokenExpired(teamId);
        });

        // Connect to get workspace info if not cached, or just let start() fetch it
        await conn.start();
        if (conn.workspace && conn.workspace.teamId) {
            this.connections.set(conn.workspace.teamId, conn);
            // Save updated cred if we just discovered the team info
            this._saveCredentials();
        }
    }

    async addConnection(xoxc, xoxd) {
        // Test it first
        const conn = new SlackConnection(this.agentUrl, { xoxc, xoxd, listening: true, monitoredChannels: [] });
        await conn.start();
        if (!conn.workspace || !conn.workspace.teamId) {
            throw new Error('Failed to validate Slack connection');
        }

        // Stop old connection if overwriting
        if (this.connections.has(conn.workspace.teamId)) {
            await this.connections.get(conn.workspace.teamId).stop();
        }

        this.connections.set(conn.workspace.teamId, conn);
        this._saveCredentials();
        return conn.workspace;
    }

    async removeConnection(teamId) {
        const conn = this.connections.get(teamId);
        if (conn) {
            await conn.stop();
            this.connections.delete(teamId);
            this._saveCredentials();
            return true;
        }
        return false;
    }

    // Resolves to a target connection. If teamId is missing, logic dictates finding best match or searching all.
    resolveConnection(teamId) {
        if (teamId) {
            const conn = this.connections.get(teamId);
            if (!conn) throw new Error(`Slack workspace ${teamId} not connected.`);
            return conn;
        }

        // Auto-resolve if only 1 connection
        if (this.connections.size === 1) {
            return Array.from(this.connections.values())[0];
        }

        if (this.connections.size === 0) {
            throw new Error('No Slack workspaces connected.');
        }

        throw new Error('Multiple workspaces connected. Please specify teamId.');
    }

    // --- Aggregated/Proxied API ---

    setListening(teamId, listening) {
        const conn = this.resolveConnection(teamId);
        conn.listening = listening;
        this._saveCredentials();
    }

    getMonitoredChannels(teamId) {
        const conn = this.resolveConnection(teamId);
        return conn.monitoredChannels;
    }

    setMonitoredChannels(teamId, channels) {
        const conn = this.resolveConnection(teamId);
        conn.monitoredChannels = channels;
        this._saveCredentials();
    }

    async search(query, limit = 10, teamId = null) {
        if (teamId) {
            return await this.resolveConnection(teamId).search(query, limit);
        }

        // Parallel search across all connections
        const allResults = await Promise.all(
            Array.from(this.connections.values()).map(conn => conn.search(query, limit).catch(() => []))
        );
        return allResults.flat().sort((a, b) => parseFloat(b.timestamp) - parseFloat(a.timestamp)).slice(0, limit);
    }

    async getHistory(channelNameOrId, limit = 20, days_back = null, teamId = null) {
        if (teamId) {
            return await this.resolveConnection(teamId).getHistory(channelNameOrId, limit, days_back);
        }

        if (this.connections.size === 1) {
            return await Array.from(this.connections.values())[0].getHistory(channelNameOrId, limit, days_back);
        }

        // Try to auto-resolve across all workspaces (first match wins)
        for (const conn of this.connections.values()) {
            try {
                const hist = await conn.getHistory(channelNameOrId, limit, days_back);
                if (hist && !hist.error) return hist;
            } catch (e) {
                // Ignore and try next
            }
        }

        return { error: `Channel "${channelNameOrId}" not found in any connected workspace. Try specifying workspace.` };
    }

    async sendMessage(channelId, text, opts = {}, teamId = null) {
        if (teamId) {
            return await this.resolveConnection(teamId).sendMessage(channelId, text, opts);
        }

        if (this.connections.size === 1) {
            return await Array.from(this.connections.values())[0].sendMessage(channelId, text, opts);
        }

        // If no teamId but multiple connections, try it on all until one works (since channelIds are globally unique enough usually)
        for (const conn of this.connections.values()) {
            try {
                const res = await conn.sendMessage(channelId, text, opts);
                if (res.ok) return res;
            } catch (e) {
                // Ignore and try next
            }
        }

        throw new Error(`Failed to send message: Team could not be auto-resolved.`);
    }

    async getChannels(teamId) {
        return await this.resolveConnection(teamId).getChannels();
    }

    async getMonitoredChannelsHistory(days_back = 1) {
        console.log(`[SlackManager] Fetching aggregated monitored channels history (days_back: ${days_back})`);

        const allHistory = [];

        // Process each connected workspace
        for (const [teamId, conn] of this.connections) {
            if (!conn.connected || !conn.monitoredChannels || conn.monitoredChannels.length === 0) continue;

            console.log(`[SlackManager] Processing ${conn.monitoredChannels.length} monitored channels for team ${teamId}`);

            // We batch them to avoid slamming the Slack API instantly, but faster than serial.
            const BATCH_SIZE = 5;
            for (let i = 0; i < conn.monitoredChannels.length; i += BATCH_SIZE) {
                const batch = conn.monitoredChannels.slice(i, i + BATCH_SIZE);

                const promises = batch.map(async (ch) => {
                    try {
                        const messages = await conn.getHistory(ch.id, 50, days_back); // fetch up to 50 msgs per channel
                        if (messages.length === 0) return null;

                        // Format tightly to save tokens. e.g. "[Workspace/General] User: text"
                        const workspaceName = conn.workspace?.team || teamId;
                        const channelName = ch.name || ch.id;

                        const formattedMsgs = messages.map(m => {
                            const time = new Date(parseFloat(m.timestamp) * 1000).toISOString().split('T')[1].substring(0, 5);
                            return `[${time}] ${m.user}: ${m.text.replace(/\n/g, ' ')}`;
                        }).join('\n');

                        return `--- Workspace: ${workspaceName} | Channel: ${channelName} ---\n${formattedMsgs}`;
                    } catch (err) {
                        console.warn(`[SlackManager] Failed to fetch history for monitored channel ${ch.name} (${ch.id}):`, err.message);
                        return null;
                    }
                });

                const results = await Promise.all(promises);
                const validResults = results.filter(Boolean);
                if (validResults.length > 0) {
                    allHistory.push(...validResults);
                }
            }
        }

        if (allHistory.length === 0) {
            return "No recent messages found in any monitored channels.";
        }

        return allHistory.join('\n\n');
    }

    getStatus() {
        return Array.from(this.connections.values()).map(c => c.getStatus());
    }

    // --- Credential Encryption & Persistence ---

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

    _saveCredentials() {
        const dir = path.dirname(CREDENTIALS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const payload = Array.from(this.connections.values()).map(conn => ({
            workspace: conn.workspace,
            xoxc: this._encrypt(conn.xoxc),
            xoxd: this._encrypt(conn.xoxd),
            listening: conn.listening,
            monitoredChannels: conn.monitoredChannels,
            savedAt: new Date().toISOString(),
        }));

        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(payload, null, 2));
        console.log('[SlackManager] Credentials saved.');
    }

    _loadCredentials() {
        try {
            if (!fs.existsSync(CREDENTIALS_FILE)) return [];
            const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));

            // Legacy Migration: If it's an object instead of array
            if (!Array.isArray(raw)) {
                return [{
                    xoxc: this._decrypt(raw.xoxc),
                    xoxd: this._decrypt(raw.xoxd_enc || raw.xoxd),
                    workspace: raw.workspace,
                    listening: raw.listening,
                    monitoredChannels: raw.monitoredChannels || [],
                }];
            }

            return raw.map(cred => ({
                xoxc: this._decrypt(cred.xoxc),
                xoxd: this._decrypt(cred.xoxd),
                workspace: cred.workspace,
                listening: cred.listening,
                monitoredChannels: cred.monitoredChannels || []
            }));
        } catch (err) {
            console.error('[SlackManager] Failed to load credentials:', err.message);
            return [];
        }
    }

    // --- Helper ---
    async _notifyTokenExpired(teamId) {
        console.error(`[SlackManager] ⚠️ Token expired for ${teamId}. Notifying user...`);
        try {
            await axios.post(`${this.agentUrl}/webhook`, {
                content: `SYSTEM: Your Slack token for team ${teamId} has expired. Please re-login via Settings → Interfaces → Slack.`,
                source: 'system',
                role: 'user',
                metadata: { internal_system_alert: true },
            });
        } catch (err) {
            console.error('[SlackManager] Failed to send expiry notification:', err.message);
        }
    }
}

// Ensure tests that use SlackService are not completely broken if they use it. 
// For backward compatibility during migration, export both.
module.exports = { SlackManager, SlackService: SlackManager, SlackConnection };
