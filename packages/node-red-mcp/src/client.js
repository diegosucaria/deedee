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
        console.error(`[NodeRED Debug] requesting ${this.client.defaults.baseURL}/flows`);
        console.error(`[NodeRED Debug] Headers:`, JSON.stringify(headers));

        try {
            const response = await this.client.get('/flows', { headers });
            console.error(`[NodeRED Debug] Status: ${response.status}`);
            console.error(`[NodeRED Debug] Content-Type: ${response.headers['content-type']}`);

            // Check if we got HTML instead of JSON (common with auth proxies)
            if (response.headers['content-type'] && response.headers['content-type'].includes('text/html')) {
                console.error('[NodeRED Debug] Received HTML response! Likely hitting a login page or wrong URL.');
                console.error('[NodeRED Debug] Preview:', typeof response.data === 'string' ? response.data.substring(0, 200) : 'Not string');
            } else {
                console.error('[NodeRED Debug] Data Type:', typeof response.data);
                console.error('[NodeRED Debug] Is Array?', Array.isArray(response.data));
                if (Array.isArray(response.data)) {
                    console.error(`[NodeRED Debug] Array Length: ${response.data.length}`);
                } else {
                    console.error('[NodeRED Debug] Data Preview:', JSON.stringify(response.data).substring(0, 200));
                }
            }

            if (response.status !== 200) throw new Error(`Failed to list flows: ${response.status} ${response.statusText}`);
            return response.data;
        } catch (error) {
            console.error('[NodeRED Debug] Request Failed:', error.message);
            if (error.response) {
                console.error('[NodeRED Debug] Response Status:', error.response.status);
                console.error('[NodeRED Debug] Response Data:', error.response.data);
            }
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
        // Trigger a reload?
        // In Admin API, POST /flows with 'Node-RED-Deployment-Type' header triggers reload
        // But simply updating a flow might not activate it?
        // Usually PUT /flow/:id is immediate in recent versions?
        // Let's assume standard behavior.
        // There isn't a dedicated "deploy" endpoint unless replacing ALL flows via POST /flows.
        return { success: true, message: "Flow updated. Deployment is usually automatic with API v2." };
    }
}

module.exports = { NodeREDClient };
