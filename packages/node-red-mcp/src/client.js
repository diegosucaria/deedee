const axios = require('axios');

class NodeREDClient {
    constructor(baseUrl, username, password) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.username = username;
        this.password = password;
        this.token = null;
        this.client = axios.create({
            baseURL: this.baseUrl,
            validateStatus: status => status < 500
        });
    }

    async authenticate() {
        if (!this.username || !this.password) return;

        // Try Node-RED specific Token Auth first
        try {
            const response = await this.client.post('/auth/token', {
                client_id: 'node-red-editor',
                grant_type: 'password',
                username: this.username,
                password: this.password,
                scope: '*'
            });

            if (response.status === 200 && response.data.access_token) {
                this.token = response.data.access_token;
                console.error('[NodeRED] Authenticated via /auth/token (Bearer)');
                return;
            }
        } catch (e) {
            // Ignore auth endpoint failure, fall through to Basic Auth
            console.error('[NodeRED] /auth/token failed, trying Basic Auth fallback:', e.message);
        }

        // Fallback: Assume HTTP Basic Auth
        // We set a flag so _getHeaders knows to use it.
        this.useBasicAuth = true;
        console.error('[NodeRED] Using HTTP Basic Auth');
    }

    async _getHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'Node-RED-API-Version': 'v2'
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        } else if (this.useBasicAuth && this.username && this.password) {
            const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64');
            headers['Authorization'] = `Basic ${encoded}`;
        }

        return headers;
    }

    // --- Flows ---

    async listFlows() {
        // GET /flows returns the active flow configuration
        const headers = await this._getHeaders();

        try {
            const response = await this.client.get('/flows', { headers });

            if (response.status !== 200) throw new Error(`Failed to list flows: ${response.status} ${response.statusText}`);

            let data = response.data;

            // Handle v1 (array) vs v2 ({ rev, flows: [] }) structure
            if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.flows)) {
                data = data.flows;
            } else if (!Array.isArray(data)) {
                // Helper: if data is empty/null, return empty array. If single object, wrap it.
                if (!data) {
                    data = [];
                } else {
                    data = [data];
                }
            }
            return data;
        } catch (error) {
            console.error('[NodeRED] Request Failed:', error.message);
            throw error;
        }
    }

    async getFlow(flowId) {
        // The /flows endpoint returns ALL flows. We filter client-side.
        // Node-RED doesn't have a GET /flow/:id endpoint that returns just that flow in standard API?
        // Actually /flow/:id exists in admin api.
        const headers = await this._getHeaders();
        const response = await this.client.get(`/flow/${encodeURIComponent(flowId)}`, { headers });
        if (response.status !== 200) throw new Error(`Failed to get flow ${flowId}: ${response.status} ${response.statusText}`);
        return response.data;
    }

    async updateFlow(flowId, flowData) {
        // PUT /flow/:id
        const headers = await this._getHeaders();
        const response = await this.client.put(`/flow/${encodeURIComponent(flowId)}`, flowData, { headers });
        if (response.status !== 200) throw new Error(`Failed to update flow ${flowId}: ${response.status} ${response.statusText}`);
        return response.data;
    }

    async deploy() {
        // Trigger a full deployment
        const headers = await this._getHeaders();
        headers['Node-RED-Deployment-Type'] = 'full'; // 'full', 'nodes', 'flows', 'reload'

        try {
            // 1. Get current flows (to post back)
            // We need the raw response usually, but listFlows normalizes it.
            // Let's use the raw client to be safe or rely on listFlows output if it's just the array.
            const currentFlows = await this.listFlows();

            // 2. Post back to trigger deploy
            const response = await this.client.post('/flows', currentFlows, { headers });

            if (response.status !== 200 && response.status !== 204) {
                throw new Error(`Deploy failed: ${response.status} ${response.statusText}`);
            }
            return { success: true, rev: response.data.rev };
        } catch (e) {
            console.error('[NodeRED] Deploy failed:', e.message);
            throw e;
        }
    }
}

module.exports = { NodeREDClient };
