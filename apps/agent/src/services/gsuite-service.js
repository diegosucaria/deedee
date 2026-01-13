const { google } = require('googleapis');
const fs = require('fs');

class GSuiteService {
    constructor(agent) {
        this.agent = agent;
        this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
        this.calendar = null;

        this._initClient();
    }

    _initClient() {
        try {
            const credentialsVar = process.env.GOOGLE_APPLICATION_CREDENTIALS;
            if (!credentialsVar) {
                console.warn('[GSuite] GOOGLE_APPLICATION_CREDENTIALS not set. Calendar tools will fail.');
                return;
            }

            // Check if it's base64 encoded JSON (starts with '{' after decode? or just check if it's not a file path)
            // Heuristic: If it contains "type": "service_account", it's JSON content.
            // If it starts with "/" or "./", it's a path.
            // If base64, decoding it should yield JSON.

            let authOptions = {};

            // Try to decode parameters if they look like base64 (no path separators, long string)
            // But user said "base64 encoded json key". 
            // Simple check: try to buffer.from(base64).toString() and see if it parses as JSON.
            let credentials = null;

            if (!credentialsVar.includes('/') && !credentialsVar.includes('\\') && !credentialsVar.endsWith('.json')) {
                try {
                    const decoded = Buffer.from(credentialsVar, 'base64').toString('utf8');
                    credentials = JSON.parse(decoded);
                    // verify it has expected fields
                    if (!credentials.project_id || !credentials.client_email) {
                        credentials = null; // invalid structure, maybe it was a weird path?
                    }
                } catch (e) {
                    // Not a valid base64 json
                    credentials = null;
                }
            }

            if (credentials) {
                // It was base64 content
                authOptions = { credentials };
            } else {
                // Assume it's a file path
                authOptions = { keyFile: credentialsVar };
            }

            // Scopes
            authOptions.scopes = ['https://www.googleapis.com/auth/calendar'];

            const auth = new google.auth.GoogleAuth(authOptions);
            this.calendar = google.calendar({ version: 'v3', auth });

            console.log('[GSuite] Calendar Client Initialized');

        } catch (error) {
            console.error('[GSuite] Failed to initialize client:', error.message);
        }
    }

    async listEvents({ timeMin, timeMax, maxResults = 10 }) {
        if (!this.calendar) return { error: 'GSuite credentials not configured.' };

        try {
            const res = await this.calendar.events.list({
                calendarId: this.calendarId,
                timeMin: timeMin || new Date().toISOString(),
                timeMax: timeMax,
                maxResults,
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = res.data.items;
            if (!events || events.length === 0) {
                return 'No upcoming events found.';
            }

            return events.map((event, i) => {
                const start = event.start.dateTime || event.start.date;
                return `${i + 1}. [${start}] ${event.summary} (${event.status})`;
            }).join('\n');

        } catch (error) {
            console.error('[GSuite] listEvents Error:', error);
            return `Error listing events: ${error.message}`;
        }
    }

    async createEvent({ summary, startTime, endTime, description }) {
        if (!this.calendar) return { error: 'GSuite credentials not configured.' };

        try {
            // Basic validation
            if (!summary || !startTime || !endTime) {
                return { error: 'Missing required fields: summary, startTime, endTime' };
            }

            const event = {
                summary,
                description,
                start: {
                    dateTime: startTime, // ISO 8601 expected
                    timeZone: 'UTC', // OR default to agent's timezone if known? strict ISO usually includes offset.
                },
                end: {
                    dateTime: endTime,
                    timeZone: 'UTC',
                },
            };

            const res = await this.calendar.events.insert({
                calendarId: this.calendarId,
                resource: event,
            });

            return `Event created: ${res.data.htmlLink}`;

        } catch (error) {
            console.error('[GSuite] createEvent Error:', error);
            return `Error creating event: ${error.message}`;
        }
    }

    // Placeholder for sendEmail if needed later
    async sendEmail(args) {
        return "Not implemented yet.";
    }
}

module.exports = { GSuiteService };
