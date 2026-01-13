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
            // Let's assume we can query `agent_settings`
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
                this.clients.set(account.email, auth);
                console.log(`[GSuite] Loaded client for ${account.email}`);
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

            // Save to DB
            let currentTokens = [];
            try {
                const row = this.agent.db.db.prepare("SELECT value FROM agent_settings WHERE key = ?").get('google_tokens');
                if (row) currentTokens = JSON.parse(row.value);
            } catch (e) { /* ignore */ }

            if (!Array.isArray(currentTokens)) currentTokens = [];

            // Update or Append
            const existingIndex = currentTokens.findIndex(t => t.email === email);
            if (existingIndex >= 0) {
                currentTokens[existingIndex] = { email, tokens };
            } else {
                currentTokens.push({ email, tokens });
            }

            // Save back to DB
            const stmt = this.agent.db.db.prepare("INSERT OR REPLACE INTO agent_settings (key, value) VALUES (?, ?)");
            stmt.run('google_tokens', JSON.stringify(currentTokens));

            // Reload memory
            this.clients.set(email, auth);
            this.ready = true;

            return `Authentication successful for ${email}. Calendar is ready.`;

        } catch (e) {
            console.error('[GSuite] Auth failed:', e);
            return `Authentication failed: ${e.message}`;
        }
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
                // Tag with email
                items.forEach(item => {
                    item._account = email;
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

        // Limit total results (heuristic: maxResults * number of accounts? or global max?)
        // Let's return reasonable amount
        allEvents = allEvents.slice(0, maxResults * 2);

        return allEvents.map((event, i) => {
            const start = event.start.dateTime || event.start.date;
            return `${i + 1}. [${event._account}] [${start}] ${event.summary} (${event.status})`;
        }).join('\n');
    }

    async createEvent({ summary, startTime, endTime, description }) {
        if (!this.ready || this.clients.size === 0) return 'No Google accounts connected. Use /google_auth to login.';

        // Default to first account
        const email = this.clients.keys().next().value;
        const auth = this.clients.get(email);

        if (!auth) return 'Internal Error: Client not found.';

        try {
            if (!summary || !startTime || !endTime) {
                return { error: 'Missing required fields: summary, startTime, endTime' };
            }

            const calendar = google.calendar({ version: 'v3', auth });

            const event = {
                summary,
                description,
                start: {
                    dateTime: startTime,
                    timeZone: 'UTC', // Best effort
                },
                end: {
                    dateTime: endTime,
                    timeZone: 'UTC',
                },
            };

            const res = await calendar.events.insert({
                calendarId: 'primary',
                resource: event,
            });

            return `Event created on ${email} (primary): ${res.data.htmlLink}`;

        } catch (error) {
            console.error('[GSuite] createEvent Error:', error);
            return `Error creating event: ${error.message}`;
        }
    }

    async sendEmail(args) { return "Not implemented in OAuth mode yet."; }
}

module.exports = { GSuiteService };
