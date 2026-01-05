class BaseExecutor {
    constructor(services) {
        this.services = services;
    }

    async execute(name, args, context) {
        throw new Error('Method not implemented');
    }
}

module.exports = { BaseExecutor };
