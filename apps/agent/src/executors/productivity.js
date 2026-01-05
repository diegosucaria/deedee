const { BaseExecutor } = require('./base');

class ProductivityExecutor extends BaseExecutor {
    async execute(name, args) {
        const { journal } = this.services;

        switch (name) {
            case 'logJournal': {
                const path = journal.log(args.content);
                return { success: true, path: path };
            }
            case 'readJournal': {
                const date = args.date || new Date().toISOString().split('T')[0];
                const content = journal.read(date);
                if (content) {
                    return { date, content };
                } else {
                    return { info: `No journal entry found for ${date}.` };
                }
            }
            case 'searchJournal': {
                const results = journal.search(args.query);
                return { count: results.length, results };
            }
            default: return null;
        }
    }
}

module.exports = { ProductivityExecutor };
