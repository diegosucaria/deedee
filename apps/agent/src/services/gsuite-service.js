const { google } = require('googleapis');

class GSuiteService {
    constructor(agent) {
        this.agent = agent;
        this.clients = new Map(); // email -> OAuth2Client
        this.ready = false;

        // Try to load clients on startup
        this._loadClients().catch(err => console.error('[GSuite] Failed to load clients:', err));
    }

    async _loadClients() {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

        if (!clientId || !clientSecret) {
            console.warn('[GSuite] GOOGLE_CLIENT_ID or SECRET not set. OAuth unavailable.');
            return;
        }

        // Fetch tokens from DB "google_tokens" setting
        // Assuming agent.db has getSetting, similar to getWatchers
        // agent.js loads settings into this.agent.settings, but we want fresh DB read or use helper
        // DB Schema for settings: key (TEXT), value (TEXT/JSON)
        // Access via agent.db.db.prepare... or use agent.db.getKey if it exists?
        // agent.js:98: SELECT key, value FROM agent_settings
        // There is no public getSetting method in agent.js logic except loadSettings().
        // I will access db directly via agent.db.db or add a helper if I could.
        // Assuming `agent.db` has a `getSetting` or I implement a quick read.

        let tokensData = [];
        try {
            // Re-use logic or access raw DB?
            // AgentDB usually exposes specific methods.
            // Query agent_settings table directly (no public getSetting helper in AgentDB)
            const row = this.agent.db.db.prepare("SELECT value FROM agent_settings WHERE key = ?").get('google_tokens');
            if (row) {
                tokensData = JSON.parse(row.value);
            }
        } catch (e) {
            console.warn('[GSuite] Error reading tokens from DB:', e.message);
        }

        if (!Array.isArray(tokensData)) tokensData = [];

        this.clients.clear();
        for (const account of tokensData) {
            if (account.email && account.tokens) {
                const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
                auth.setCredentials(account.tokens);
                auth._label = account.label; // Assign label to instance
                this.clients.set(account.email, auth);
                console.log(`[GSuite] Loaded client for ${account.email} ${account.label ? `(${account.label})` : ''}`);
            }
        }
        this.ready = true;
    }

