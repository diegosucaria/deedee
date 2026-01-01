const { google } = require('googleapis');
const { GSuiteAuth } = require('./auth');

class GSuiteTools {
  constructor() {
    this.auth = new GSuiteAuth();
  }

  async listEvents({ timeMin, timeMax, maxResults = 10 }) {
    const auth = await this.auth.getClient();
    const calendar = google.calendar({ version: 'v3', auth });
    
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin || new Date().toISOString(),
      timeMax: timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    return res.data.items;
  }

  async sendEmail({ to, subject, body }) {
    const auth = await this.auth.getClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Simple text email construction
    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      '',
      body
    ];
    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    return res.data;
  }
}

module.exports = { GSuiteTools };
