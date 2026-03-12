class BaseExecutor {
    constructor(services) {
        this.services = services;
    }

    /**
     * Execute a tool by name.
     * @param {string} name - Tool name
     * @param {Object} args - Tool arguments
     * @param {Object} context - Per-call context (message, sendCallback, etc.)
     * @param {Object} [callServices] - Per-call services snapshot (overrides this.services
     *   for properties like client/interface that vary per concurrent call)
     */
    async execute(name, args, context, callServices) {
        throw new Error('Method not implemented');
    }

    /**
     * Returns per-call services if provided, otherwise falls back to shared services.
     * Use this in executor implementations to access services that may vary per call
     * (e.g. client, interface) to avoid race conditions with concurrent processMessage calls.
     */
    getServices(callServices) {
        return callServices || this.services;
    }
}

module.exports = { BaseExecutor };
