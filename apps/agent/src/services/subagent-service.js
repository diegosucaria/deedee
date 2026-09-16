const crypto = require('crypto');
const { ConfigService } = require('./config-service');

const MODEL_CLASSES = ['LITE', 'FLASH', 'PRO'];

// Tool loops per sub-agent run. Browser work and PRO runs need more steps;
// the agent's own escalation (MAX_TOOL_LOOPS_BROWSER) still applies once a
// browser tool is called. SUBAGENT_MAX_TOOL_LOOPS and
// SUBAGENT_MAX_TOOL_LOOPS_BROWSER override the defaults.
const DEFAULT_MAX_TOOL_LOOPS = 20;
const DEFAULT_MAX_TOOL_LOOPS_BROWSER = 50;

function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

// A result longer than this is compressed by LITE; the full text stays in
// subagents.result_full. 0 disables the cap.
const DEFAULT_RESULT_CAP = 4000;
const SUMMARY_TARGET = 3500;

class SubAgentService {
    constructor(agent) {
        this.agent = agent;
        this.running = new Map(); // taskId → { promise, controller, replies }
        this.MAX_CONCURRENT = 10;
        this.MAX_TIMEOUT_MINUTES = 10;
        this.DEFAULT_TIMEOUT_MINUTES = 6;
        this._config = new ConfigService();
    }

    /**
     * Model class for a run: the caller's choice, else LITE for lightweight
     * scans (SUBAGENT_LIGHTWEIGHT_MODEL, set FLASH to roll back), else FLASH.
     */
    resolveModel(model, lightweight) {
        const asked = typeof model === 'string' ? model.trim().toUpperCase() : '';
        if (MODEL_CLASSES.includes(asked)) return asked;
        if (lightweight) {
            const env = (process.env.SUBAGENT_LIGHTWEIGHT_MODEL || 'LITE').trim().toUpperCase();
            return MODEL_CLASSES.includes(env) ? env : 'LITE';
        }
        return 'FLASH';
    }

    /**
     * Loop cap for a run: the browser cap (50) when the allowlist names
     * browser tools or the run is PRO (asked for heavy work), else 20.
     */
    resolveMaxToolLoops(tools, model) {
        const list = Array.isArray(tools) ? tools : [];
        const browser = list.some(t => typeof t === 'string' && (t.startsWith('browser_') || t === 'server:browser'));
        const heavy = browser || model === 'PRO';
        return heavy
            ? envInt('SUBAGENT_MAX_TOOL_LOOPS_BROWSER', DEFAULT_MAX_TOOL_LOOPS_BROWSER)
            : envInt('SUBAGENT_MAX_TOOL_LOOPS', DEFAULT_MAX_TOOL_LOOPS);
    }

    resultCap() {
        const raw = process.env.SUBAGENT_RESULT_CAP;
        if (raw === undefined || raw === '') return DEFAULT_RESULT_CAP;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESULT_CAP;
    }

