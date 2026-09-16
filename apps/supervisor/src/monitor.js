const fs = require('fs');
const path = require('path');

// Files in the supervisor-only state dir. The agent can write anywhere in
// the shared /app/source volume, so the trust anchors must not live there.
// Two anchors: BOOT_FILE is HEAD at the last supervisor start and only
// start() rewrites it. ASSESSED_FILE is the last HEAD the window rules ran
// on, from start or from a tick. Keeping them apart lets a supervisor restart
// on a deployed self-commit still open the window: HEAD differs from the
// boot anchor even when a tick already saw the commit.
const BOOT_FILE = '.last_boot_commit';
const ASSESSED_FILE = '.last_assessed_commit';
const ROLLBACK_FILE = '.last_rollback_commit';

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
        this.fetchTimeout = 10000;  // Every outbound fetch gives up after 10 s

        // Rollback policy. The window only opens for a commit the supervisor
        // itself authored (a self-improvement). Owner merges never roll back.
        this.autoRollback = (process.env.SUPERVISOR_AUTO_ROLLBACK || 'true') !== 'false';
        this.supervisorEmail = process.env.GIT_USER_EMAIL || 'supervisor@deedee.bot';
        this.selfCommit = null; // Hash of the self-commit the window protects

        // Supervisor-only state (boot hash, own rollback hash).
        this.stateDir = process.env.SUPERVISOR_STATE_DIR || '/app/state';
        this.lastAssessedHash = null; // HEAD at the last window assessment

        // State
        this.failures = 0;
        this.intervalId = null;
        this.lastUpdate = 0; // 0 = danger window closed. start() decides.
    }

    async start() {
        console.log('[Monitor] Starting health checks...');
        console.log(`[Monitor] Agent URL: ${this.agentUrl}`);
        console.log(`[Monitor] State dir: ${this.stateDir}`);
        if (this.slackWebhookUrl) console.log('[Monitor] Slack alerting enabled.');

        // Decide the rollback window before notifyStartup() rewrites .last_boot_commit
        await this.assessRollbackWindow();

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
        const raw = await this.git.runSafe('git', ['log', '-1', '--pretty=format:%H%x09%ae%x09%s']);
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

    _legacyBootFile() {
        return path.join(this.git.workDir, BOOT_FILE);
    }

    /**
     * Copy the boot file from the old place (the shared work dir) once, when
     * the new one is missing. Older installs keep their "no changes" notice.
     */
    _migrateBootFile() {
        const target = this._stateFile(BOOT_FILE);
        const legacy = this._legacyBootFile();
        if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.copyFileSync(legacy, target);
        console.log(`[Monitor] Moved ${BOOT_FILE} into ${this.stateDir}.`);
    }

    _readState(name) {
        try {
            if (name === BOOT_FILE) this._migrateBootFile();
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
    _readLastAssessedCommit() { return this._readState(ASSESSED_FILE); }
    _writeLastAssessedCommit(hash) { this._writeState(ASSESSED_FILE, hash); }
    _readLastRollbackCommit() { return this._readState(ROLLBACK_FILE); }
    _writeLastRollbackCommit(hash) { this._writeState(ROLLBACK_FILE, hash); }

    // ----- Rollback window -----

    /**
     * Open the danger window only when HEAD is new since the last boot AND the
     * supervisor wrote it AND it is not a revert. Any other start (reboot,
     * deploy of an owner merge, own rollback) keeps the window closed: we
     * still alert, we never roll back. Records HEAD in .last_assessed_commit.
     */
    async assessRollbackWindow(head = null) {
        this.lastUpdate = 0;
        this.selfCommit = null;

        if (!this.autoRollback) {
            console.log('[Monitor] Auto-rollback disabled (SUPERVISOR_AUTO_ROLLBACK=false). Window closed.');
            return;
        }

        try {
            const info = head || await this.readHead();
            if (!info) {
                console.warn('[Monitor] Could not read HEAD. Rollback window closed.');
                return;
            }
            this.lastAssessedHash = info.hash;
            this._writeLastAssessedCommit(info.hash);
            const short = info.hash.substring(0, 7);

            const reason = this._closedReason(info);
            if (reason) {
                console.log(`[Monitor] Rollback window closed: ${reason} (${short}).`);
                return;
            }

            this.lastUpdate = Date.now();
            this.selfCommit = info.hash;
            console.log(`[Monitor] HEAD ${short} is a new self-commit. Rollback window open for ${this.dangerWindow / 60000} min.`);
        } catch (err) {
            console.error('[Monitor] Rollback window check failed, keeping it closed:', err.message);
        }
    }

    /** Why the window must stay closed for this HEAD, or null to open it. */
    _closedReason({ hash, authorEmail, subject }) {
        if (hash === this._readLastBootCommit()) return 'HEAD unchanged since last boot';
        if (authorEmail.toLowerCase() !== this.supervisorEmail.toLowerCase()) return 'HEAD not authored by the supervisor';
        if (hash === this._readLastRollbackCommit()) return 'HEAD is the supervisor\'s own rollback';
        if (subject.startsWith('Revert "')) return 'HEAD is a revert commit';
        return null;
    }

    /**
     * Balena restarts only the services whose image changed, so an agent-only
     * self-improvement never restarts the supervisor. Re-run the window rules
     * whenever HEAD moved since the last assessment. This path never touches
     * .last_boot_commit: when Balena later restarts the supervisor on that
     * same commit, start() must still see it as new and open the window.
     */
    async _reassessIfHeadMoved() {
        if (!this.autoRollback) return;
        try {
            const head = await this.readHead();
            if (!head || head.hash === this.lastAssessedHash) return;

            const short = head.hash.substring(0, 7);
            console.log(`[Monitor] HEAD moved to ${short} since the last check. Reassessing rollback window.`);
            const isNew = head.hash !== this._readLastAssessedCommit();
            await this.assessRollbackWindow(head);
            if (!isNew) return;

            await this.alertUser(`🔁 *Deedee Updated*\n*Commit:* ${head.subject}\n*Hash:* \`${short}\``);
        } catch (err) {
            console.warn('[Monitor] HEAD re-check failed:', err.message);
        }
    }

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
        await this._reassessIfHeadMoved();
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
                    'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN || 'test-token'}`
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

        // Tier 2: Auto-Rollback (self-commits only, inside the danger window)
        if (this.failures < this.rollbackThreshold) return;
        if (!this.autoRollback) {
            console.warn('[Monitor] Rollback threshold reached but auto-rollback is disabled. Alert only.');
            return;
        }
        const timeSinceUpdate = Date.now() - this.lastUpdate;
        if (!this.lastUpdate || !this.selfCommit || timeSinceUpdate >= this.dangerWindow) {
            if (this.failures === this.rollbackThreshold) {
                console.warn('[Monitor] Rollback threshold reached outside the danger window. Alert only, no rollback.');
            }
            return;
        }

        // Never revert our own revert: that would re-apply the bad commit.
        const lastRollback = this._readLastRollbackCommit();
        if (lastRollback && this.selfCommit === lastRollback) {
            console.warn('[Monitor] HEAD is the supervisor\'s own rollback commit. Not reverting it again.');
            this.lastUpdate = 0;
            this.selfCommit = null;
            return;
        }

        console.warn('[Monitor] Rollback threshold reached inside danger window. Initiating rollback...');
        await this.alertUser(`🔄 **Auto-Rollback Triggered**\nAgent crashed repeatedly after a self-update. Rolling back changes...`);

        try {
            // Only revert the self-commit recorded at start. GitOps re-checks HEAD.
            const result = await this.git.rollback({ expectedHead: this.selfCommit });
            if (result.success) {
                if (result.revertCommit) this._writeLastRollbackCommit(result.revertCommit);
                await this.alertUser(`✅ Rollback successful. Waiting for restart...`);
                // Reset failures to give it time to restart
                this.failures = 0;
            } else {
                await this.alertUser(`❌ Rollback failed: ${result.error}`);
            }
        } catch (err) {
            console.error('[Monitor] Rollback exception:', err);
        }
        // Close the danger window for this run, whatever the outcome.
        this.lastUpdate = 0;
        this.selfCommit = null;
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
