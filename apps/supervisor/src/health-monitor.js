const axios = require('axios');

class HealthMonitor {
    constructor() {
        this.services = ['agent', 'api', 'interfaces'];
        this.urls = {
            agent: process.env.AGENT_URL || 'http://agent:3000',
            api: process.env.API_URL || 'http://api:3001',
            interfaces: process.env.INTERFACES_URL || 'http://interfaces:5000'
        };
        this.status = {
            system: 'unknown',
            services: {},
            lastCheck: null
        };
        this.interval = null;
    }

    start(intervalMs = 30000) {
        this.check();
        this.interval = setInterval(() => this.check(), intervalMs);
        console.log('[HealthMonitor] Started polling services.');
    }

    async check() {
        const results = {};
        let systemStatus = 'ok';

        for (const service of this.services) {
            try {
                const res = await axios.get(`${this.urls[service]}/health`, { timeout: 2000 });
                results[service] = {
                    status: res.data.status || 'ok',
                    details: res.data
                };
                if (results[service].status !== 'ok') systemStatus = 'degraded';
            } catch (e) {
                results[service] = {
                    status: 'error',
                    error: e.message
                };
                systemStatus = 'degraded'; // Or critical?
            }
        }

        this.status = {
            system: systemStatus,
            services: results,
            lastCheck: new Date().toISOString()
        };
    }

    getStatus() {
        return this.status;
    }
}

module.exports = { HealthMonitor };