    /**
     * Compress a long result with LITE. Falls back to a hard cut when the
     * model call fails. Returns { result, summarized }.
     */
    async compressResult(taskId, full) {
        const cap = this.resultCap();
        if (!cap || full.length <= cap) return { result: full, summarized: false };

        const note = (text) => `${text}\n\n[Result trimmed from ${full.length} chars. Call getAgentResult("${taskId}", full: true) for the whole text.]`;
        const modelName = this.agent.configService?.getModel?.('LITE') || this._config.getModel('LITE');
        try {
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts: [{ text: `Compress this report to under ${SUMMARY_TARGET} characters. Keep every identifier, date, amount, URL and the [SILENT] marker verbatim.\n\n${full}` }] }],
                config: { thinkingConfig: { thinkingLevel: 'MINIMAL' } }
            });
            this._config.logUsageFromResponse(this.agent.db, modelName, response, `subagent-${taskId}`, 'subagent_summary');
            const text = (typeof response.text === 'string' ? response.text
                : response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim();
            if (text) {
                console.log(`[SubAgent] ${taskId} result compressed ${full.length} -> ${text.length} chars.`);
                return { result: note(text), summarized: true };
            }
        } catch (err) {
            console.warn(`[SubAgent] ${taskId} result summary failed, cutting at ${cap}:`, err.message);
        }
        return { result: note(full.slice(0, cap)), summarized: true };
    }

    /**
     * Spawn a sub-agent to perform a specific task.
     * @returns {string|object} taskId (async) or { taskId, result } (blocking)
     */
    async spawn({ task, model, tools, timeoutMinutes, parentChatId, parentSource = null, waitForResult = true, parentDepth = 0, lightweight = false }) {
        // Concurrent limit
        if (this.running.size >= this.MAX_CONCURRENT) {
            throw new Error(`Max concurrent sub-agents reached (${this.MAX_CONCURRENT}). Wait for existing tasks to complete.`);
        }

        const taskId = `sub-${crypto.randomUUID().slice(0, 8)}`;
        const chatId = `subagent-${taskId}`;
        const timeout = Math.min(timeoutMinutes || this.DEFAULT_TIMEOUT_MINUTES, this.MAX_TIMEOUT_MINUTES);
        const selectedModel = this.resolveModel(model, lightweight);
        const maxToolLoops = this.resolveMaxToolLoops(tools, selectedModel);

        // Create isolated session
        this.agent.db.ensureSession(chatId, 'subagent');

        // Record in DB
        const createdAt = new Date().toISOString();
        this.agent.db.createSubAgent({
            id: taskId,
            parentChatId,
            task: task.slice(0, 500),
            model: selectedModel,
            createdAt
        });

        console.log(`[SubAgent] Spawning ${taskId}: "${task.slice(0, 80)}..." (model=${selectedModel}, timeout=${timeout}m, loops=${maxToolLoops}, wait=${!!waitForResult})`);

        // Build sub-agent message
        const message = {
            role: 'user',
            content: task,
            source: 'subagent',
            metadata: {
                chatId,
                parentChatId,
                parentSource,
                taskId,
                isSubAgent: true,
                allowedTools: tools || null,
                forceModel: selectedModel,
                subAgentDepth: parentDepth + 1,
                lightweight: !!lightweight,
                maxToolLoops
            }
        };

        // Collect replies silently
        const replies = [];
        const sendCallback = async (reply) => {
            if (reply.content) {
                replies.push(reply.content);
            }
        };

        // Timeout via AbortController. The race below only stops the wait;
        // abortChat tells the agent to leave its tool loop for this chat.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout * 60 * 1000);

        const promise = (async () => {
            try {
                await Promise.race([
                    this.agent.processMessage(message, sendCallback),
                    new Promise((_, reject) => {
                        controller.signal.addEventListener('abort', () =>
                            reject(new Error('TIMEOUT'))
                        );
                    })
                ]);

                const full = replies.join('\n').trim() || 'Task completed (no text output).';
                const { result, summarized } = await this.compressResult(taskId, full);
                const completedAt = new Date().toISOString();
                this.agent.db.updateSubAgent(taskId, {
                    status: 'completed',
                    result,
                    ...(summarized ? { resultFull: full } : {}),
                    completedAt
                });
                console.log(`[SubAgent] ${taskId} completed. Result length: ${result.length}${summarized ? ` (full ${full.length})` : ''}`);
                this._broadcast(taskId, 'completed');
                return result;
            } catch (err) {
                const isTimeout = err.message === 'TIMEOUT';
                if (isTimeout && typeof this.agent.abortChat === 'function') {
                    this.agent.abortChat(chatId);
                }
                const partial = replies.join('\n').trim();
                const status = isTimeout ? 'timeout' : 'failed';
                const error = isTimeout ? `Timed out after ${timeout} minutes` : err.message;
                const completedAt = new Date().toISOString();

                this.agent.db.updateSubAgent(taskId, {
                    status,
                    result: partial || null,
                    error,
                    completedAt
                });
                console.error(`[SubAgent] ${taskId} ${status}: ${error}`);
                if (this.agent.notifications) {
                    this.agent.notifications.create({
                        type: 'subagent_failed',
                        severity: isTimeout ? 'warning' : 'error',
                        title: `Sub-agent ${isTimeout ? 'timed out' : 'failed'}: ${taskId}`,
                        message: error,
                        metadata: { taskId, status, error, link: '/system/history' }
                    });
                }
                this._broadcast(taskId, status);
                return partial || error;
            } finally {
                clearTimeout(timer);
                this.running.delete(taskId);
            }
        })();

        this.running.set(taskId, { promise, controller, replies });

        if (waitForResult) {
            const result = await promise;
            return { taskId, status: 'completed', result };
        }

        return { taskId, status: 'running', info: `Sub-agent spawned. Use getAgentResult("${taskId}") to check status.` };
    }

    /**
     * Get the result of a spawned sub-agent.
     */
    async getResult(taskId, { full = false } = {}) {
        // Check in-memory first (still running)
        const running = this.running.get(taskId);
        if (running) {
            return { taskId, status: 'running', partial: running.replies.join('\n').trim() };
        }

        // Check DB
        const record = this.agent.db.getSubAgent(taskId);
        if (!record) {
            return { taskId, status: 'not_found', error: `No sub-agent with ID "${taskId}" found.` };
        }

        return {
            taskId: record.id,
            status: record.status,
            result: full && record.result_full ? record.result_full : record.result,
            ...(record.result_full ? { hasFullResult: true } : {}),
            error: record.error,
            model: record.model,
            task: record.task,
            createdAt: record.created_at,
            completedAt: record.completed_at,
        };
    }

    /**
     * List all sub-agent tasks.
     */
    listTasks(parentChatId) {
        const { tasks: records } = this.agent.db.listSubAgents(parentChatId);
        return records.map(r => ({
            taskId: r.id,
            task: r.task,
            status: r.status,
            model: r.model,
            createdAt: r.created_at,
            completedAt: r.completed_at,
            hasResult: !!r.result,
        }));
    }

    /**
     * Cleanup completed sub-agent sessions older than 24h.
     */
    cleanup() {
        return this.agent.db.cleanupSubAgents();
    }

    /**
     * Broadcast sub-agent status change to connected clients.
     */
    _broadcast(taskId, status) {
        try {
            if (this.agent.interface?.broadcast) {
                this.agent.interface.broadcast('subagent:update', { taskId, status });
            }
        } catch (e) {
            // Non-critical; suppress broadcast errors
        }
    }
}

module.exports = { SubAgentService };
