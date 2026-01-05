const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
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

        // Startup Notification
        this.notifyStartup();

        // Initial check
        this.check();

        this.intervalId = setInterval(() => this.check(), this.checkInterval);
    }

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
    }

    async notifyStartup() {
        if (!this.slackWebhookUrl) return;

        try {
            const trackingFile = path.join(this.git.workDir, '.last_boot_commit');
            
            // Get current commit info
            // %H: commit hash, %s: subject
            // Using git run to ensure we are in the correct directory
            const commitInfo = await this.git.run('git log -1 --pretty=format:"%H|%s"');
            
            if (!commitInfo) {
                console.warn('[Monitor] Could not retrieve git info for startup notification.');
                return;
            }

            const [currentHash, ...msgParts] = commitInfo.split('|');
            const currentMessage = msgParts.join('|');

            let lastHash = '';
            if (fs.existsSync(trackingFile)) {
                lastHash = fs.readFileSync(trackingFile, 'utf-8').trim();
            }

            if (currentHash !== lastHash) {
                // New commit or first run
                const text = `🚀 *Deedee Rebooted* (New Update)\n*Commit:* ${currentMessage}\n*Hash:* \`${currentHash.substring(0, 7)}\``;
                await this.alertUser(text);
                
                // Save the new hash so we don't notify again for this commit
                fs.writeFileSync(trackingFile, currentHash);
            } else {
                // Same commit, just a restart
                const text = `♻️ *Deedee Rebooted* (No Changes)\nI'm back online!`;
                await this.alertUser(text);
            }

        } catch (err) {
            console.error('[Monitor] Startup notification failed:', err.message);
        }
    }

    async check() {
        try {
            // Use native fetch (Node 18+)
            const res = await fetch(`${this.agentUrl}/health`);
            if (res.ok) {
                // Determine if we should run a Deep Logic Check
                // CheckInterval is 1 min. We want 6 hours. so 360 checks.
                this.checkCounter = (this.checkCounter || 0) + 1;

                if (this.checkCounter >= 360) {
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
            
            // Check for valid response.
            // Support both simplified { text: "..." } and standard { replies: [{ content: "..." }] }
            const hasText = data && data.text && data.text.length > 0;
            const hasReplies = data && data.replies && Array.isArray(data.replies) && data.replies.length > 0;

            if (!hasText && !hasReplies) {
                throw new Error('Deep Check: Empty response from Agent');
            }

            const replyContent = hasText ? data.text : data.replies[0].content;
            console.log(`[Monitor] Deep Check Passed. Agent replied: "${(replyContent || '').substring(0, 20)}..."`);
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
