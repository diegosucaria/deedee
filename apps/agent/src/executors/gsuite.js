const { BaseExecutor } = require('./base');

class GSuiteExecutor extends BaseExecutor {
    async execute(name, args) {
        const { gsuite } = this.services;

        switch (name) {
            case 'listEvents': return await gsuite.listEvents(args);
            case 'sendEmail': return await gsuite.sendEmail(args);
            default: return null;
        }
    }
}

module.exports = { GSuiteExecutor };
