const { SubAgentService } = require('../src/services/subagent-service');

describe('SubAgentService', () => {
    let service;
    let mockAgent;

    beforeEach(() => {
        mockAgent = {
            db: {
                ensureSession: jest.fn(),
                createSubAgent: jest.fn(),
                updateSubAgent: jest.fn(),
                getSubAgent: jest.fn(),
                listSubAgents: jest.fn().mockReturnValue([]),
                cleanupSubAgents: jest.fn().mockReturnValue({ cleaned: 0 }),
                deleteSession: jest.fn(),
            },
            processMessage: jest.fn().mockResolvedValue({}),
        };
        service = new SubAgentService(mockAgent);
    });

    afterEach(() => {
        // Clean up any timers/running tasks
        for (const [id, task] of service.running) {
            task.controller.abort();
        }
        service.running.clear();
    });

    describe('spawn()', () => {
        it('should spawn a sub-agent with defaults', async () => {
            // processMessage should call the sendCallback with a reply
            mockAgent.processMessage.mockImplementation(async (msg, callback) => {
                await callback({ content: 'Task done!' });
                return {};
            });

            const result = await service.spawn({
                task: 'Research flights',
                parentChatId: 'chat-123',
                waitForResult: true,
            });

            expect(result.taskId).toBeDefined();
            expect(result.status).toBe('completed');
            expect(result.result).toBe('Task done!');

            // Verify DB calls
            expect(mockAgent.db.ensureSession).toHaveBeenCalled();
            expect(mockAgent.db.createSubAgent).toHaveBeenCalledWith(expect.objectContaining({
                parentChatId: 'chat-123',
                task: 'Research flights',
                model: 'FLASH',
            }));
            expect(mockAgent.db.updateSubAgent).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ status: 'completed', result: 'Task done!' })
            );
        });

        it('should return taskId in async mode (waitForResult=false)', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, callback) => {
                await callback({ content: 'Done' });
                return {};
            });

            const result = await service.spawn({
                task: 'Check calendar',
                parentChatId: 'chat-123',
                waitForResult: false,
            });

            expect(result.taskId).toBeDefined();
            expect(result.status).toBe('running');
            expect(result.info).toContain('getAgentResult');
        });

        it('should enforce concurrent limit', async () => {
            // Fill up the running map
            for (let i = 0; i < 10; i++) {
                service.running.set(`task-${i}`, {
                    promise: new Promise(() => { }),
                    controller: new AbortController(),
                    replies: [],
                });
            }

            await expect(
                service.spawn({ task: 'One more', parentChatId: 'chat-123', waitForResult: true })
            ).rejects.toThrow('Max concurrent sub-agents reached');
        });

        it('should pass isSubAgent metadata to processMessage', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, cb) => {
                await cb({ content: 'ok' });
                return {};
            });

            await service.spawn({
                task: 'Do something',
                parentChatId: 'chat-123',
                model: 'PRO',
                tools: ['googleSearch', 'rememberFact'],
                waitForResult: true,
            });

            const calledMsg = mockAgent.processMessage.mock.calls[0][0];
            expect(calledMsg.metadata.isSubAgent).toBe(true);
            expect(calledMsg.metadata.modelOverride).toBe('PRO');
            expect(calledMsg.metadata.allowedTools).toEqual(['googleSearch', 'rememberFact']);
            expect(calledMsg.source).toBe('subagent');
        });

        it('should clamp timeout to MAX_TIMEOUT_MINUTES', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, cb) => {
                await cb({ content: 'fast' });
                return {};
            });

            // Even if we pass 999 minutes, the service should clamp it
            const result = await service.spawn({
                task: 'Long task',
                parentChatId: 'chat-123',
                timeoutMinutes: 999,
                waitForResult: true,
            });

            expect(result.status).toBe('completed');
        });

        it('should handle processMessage errors gracefully', async () => {
            mockAgent.processMessage.mockRejectedValue(new Error('Model unavailable'));

            const result = await service.spawn({
                task: 'Broken task',
                parentChatId: 'chat-123',
                waitForResult: true,
            });

            expect(result.status).toBe('completed');
            // The error is caught internally and stored
            expect(mockAgent.db.updateSubAgent).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ status: 'failed' })
            );
        });

        it('should collect multiple replies', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, cb) => {
                await cb({ content: 'Part 1' });
                await cb({ content: 'Part 2' });
                await cb({ content: 'Part 3' });
                return {};
            });

            const result = await service.spawn({
                task: 'Multi-reply task',
                parentChatId: 'c-1',
                waitForResult: true,
            });

            expect(result.result).toBe('Part 1\nPart 2\nPart 3');
        });

        it('should create session with subagent- prefix chatId', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, cb) => {
                await cb({ content: 'ok' });
                return {};
            });

            const result = await service.spawn({
                task: 'Test session',
                parentChatId: 'chat-123',
                waitForResult: true,
            });

            const chatId = mockAgent.db.ensureSession.mock.calls[0][0];
            expect(chatId).toMatch(/^subagent-sub-/);

            const calledMsg = mockAgent.processMessage.mock.calls[0][0];
            expect(calledMsg.metadata.chatId).toBe(chatId);
        });
    });

    describe('getResult()', () => {
        it('should return running status for in-progress tasks', async () => {
            service.running.set('task-1', {
                promise: new Promise(() => { }),
                controller: new AbortController(),
                replies: ['partial output'],
            });

            const result = await service.getResult('task-1');
            expect(result.status).toBe('running');
            expect(result.partial).toBe('partial output');
        });

        it('should return not_found for unknown tasks', async () => {
            mockAgent.db.getSubAgent.mockReturnValue(null);
            const result = await service.getResult('nonexistent');
            expect(result.status).toBe('not_found');
        });

        it('should return completed result from DB', async () => {
            mockAgent.db.getSubAgent.mockReturnValue({
                id: 'task-1',
                status: 'completed',
                result: 'Final answer',
                model: 'FLASH',
                task: 'Do something',
                created_at: '2026-01-01',
                completed_at: '2026-01-01',
            });

            const result = await service.getResult('task-1');
            expect(result.status).toBe('completed');
            expect(result.result).toBe('Final answer');
        });
    });

    describe('listTasks()', () => {
        it('should return formatted task list', () => {
            mockAgent.db.listSubAgents.mockReturnValue([
                { id: 't1', task: 'Research', status: 'completed', model: 'FLASH', created_at: '2026-01-01', completed_at: '2026-01-01', result: 'done' },
                { id: 't2', task: 'Calendar', status: 'running', model: 'PRO', created_at: '2026-01-01', completed_at: null, result: null },
            ]);

            const tasks = service.listTasks('chat-123');
            expect(tasks).toHaveLength(2);
            expect(tasks[0].hasResult).toBe(true);
            expect(tasks[1].hasResult).toBe(false);
        });
    });

    describe('cleanup()', () => {
        it('should delegate to db.cleanupSubAgents', () => {
            mockAgent.db.cleanupSubAgents.mockReturnValue({ cleaned: 5 });
            const result = service.cleanup();
            expect(result).toEqual({ cleaned: 5 });
        });
    });
});
