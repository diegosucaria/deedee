const { BaseExecutor } = require('./base');

class GSuiteExecutor extends BaseExecutor {
    async execute(name, args) {
        const { gsuite } = this.services;

        switch (name) {
            case 'google_calendar_get_events': return await gsuite.getEvents(args.timeMin, args.k);
            case 'google_calendar_create_event': return await gsuite.createEvent(args);
            case 'google_search_emails': return await gsuite.searchEmails(args.query, args.k);
            case 'google_create_draft': return await gsuite.createDraft(args);
            default: return null;
        }
    }
}

module.exports = { GSuiteExecutor };
