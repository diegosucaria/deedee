const crypto = require('crypto');

class SubAgentService {
    constructor(agent) {
        this.agent = agent;
        this.running = new Map(); // taskId → { promise, controller, replies }
        this.MAX_CONCURRENT = 3;
        this.MAX_TIMEOUT_MINUTES = 10;
        this.DEFAULT_TIMEOUT_MINUTES = 3;
    }

    /**
     * Spawn a sub-agent to perform a specific task.
     * @returns {string|object} taskId (async) or { taskId, result } (blocking)
     */
    async spawn({ task, model, tools, timeoutMinutes, parentChatId, waitForResult }) {
        // Concurrent limit
        if (this.running.size >= this.MAX_CONCURRENT) {
            throw new Error(`Max concurrent sub-agents reached (${this.MAX_CONCURRENT}). Wait for existing tasks to complete.`);
        }

        const taskId = `sub-${crypto.randomUUID().slice(0, 8)}`;
        const chatId = `subagent-${taskId}`;
        const timeout = Math.min(timeoutMinutes || this.DEFAULT_TIMEOUT_MINUTES, this.MAX_TIMEOUT_MINUTES);
        const selectedModel = model || 'FLASH';

        // Create isolated session
        this.agent.db.ensureSession(chatId, 'subagent');

        // Record in DB
        this.agent.db.createSubAgent({
            id: taskId,
            parentChatId,
            task: task.slice(0, 500),
            model: selectedModel,
        });

        console.log(`[SubAgent] Spawning ${taskId}: "${task.slice(0, 80)}..." (model=${selectedModel}, timeout=${timeout}m, wait=${!!waitForResult})`);

        // Build sub-agent message
        const message = {
            role: 'user',
            content: task,
            source: 'subagent',
            metadata: {
                chatId,
                parentChatId,
                taskId,
                isSubAgent: true,
                allowedTools: tools || null,
                modelOverride: selectedModel,
            }
        };

        // Collect replies silently
        const replies = [];
        const sendCallback = async (reply) => {
            if (reply.content) {
                replies.push(reply.content);
            }
        };

        // Timeout via AbortController
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

                const result = replies.join('\n').trim() || 'Task completed (no text output).';
                this.agent.db.updateSubAgent(taskId, { status: 'completed', result });
                console.log(`[SubAgent] ${taskId} completed. Result length: ${result.length}`);
                this._broadcast(taskId, 'completed');
                return result;
            } catch (err) {
                const isTimeout = err.message === 'TIMEOUT';
                const partial = replies.join('\n').trim();
                const status = isTimeout ? 'timeout' : 'failed';
                const error = isTimeout ? `Timed out after ${timeout} minutes` : err.message;

                this.agent.db.updateSubAgent(taskId, {
                    status,
                    result: partial || null,
                    error,
                });
                console.error(`[SubAgent] ${taskId} ${status}: ${error}`);
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
    async getResult(taskId) {
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
            result: record.result,
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
        const records = this.agent.db.listSubAgents(parentChatId);
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
