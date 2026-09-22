const fs = require('fs');
const path = require('path');

// HEAD at the last supervisor start, in the supervisor-only state dir. Only
// the startup notice uses it.
const BOOT_FILE = '.last_boot_commit';

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
        this.fetchTimeout = 10000;  // Every outbound fetch gives up after 10 s

        // Rollback policy. Self-improvement reaches master only through a
        // pull request the owner merges. When the agent fails soon after such
        // a merge, the supervisor alerts and opens a revert pull request. It
        // never pushes master; owner commits never get a revert.
        this.autoRollback = (process.env.SUPERVISOR_AUTO_ROLLBACK || 'true') !== 'false';
        // How long after a merge a failure still counts against it. A Balena
        // build and download can take well over ten minutes.
        const windowMinutes = Number(process.env.SUPERVISOR_ROLLBACK_WINDOW_MINUTES) || 60;
        this.rollbackWindow = windowMinutes * 60 * 1000;

        this.stateDir = process.env.SUPERVISOR_STATE_DIR || '/app/state';

        // State
        this.failures = 0;
        this.intervalId = null;
    }

    async start() {
        console.log('[Monitor] Starting health checks...');
        console.log(`[Monitor] Agent URL: ${this.agentUrl}`);
        console.log(`[Monitor] State dir: ${this.stateDir}`);
        if (this.slackWebhookUrl) console.log('[Monitor] Slack alerting enabled.');

        // Startup Notification
        await this.notifyStartup();

        // Initial check
        this.check();

        this.intervalId = setInterval(() => this.check(), this.checkInterval);
    }

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
    }

    // ----- HEAD -----

    /**
     * HEAD as { hash, authorEmail, subject }, or null when git prints nothing.
     * Runs without a shell. %x09 is a tab, so no pipe character is involved.
     */
    async readHead() {
        const raw = await this.git.git(['log', '-1', '--pretty=format:%H%x09%ae%x09%s']);
        if (!raw) return null;
        const [hash, authorEmail = '', ...rest] = raw.split('\t');
        return {
            hash: hash.trim(),
            authorEmail: authorEmail.trim(),
            subject: rest.join('\t').trim()
        };
    }

    // ----- State files -----

    _stateFile(name) {
        return path.join(this.stateDir, name);
    }

    _readState(name) {
        try {
            const file = this._stateFile(name);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
        } catch (err) {
            console.warn(`[Monitor] Could not read ${name}:`, err.message);
            return '';
        }
    }

    _writeState(name, value) {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(this._stateFile(name), value);
    }

    _readLastBootCommit() { return this._readState(BOOT_FILE); }
    _writeLastBootCommit(hash) { this._writeState(BOOT_FILE, hash); }

    async notifyStartup() {
        try {
            const head = await this.readHead();
            if (!head) {
                console.warn('[Monitor] Could not retrieve git info for startup notification.');
                return;
            }

            const lastHash = this._readLastBootCommit();

            if (head.hash !== lastHash) {
                // New commit or first run
                const text = `🚀 *Deedee Rebooted* (New Update)\n*Commit:* ${head.subject}\n*Hash:* \`${head.hash.substring(0, 7)}\``;
                await this.alertUser(text);

                // Save the new hash so we don't notify again for this commit
                this._writeLastBootCommit(head.hash);
            } else {
                // Same commit, just a restart
                const text = `♻️ *Deedee Rebooted* (No Changes)\nI'm back online!`;
                await this.alertUser(text);
            }

        } catch (err) {
            console.error('[Monitor] Startup notification failed:', err.message);
        }
    }

    // ----- Health checks -----

    async check() {
        try {
            // Use native fetch (Node 18+)
            const res = await fetch(`${this.agentUrl}/health`, { signal: AbortSignal.timeout(this.fetchTimeout) });
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
            const res = await fetch(`${this.agentUrl}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Every agent route but /health wants the internal token.
                    'Authorization': `Bearer ${process.env.DEEDEE_INTERNAL_TOKEN || process.env.DEEDEE_API_TOKEN || 'test-token'}`
                },
                body: JSON.stringify({
                    content: 'HEALTH_CHECK_PING_123',
                    metadata: { internal_health_check: true }
                }),
                signal: AbortSignal.timeout(this.fetchTimeout)
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

        // Tier 2: revert pull request, once per failure streak.
        if (this.failures !== this.rollbackThreshold) return;
        if (!this.autoRollback) {
            console.warn('[Monitor] Rollback threshold reached but auto-rollback is disabled. Alert only.');
            return;
        }

        let merged;
        try {
            merged = await this.findRecentSelfMerge();
        } catch (err) {
            console.error('[Monitor] Could not check self-improvement pull requests:', err.message);
            return;
        }
        if (!merged) {
            console.warn('[Monitor] Rollback threshold reached, but no self-improvement pull request merged recently. Alert only.');
            return;
        }

        console.warn(`[Monitor] Agent failing after self-improvement PR #${merged.number} merged. Opening a revert pull request.`);
        await this.alertUser(`🔄 **Agent failing after a self-improvement**\nPR #${merged.number} merged ${this._minutesAgo(merged.mergedAt)} min ago. Opening a revert pull request; nothing is pushed to master.`);

        try {
            const result = await this.git.rollback({
                commit: merged.mergeCommit,
                reason: `The supervisor's health check failed ${this.failures} times in a row after pull request #${merged.number} merged.`
            });
            if (result.success) {
                this.git.updateSelfPullRequest(merged.number, { revertPullRequest: result.pullRequest.number });
                await this.alertUser(`↩️ Revert pull request #${result.pullRequest.number} is open. Merge it to roll back.`);
            } else {
                await this.alertUser(`❌ Could not open a revert pull request: ${result.error}`);
            }
        } catch (err) {
            console.error('[Monitor] Rollback exception:', err);
        }
    }

    _minutesAgo(iso) {
        return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    }

    /**
     * The newest self-improvement pull request that merged inside the
     * rollback window and has no revert yet, or null. Asks GitHub only about
     * recorded pull requests whose outcome is still unknown.
     * @returns {Promise<{number, mergedAt, mergeCommit}|null>}
     */
    async findRecentSelfMerge() {
        const recorded = this.git.listSelfPullRequests().slice(0, 10);
        for (const entry of recorded) {
            if (entry.revertPullRequest || entry.closedUnmerged) continue;
            let { mergedAt, mergeCommit } = entry;
            if (!mergedAt) {
                const pr = await this.git.getPullRequest(entry.number);
                if (pr.merged_at) {
                    mergedAt = pr.merged_at;
                    mergeCommit = pr.merge_commit_sha;
                    this.git.updateSelfPullRequest(entry.number, { mergedAt, mergeCommit });
                } else if (pr.state === 'closed') {
                    this.git.updateSelfPullRequest(entry.number, { closedUnmerged: true });
                    continue;
                } else {
                    continue;
                }
            }
            if (mergeCommit && Date.now() - Date.parse(mergedAt) < this.rollbackWindow) {
                return { number: entry.number, mergedAt, mergeCommit };
            }
        }
        return null;
    }

    async alertUser(message) {
        console.log(`[Monitor Alert] ${message}`);

        // Slack Webhook
        if (this.slackWebhookUrl) {
            try {
                await fetch(this.slackWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: message }),
                    signal: AbortSignal.timeout(this.fetchTimeout)
                });
            } catch (err) {
                console.error('[Monitor] Failed to send Slack alert:', err.message);
            }
        }
    }
}

module.exports = { Monitor };
