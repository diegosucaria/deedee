const { SubAgentExecutor } = require('../src/executors/subagent');

describe('SubAgentExecutor', () => {
    let executor;
    let mockSubAgentService;

    beforeEach(() => {
        mockSubAgentService = {
            spawn: jest.fn(),
            getResult: jest.fn(),
            listTasks: jest.fn(),
        };

        executor = new SubAgentExecutor({
            agent: {
                subAgentService: mockSubAgentService,
            },
        });
    });

    describe('spawnAgent', () => {
        it('should spawn a sub-agent with valid params', async () => {
            mockSubAgentService.spawn.mockResolvedValue({
                taskId: 'sub-abc123',
                status: 'running',
            });

            const result = await executor.execute('spawnAgent', {
                task: 'Search for flights to Rome',
                model: 'FLASH',
            }, { message: { metadata: { chatId: 'chat-1' } } });

            expect(result.success).toBe(true);
            expect(result.taskId).toBe('sub-abc123');
            expect(mockSubAgentService.spawn).toHaveBeenCalledWith(expect.objectContaining({
                task: 'Search for flights to Rome',
                model: 'FLASH',
                parentChatId: 'chat-1',
            }));
        });

        it('should reject if task param is missing', async () => {
            const result = await executor.execute('spawnAgent', {}, {
                message: { metadata: { chatId: 'chat-1' } },
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Missing required parameter');
        });

        it('should enforce depth guard for sub-agents', async () => {
            const result = await executor.execute('spawnAgent', {
                task: 'Nested task',
            }, {
                message: { metadata: { chatId: 'subagent-x', isSubAgent: true } },
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('max depth');
            expect(mockSubAgentService.spawn).not.toHaveBeenCalled();
        });

        it('should handle service errors', async () => {
            mockSubAgentService.spawn.mockRejectedValue(new Error('Max concurrent'));

            const result = await executor.execute('spawnAgent', {
                task: 'Overflow task',
            }, { message: { metadata: { chatId: 'chat-1' } } });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Max concurrent');
        });
    });

    describe('getAgentResult', () => {
        it('should return result for valid taskId', async () => {
            mockSubAgentService.getResult.mockResolvedValue({
                taskId: 'sub-abc',
                status: 'completed',
                result: 'Flight found',
            });

            const result = await executor.execute('getAgentResult', {
                taskId: 'sub-abc',
            }, {});

            expect(result.success).toBe(true);
            expect(result.result).toBe('Flight found');
        });

        it('should reject if taskId is missing', async () => {
            const result = await executor.execute('getAgentResult', {}, {});
            expect(result.success).toBe(false);
            expect(result.error).toContain('Missing required parameter');
        });
    });

    describe('listAgentTasks', () => {
        it('should list tasks for current session', async () => {
            mockSubAgentService.listTasks.mockReturnValue([
                { taskId: 't1', task: 'Research', status: 'completed' },
            ]);

            const result = await executor.execute('listAgentTasks', {}, {
                message: { metadata: { chatId: 'chat-1' } },
            });

            expect(result.success).toBe(true);
            expect(result.tasks).toHaveLength(1);
            expect(result.count).toBe(1);
        });
    });

    describe('unknown tools', () => {
        it('should return null for unhandled tool names', async () => {
            const result = await executor.execute('unknownTool', {}, {});
            expect(result).toBeNull();
        });
    });

    describe('missing service', () => {
        it('should return error if sub-agent service is not available', async () => {
            const bareExecutor = new SubAgentExecutor({ agent: {} });

            const result1 = await bareExecutor.execute('spawnAgent', { task: 'x' }, {});
            expect(result1.success).toBe(false);

            const result2 = await bareExecutor.execute('getAgentResult', { taskId: 'x' }, {});
            expect(result2.success).toBe(false);

            const result3 = await bareExecutor.execute('listAgentTasks', {}, {});
            expect(result3.success).toBe(false);
        });
    });
});
