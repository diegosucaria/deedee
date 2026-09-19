const { BaseExecutor } = require('./base');
const { toolDefinitions } = require('../tools-definition');
const { checkToolList } = require('../services/tool-groups');

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

                const { task, model, tools, timeoutMinutes, waitForResult, lightweight } = args;
                if (!task) {
                    return { success: false, error: 'Missing required parameter: task' };
                }

                const parentChatId = context?.message?.metadata?.chatId || 'unknown';
                const parentSource = context?.message?.source || null;

                // The child's tool list. A list is enforced when a call runs,
                // so a list that matches nothing would leave the child unable
                // to do anything: check it before anything runs.
                let childTools = tools;
                let ignoredTools = [];
                if (Array.isArray(tools) && tools.length > 0) {
                    let mcpTools = [];
                    try { mcpTools = (await services.agent?.mcp?.getTools?.()) || []; } catch (e) { mcpTools = []; }
                    const internal = toolDefinitions.flatMap(td => td.functionDeclarations || []);
                    const checked = checkToolList(tools, internal, mcpTools);
                    if (checked.tools.length === 0) {
                        return {
                            success: false,
                            error: `None of the tools you listed exist: ${checked.unknown.join(', ') || '(empty list)'}. Use exact tool names, or "server:<name>" for every tool of an MCP server${checked.servers.length ? ` (servers: ${checked.servers.join(', ')})` : ''}. Nothing was started.`
                        };
                    }
                    if (checked.unknown.length > 0) console.warn(`[SubAgent] Ignoring unknown tools in spawnAgent: ${checked.unknown.join(', ')}`);
                    childTools = checked.tools;
                    ignoredTools = checked.unknown;
                } else {
                    // No list given. A parent that has a list of its own must
                    // not widen its child by saying nothing: the child gets
                    // the parent's list. (A parent may still NAME tools it
                    // does not hold; the system jobs fan out that way.)
                    const pMeta = context?.message?.metadata || {};
                    const parentListed = Array.isArray(pMeta.allowedTools) && pMeta.allowedTools.length > 0
                        && (parentSource === 'scheduler' || pMeta.isSubAgent);
                    childTools = parentListed ? pMeta.allowedTools.filter(t => t !== 'spawnAgent') : undefined;
                }

                try {
                    const result = await subAgentService.spawn({
                        task,
                        model,
                        tools: childTools,
                        timeoutMinutes,
                        parentChatId,
                        parentSource,
                        waitForResult,
                        parentDepth: currentDepth,
                        lightweight,
                        untrustedTaint: Array.isArray(context?.untrustedTaint) ? context.untrustedTaint : [],
                        approvalRunId: context?.approvalRunId || null,
                    });
                    return { success: true, ...result, ...(ignoredTools && ignoredTools.length ? { ignoredTools, note: `These listed tools do not exist and were left out: ${ignoredTools.join(', ')}.` } : {}) };
                } catch (err) {
                    return { success: false, error: err.message };
                }
            }

            case 'getAgentResult': {
                if (!subAgentService) {
                    return { success: false, error: 'Sub-agent service not available.' };
                }

                const { taskId, full } = args;
                if (!taskId) {
                    return { success: false, error: 'Missing required parameter: taskId' };
                }

                try {
                    const result = await subAgentService.getResult(taskId, { full: full === true });
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
