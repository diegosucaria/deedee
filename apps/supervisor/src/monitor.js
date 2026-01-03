const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class Monitor {
    constructor(gitOps) {
        this.git = gitOps;
        this.agentUrl = process.env.AGENT_URL || 'http://agent:3000';
        this.interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
        this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

        // Config
        this.checkInterval = 60000; // 1 minute
        this.failThreshold = 3;     // Alert after 3 failures
        this.rollbackThreshold = 5; // Rollback after 5 failures
        this.dangerWindow = 10 * 60 * 1000; // 10 minutes after update

        // State
        this.failures = 0;
        this.intervalId = null;
        this.lastUpdate = Date.now(); // Assume we just started, so we are in danger window
    }

    start() {
        console.log('[Monitor] Starting health checks...');
        console.log(`[Monitor] Agent URL: ${this.agentUrl}`);
        if (this.slackWebhookUrl) console.log('[Monitor] Slack alerting enabled.');

        // Initial check
        this.check();

        this.intervalId = setInterval(() => this.check(), this.checkInterval);
    }

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
    }

    async check() {
        try {
            // Use native fetch (Node 18+)
            const res = await fetch(`${this.agentUrl}/health`);
            if (res.ok) {
                // Determine if we should run a Deep Logic Check
                // CheckInterval is 1 min. We want 1 hour. so 60 checks.
                // We can use a counter or modulo on time? Counter is safer for "every N checks".
                this.checkCounter = (this.checkCounter || 0) + 1;

                if (this.checkCounter >= 60) {
                    this.checkCounter = 0;
                    console.log('[Monitor] Running Deep Logic Check...');
                    await this._deepCheck();
                }

                if (this.failures > 0) {
                    console.log('[Monitor] Agent recovered!');
                    await this.alertUser('✅ **Agent Recovered**\nAgent is back online.');
                    this.failures = 0;
                }
                return;
            }
            throw new Error(`Status ${res.status}`);
        } catch (error) {
            this.failures++;
            console.warn(`[Monitor] Health check failed (${this.failures}): ${error.message}`);
            await this.handleFailure();
        }
    }

    async _deepCheck() {
        try {
            const res = await fetch(`${this.agentUrl}/v1/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN || 'test-token'}`
                },
                body: JSON.stringify({
                    content: 'HEALTH_CHECK_PING_123',
                    metadata: { internal_health_check: true }
                })
            });

            if (!res.ok) throw new Error(`Deep Check HTTP ${res.status}`);

            const data = await res.json();
            // We expect the agent to reply with something like "PONG" or "I am here" if we programmed it 
            // OR we just check if it returns VALID JSON with text.
            // If the agent creates an empty response or error text, we catch it.

            if (!data || !data.text || data.text.length === 0) {
                throw new Error('Deep Check: Empty response from Agent');
            }

            console.log(`[Monitor] Deep Check Passed. Agent replied: "${data.text.substring(0, 20)}..."`);
        } catch (err) {
            console.error(`[Monitor] Deep Logic Check FAILED: ${err.message}`);
            // Force a failure count increment to trigger potential rollback if this persists
            // We weigh deep checks heavier? Or just treat as 1 failure?
            // Treating as 1 failure for now to avoid instant rollback on single hiccup.
            throw err; // Propagate to catch block in check() to increment failures
        }
    }

    async handleFailure() {
        // Tier 1: Alert
        if (this.failures === this.failThreshold) {
            await this.alertUser(`⚠️ **Agent Alert**\nAgent is unresponsive (3 consecutive failures).`);
        }

        // Tier 2: Auto-Rollback
        const timeSinceUpdate = Date.now() - this.lastUpdate;
        if (this.failures >= this.rollbackThreshold && timeSinceUpdate < this.dangerWindow) {
            console.warn('[Monitor] Rollback threshold reached inside danger window. Initiating rollback...');
            await this.alertUser(`🔄 **Auto-Rollback Triggered**\nAgent crashed repeatedly after recent update. Rolling back changes...`);

            try {
                const result = await this.git.rollback();
                if (result.success) {
                    await this.alertUser(`✅ Rollback successful. Waiting for restart...`);
                    // Reset failures to give it time to restart
                    this.failures = 0;
                    // Reset lastUpdate to "Infinity" (past) effectively closing the danger window for this run.
                    this.lastUpdate = 0;
                } else {
                    await this.alertUser(`❌ Rollback failed: ${result.error}`);
                }
            } catch (err) {
                console.error('[Monitor] Rollback exception:', err);
            }
        }
    }

    async alertUser(message) {
        console.log(`[Monitor Alert] ${message}`);

        // Slack Webhook
        if (this.slackWebhookUrl) {
            try {
                await fetch(this.slackWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: message })
                });
            } catch (err) {
                console.error('[Monitor] Failed to send Slack alert:', err.message);
            }
        }
    }
}

module.exports = { Monitor };