    async getAuthUrl() {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

        if (!clientId || !clientSecret) return "Error: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured.";

        const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const url = auth.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent', // Force refresh token generation
            scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email']
        });
        return url;
    }

    async authenticate(code) {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

        const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        try {
            const { tokens } = await auth.getToken(code);
            auth.setCredentials(tokens);

            // Get User Email
            const oauth2 = google.oauth2({ version: 'v2', auth });
            const userInfo = await oauth2.userinfo.get();
            const email = userInfo.data.email;

            // Save to DB (Preserve existing label if updating)
            let currentTokens = this._getTokensFromDB();

            // Update or Append
            const existingIndex = currentTokens.findIndex(t => t.email === email);
            let label = null;

            if (existingIndex >= 0) {
                label = currentTokens[existingIndex].label; // Preserve label
                currentTokens[existingIndex] = { email, tokens, label };
            } else {
                currentTokens.push({ email, tokens, label: null });
            }

            this._saveTokensToDB(currentTokens);

            // Reload memory
            const authWithLabel = auth;
            authWithLabel._label = label;
            this.clients.set(email, authWithLabel);

            this.ready = true;

            return `Authentication successful for ${email}. Calendar is ready.`;

        } catch (e) {
            console.error('[GSuite] Auth failed:', e);
            return `Authentication failed: ${e.message}`;
        }
    }

    async setAccountLabel(emailOrIndex, label) {
        let tokens = this._getTokensFromDB();
        let targetIndex = -1;

        // Try index
        const idx = parseInt(emailOrIndex) - 1; // 1-based index from user
        if (!isNaN(idx) && idx >= 0 && idx < tokens.length) {
            targetIndex = idx;
        } else {
            // Try email
            targetIndex = tokens.findIndex(t => t.email === emailOrIndex);
        }

        if (targetIndex === -1) return `Account '${emailOrIndex}' not found.`;

        tokens[targetIndex].label = label;
        this._saveTokensToDB(tokens);
        await this._loadClients(); // Reload to update memory
        return `Account ${tokens[targetIndex].email} is now labeled as '${label}'.`;
    }

    async listAccounts() {
        const tokens = this._getTokensFromDB();
        if (tokens.length === 0) return "No accounts connected.";
        return tokens.map((t, i) => `${i + 1}. ${t.email} ${t.label ? `(${t.label})` : ''}`).join('\n');
    }

    _getTokensFromDB() {
        try {
            const row = this.agent.db.db.prepare("SELECT value FROM agent_settings WHERE key = ?").get('google_tokens');
            return row ? JSON.parse(row.value) || [] : [];
        } catch (e) { return []; }
    }

    _saveTokensToDB(data) {
        const stmt = this.agent.db.db.prepare("INSERT OR REPLACE INTO agent_settings (key, value) VALUES (?, ?)");
        stmt.run('google_tokens', JSON.stringify(data));
    }

    async listEvents({ timeMin, timeMax, maxResults = 10 }) {
        if (!this.ready || this.clients.size === 0) return 'No Google accounts connected. Use /google_auth to login.';

        let allEvents = [];

        // Fetch from ALL accounts
        for (const [email, auth] of this.clients.entries()) {
            try {
                const calendar = google.calendar({ version: 'v3', auth });
                const res = await calendar.events.list({
                    calendarId: 'primary',
                    timeMin: timeMin || new Date().toISOString(),
                    timeMax: timeMax,
                    maxResults,
                    singleEvents: true,
                    orderBy: 'startTime',
                });

                const items = res.data.items || [];
                // Tag with email/label
                const accountLabel = auth._label || email;
                items.forEach(item => {
                    item._account = accountLabel;
                    item._me = email; // For status check
                });
                allEvents = allEvents.concat(items);
            } catch (e) {
                console.warn(`[GSuite] Failed to list events for ${email}:`, e.message);
                if (e.message.includes('invalid_grant')) {
                    // Token expired/revoked?
                    // Could handle refresh or warn user
                }
            }
        }

        if (allEvents.length === 0) return 'No upcoming events found across connected accounts.';

        // Sort by start time
        allEvents.sort((a, b) => {
            const dateA = new Date(a.start.dateTime || a.start.date);
            const dateB = new Date(b.start.dateTime || b.start.date);
            return dateA - dateB;
        });

        // Limit results
        allEvents = allEvents.slice(0, maxResults * 2);

        return allEvents.map((event, i) => {
            const start = event.start.dateTime || event.start.date;

            // Determine Status
            let status = '';
            if (event.organizer?.self) {
                status = 'Organizer';
            } else if (event.attendees) {
                const me = event.attendees.find(a => a.self || a.email === event._me);
                if (me) {
                    status = me.responseStatus; // accepted, tentative, needsAction, declined
                }
            }
            if (!status) status = 'Event';

            return `${i + 1}. [${event._account}] [${start}] ${event.summary} (${status})`;
        }).join('\n');
    }

    async createEvent({ summary, startTime, endTime, description, timeZone }) {
        if (!this.ready || this.clients.size === 0) return 'No Google accounts connected.';

        // Select Account: Prefer 'personal', then first one
        let targetEmail = null;
        let targetAuth = null;

        for (const [email, auth] of this.clients.entries()) {
            if (auth._label === 'personal') {
                targetEmail = email;
                targetAuth = auth;
                break;
            }
        }

        // Fallback to first
        if (!targetAuth) {
            targetEmail = this.clients.keys().next().value;
            targetAuth = this.clients.get(targetEmail);
        }

        if (!targetAuth) return 'Internal Error: Client not found.';

        try {
            if (!summary || !startTime || !endTime) {
                return { error: 'Missing required fields: summary, startTime, endTime' };
            }

            const calendar = google.calendar({ version: 'v3', auth: targetAuth });

            const event = {
                summary,
                description,
                start: { dateTime: startTime },
                end: { dateTime: endTime },
            };

            if (timeZone) {
                event.start.timeZone = timeZone;
                event.end.timeZone = timeZone;
            }

            const res = await calendar.events.insert({
                calendarId: 'primary',
                resource: event,
            });

            return `Event created on ${targetEmail} (${targetAuth._label || 'Primary'}): ${res.data.htmlLink}`;

        } catch (error) {
            console.error('[GSuite] createEvent Error:', error);
            return `Error creating event: ${error.message}`;
        }
    }

    async sendEmail(args) { return "Not implemented in OAuth mode yet."; }
}

module.exports = { GSuiteService };
