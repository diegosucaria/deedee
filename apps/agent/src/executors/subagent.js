const { BaseExecutor } = require('./base');

class SubAgentExecutor extends BaseExecutor {
    constructor(services) {
        super(services);
    }

    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const subAgentService = services.agent?.subAgentService;

        switch (name) {
            case 'spawnAgent': {
                if (!subAgentService) {
                    return { success: false, error: 'Sub-agent service not available.' };
                }

                // Depth guard: max 3 sub-agents deep
                const currentDepth = context?.message?.metadata?.subAgentDepth || 0;
                if (currentDepth >= 3) {
                    return {
                        success: false,
                        error: `Sub-agents cannot spawn deeper than 3 levels (current depth: ${currentDepth}).`
                    };
                }

                const { task, model, tools, timeoutMinutes, waitForResult } = args;
                if (!task) {
                    return { success: false, error: 'Missing required parameter: task' };
                }

                const parentChatId = context?.message?.metadata?.chatId || 'unknown';

                try {
                    const result = await subAgentService.spawn({
                        task,
                        model,
                        tools,
                        timeoutMinutes,
                        parentChatId,
                        waitForResult,
                        parentDepth: currentDepth,
                    });
                    return { success: true, ...result };
                } catch (err) {
                    return { success: false, error: err.message };
                }
            }

            case 'getAgentResult': {
                if (!subAgentService) {
                    return { success: false, error: 'Sub-agent service not available.' };
                }

                const { taskId } = args;
                if (!taskId) {
                    return { success: false, error: 'Missing required parameter: taskId' };
                }

                try {
                    const result = await subAgentService.getResult(taskId);
                    return { success: true, ...result };
                } catch (err) {
                    return { success: false, error: err.message };
                }
            }

            case 'listAgentTasks': {
                if (!subAgentService) {
                    return { success: false, error: 'Sub-agent service not available.' };
                }

                const parentChatId = context?.message?.metadata?.chatId;
                try {
                    const tasks = subAgentService.listTasks(parentChatId);
                    return { success: true, tasks, count: tasks.length };
                } catch (err) {
                    return { success: false, error: err.message };
                }
            }

            default:
                return null;
        }
    }
}

module.exports = { SubAgentExecutor };
