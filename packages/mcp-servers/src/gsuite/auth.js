const { google } = require('googleapis');

class GSuiteAuth {
  constructor() {
    this.auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/gmail.send'
      ]
    });
  }

  async getClient() {
    return this.auth.getClient();
  }
}

module.exports = { GSuiteAuth };
