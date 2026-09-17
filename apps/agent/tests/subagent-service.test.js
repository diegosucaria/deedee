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
                listSubAgents: jest.fn().mockReturnValue({ tasks: [], total: 0, page: 1, limit: 50 }),
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

        it("carries the parent's approval run id into the sub-agent message", async () => {
            await service.spawn({ task: 'x', parentChatId: 'chat-1', waitForResult: true, approvalRunId: 'run-parent' });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.approvalRunId).toBe('run-parent');
            mockAgent.processMessage.mockClear();
            await service.spawn({ task: 'y', parentChatId: 'chat-1', waitForResult: true });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.approvalRunId).toBeUndefined();
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
            expect(calledMsg.metadata.forceModel).toBe('PRO');
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

        it('should abort the agent run on timeout', async () => {
            const aborted = new Set();
            mockAgent.abortChat = jest.fn((chatId) => aborted.add(chatId));
            mockAgent.notifications = { create: jest.fn() };
            let loopDone;
            const loopFinished = new Promise(resolve => { loopDone = resolve; });
            // A run that keeps looping until the agent aborts its chat.
            mockAgent.processMessage.mockImplementation(async (msg) => {
                while (!aborted.has(msg.metadata.chatId)) {
                    await new Promise(r => setTimeout(r, 5));
                }
                loopDone();
                return {};
            });

            const result = await service.spawn({
                task: 'Never ends',
                parentChatId: 'chat-123',
                timeoutMinutes: 0.0005, // 30 ms
                waitForResult: true,
            });

            expect(mockAgent.abortChat).toHaveBeenCalledWith(`subagent-${result.taskId}`);
            expect(mockAgent.db.updateSubAgent).toHaveBeenCalledWith(
                result.taskId,
                expect.objectContaining({ status: 'timeout' })
            );
            // The loop really stopped.
            await expect(Promise.race([
                loopFinished.then(() => 'stopped'),
                new Promise(r => setTimeout(() => r('still running'), 500)),
            ])).resolves.toBe('stopped');
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
            mockAgent.db.listSubAgents.mockReturnValue({ tasks: [
                { id: 't1', task: 'Research', status: 'completed', model: 'FLASH', created_at: '2026-01-01', completed_at: '2026-01-01', result: 'done' },
                { id: 't2', task: 'Calendar', status: 'running', model: 'PRO', created_at: '2026-01-01', completed_at: null, result: null },
            ], total: 2, page: 1, limit: 50 });

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
    describe('model class', () => {
        let savedEnv;
        beforeEach(() => {
            savedEnv = process.env.SUBAGENT_LIGHTWEIGHT_MODEL;
            delete process.env.SUBAGENT_LIGHTWEIGHT_MODEL;
            mockAgent.processMessage.mockImplementation(async (msg, cb) => { await cb({ content: 'ok' }); return {}; });
        });
        afterEach(() => {
            if (savedEnv === undefined) delete process.env.SUBAGENT_LIGHTWEIGHT_MODEL;
            else process.env.SUBAGENT_LIGHTWEIGHT_MODEL = savedEnv;
        });

        it('lightweight with no model runs on LITE', async () => {
            await service.spawn({ task: 'scan', parentChatId: 'c', lightweight: true });
            const msg = mockAgent.processMessage.mock.calls[0][0];
            expect(msg.metadata.forceModel).toBe('LITE');
            expect(msg.metadata.lightweight).toBe(true);
            expect(mockAgent.db.createSubAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'LITE' }));
        });

        it('an explicit model beats the lightweight default', async () => {
            await service.spawn({ task: 'scan', parentChatId: 'c', lightweight: true, model: 'flash' });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.forceModel).toBe('FLASH');
        });

        it('SUBAGENT_LIGHTWEIGHT_MODEL=FLASH rolls the lightweight default back', async () => {
            process.env.SUBAGENT_LIGHTWEIGHT_MODEL = 'FLASH';
            await service.spawn({ task: 'scan', parentChatId: 'c', lightweight: true });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.forceModel).toBe('FLASH');
        });

        it('defaults to FLASH otherwise, PRO only on request, unknown names fall back', async () => {
            expect(service.resolveModel(undefined, false)).toBe('FLASH');
            expect(service.resolveModel('PRO', true)).toBe('PRO');
            expect(service.resolveModel('gpt-9', false)).toBe('FLASH');
            expect(service.resolveModel('gpt-9', true)).toBe('LITE');
        });
    });

    describe('tool loop cap', () => {
        let savedLoops, savedBrowser;
        beforeEach(() => {
            savedLoops = process.env.SUBAGENT_MAX_TOOL_LOOPS;
            savedBrowser = process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER;
            delete process.env.SUBAGENT_MAX_TOOL_LOOPS;
            delete process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER;
            mockAgent.processMessage.mockImplementation(async (msg, cb) => { await cb({ content: 'ok' }); return {}; });
        });
        afterEach(() => {
            if (savedLoops === undefined) delete process.env.SUBAGENT_MAX_TOOL_LOOPS; else process.env.SUBAGENT_MAX_TOOL_LOOPS = savedLoops;
            if (savedBrowser === undefined) delete process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER; else process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER = savedBrowser;
        });

        it('passes maxToolLoops 20 by default', async () => {
            await service.spawn({ task: 'x', parentChatId: 'c', tools: ['searchMemory'] });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.maxToolLoops).toBe(20);
        });

        it('passes 50 when browser tools are allowed', async () => {
            await service.spawn({ task: 'x', parentChatId: 'c', tools: ['browser_navigate', 'browser_click'] });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.maxToolLoops).toBe(50);
            expect(service.resolveMaxToolLoops(['server:browser'])).toBe(50);
            expect(service.resolveMaxToolLoops(null)).toBe(20);
        });

        it('a PRO run gets the higher cap even without browser tools', async () => {
            await service.spawn({ task: 'refactor', parentChatId: 'c', model: 'PRO', tools: ['readFile', 'writeFile', 'runShellCommand'] });
            expect(mockAgent.processMessage.mock.calls[0][0].metadata.maxToolLoops).toBe(50);
            expect(service.resolveMaxToolLoops(['readFile'], 'FLASH')).toBe(20);
        });

        it('SUBAGENT_MAX_TOOL_LOOPS and _BROWSER override the defaults; bad values fall back', () => {
            process.env.SUBAGENT_MAX_TOOL_LOOPS = '40';
            process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER = '80';
            expect(service.resolveMaxToolLoops(['searchMemory'])).toBe(40);
            expect(service.resolveMaxToolLoops(['browser_click'])).toBe(80);
            expect(service.resolveMaxToolLoops(null, 'PRO')).toBe(80);
            process.env.SUBAGENT_MAX_TOOL_LOOPS = '0';
            process.env.SUBAGENT_MAX_TOOL_LOOPS_BROWSER = 'many';
            expect(service.resolveMaxToolLoops(['searchMemory'])).toBe(20);
            expect(service.resolveMaxToolLoops(['browser_click'])).toBe(50);
        });
    });

    describe('result cap', () => {
        let savedEnv;
        const longText = ('ID-7781 due 2026-10-01 amount 42.50 https://example.test/x ' + 'lorem '.repeat(1500)).trim();

        beforeEach(() => {
            savedEnv = process.env.SUBAGENT_RESULT_CAP;
            delete process.env.SUBAGENT_RESULT_CAP;
            mockAgent.client = { models: { generateContent: jest.fn().mockResolvedValue({
                text: 'ID-7781 due 2026-10-01 amount 42.50 https://example.test/x short',
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
            }) } };
            mockAgent.db.logTokenUsage = jest.fn();
            mockAgent.processMessage.mockImplementation(async (msg, cb) => { await cb({ content: longText }); return {}; });
        });
        afterEach(() => {
            if (savedEnv === undefined) delete process.env.SUBAGENT_RESULT_CAP;
            else process.env.SUBAGENT_RESULT_CAP = savedEnv;
        });

        it('compresses a long result with LITE and stores the full text', async () => {
            const out = await service.spawn({ task: 'x', parentChatId: 'c' });
            expect(out.result).toContain('ID-7781 due 2026-10-01 amount 42.50 https://example.test/x short');
            expect(out.result).toContain('getAgentResult');
            expect(out.result.length).toBeLessThan(longText.length);

            const call = mockAgent.client.models.generateContent.mock.calls[0][0];
            expect(call.model).toMatch(/lite/);
            expect(call.config.thinkingConfig.thinkingLevel).toBe('MINIMAL');
            expect(call.contents[0].parts[0].text).toContain('[SILENT]');
            expect(mockAgent.db.logTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ tag: 'subagent_summary' }));
            expect(mockAgent.db.updateSubAgent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                status: 'completed', resultFull: longText
            }));
        });

        it('leaves a short result alone', async () => {
            mockAgent.processMessage.mockImplementation(async (msg, cb) => { await cb({ content: 'short' }); return {}; });
            const out = await service.spawn({ task: 'x', parentChatId: 'c' });
            expect(out.result).toBe('short');
            expect(mockAgent.client.models.generateContent).not.toHaveBeenCalled();
            const update = mockAgent.db.updateSubAgent.mock.calls[0][1];
            expect(update.resultFull).toBeUndefined();
        });

        it('SUBAGENT_RESULT_CAP=0 disables the cap', async () => {
            process.env.SUBAGENT_RESULT_CAP = '0';
            const out = await service.spawn({ task: 'x', parentChatId: 'c' });
            expect(out.result).toBe(longText);
            expect(mockAgent.client.models.generateContent).not.toHaveBeenCalled();
        });

        it('a stalled summarizer cannot hold the caller: cuts at the cap after 30s', async () => {
            jest.useFakeTimers();
            // Never settles on its own, and ignores the abort signal.
            mockAgent.client.models.generateContent.mockImplementation(() => new Promise(() => {}));
            const p = service.spawn({ task: 'x', parentChatId: 'c' });
            await jest.advanceTimersByTimeAsync(31000);
            const out = await p;
            jest.useRealTimers();

            expect(out.result.startsWith(longText.slice(0, 4000))).toBe(true);
            expect(out.result).toContain('full: true');
            const call = mockAgent.client.models.generateContent.mock.calls[0][0];
            expect(call.config.abortSignal).toBeDefined();
        });

        it('cuts at the cap when the summarizer fails', async () => {
            mockAgent.client.models.generateContent.mockRejectedValue(new Error('quota'));
            const out = await service.spawn({ task: 'x', parentChatId: 'c' });
            expect(out.result.startsWith(longText.slice(0, 4000))).toBe(true);
            expect(out.result).toContain('full: true');
            expect(mockAgent.db.updateSubAgent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ resultFull: longText }));
        });

        it('getResult returns the full text on request', async () => {
            mockAgent.db.getSubAgent.mockReturnValue({ id: 't', status: 'completed', result: 'short', result_full: 'the whole thing' });
            expect((await service.getResult('t')).result).toBe('short');
            expect((await service.getResult('t')).hasFullResult).toBe(true);
            expect((await service.getResult('t', { full: true })).result).toBe('the whole thing');
        });
    });
});
