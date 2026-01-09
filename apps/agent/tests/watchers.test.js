const request = require('supertest');
const { Agent } = require('../src/agent');
// Mocking deps
// We need a real-ish agent but with mocked client so we don't hit Gemini
// But we want to test the ROUTER logic primarily (before Gemini is called)
// The logic is inside processMessage.

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({ GSuiteTools: jest.fn().mockImplementation(() => ({ init: jest.fn() })) }));
jest.mock('@deedee/mcp-servers/src/local/index', () => ({ LocalTools: jest.fn().mockImplementation(() => ({ init: jest.fn() })) }));

describe('WhatsApp Watcher Logic', () => {
    let agent;

    beforeAll(async () => {
        const config = {
            googleApiKey: 'fake',
            interface: {
                send: jest.fn(),
                on: jest.fn(),
                emit: jest.fn()
            }
        };
        agent = new Agent(config);
        // Use in-memory DB
        // AgentDB defaults to in-memory if no path? No, defaults to data/deedee.db or whatever.
        // We should use a temp file or mock DB.
        // AgentDB is hardcoded to `db.js`. Ideally we mock AgentDB or point it to memory.
        // Let's assume for this integration test we can rely on standard Agent behavior with a test DB if we could.
        // But since we can't easily swap DB path in constructor (it's hardcoded in AgentDB class or env), 
        // we might be hitting the real dev DB if we are not careful from `npm test`.
        // `npm test` usually sets NODE_ENV=test.
        // Check `db.js`.
    });

    it('should ignore random messages to user session (Passive Mode)', async () => {
        // 1. Create a dummy message
        const message = {
            content: 'Hey random message',
            source: 'whatsapp:user', // User session
            metadata: { phoneNumber: '1234567890' },
            role: 'user'
        };

        // 2. Mock DB to return NO watchers
        agent.db.getWatchers = jest.fn().mockReturnValue([]);
        agent.db.saveMessage = jest.fn(); // Mock save

        // 3. Process
        const summary = await agent.processMessage(message, jest.fn());

        // 4. Expect NO replies, and execution stopped
        expect(summary.replies).toHaveLength(0);
        expect(agent.db.saveMessage).toHaveBeenCalledWith(message);
    });

    it('should trigger on matching watcher', async () => {
        // 1. Setup Watcher
        const watchers = [{
            id: 1,
            contact_string: '1234567890',
            condition: "contains 'secrets'",
            instruction: 'Alert me immediately',
            status: 'active'
        }];
        agent.db.getWatchers = jest.fn().mockReturnValue(watchers);
        agent.db.updateWatcher = jest.fn();
        agent.db.saveMessage = jest.fn();

        // Used to spy on internal router calls or _generateStream
        // We want to see if it CONTINUES to "Routing..."
        // In `processMessage`, if it triggers, it hijacks content and continues.
        // We can spy on `rateLimiter.check` to see if it reached that point?
        agent.rateLimiter.check = jest.fn().mockResolvedValue(true);
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH' }); // Mock router decision
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
        agent._generateStream = jest.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'OK Alerting' }] } }] });

        const message = {
            content: 'I know your secrets',
            source: 'whatsapp:user',
            metadata: { phoneNumber: '1234567890' },
            role: 'user'
        };

        await agent.processMessage(message, jest.fn());

        // Expectation: It proceeded past the passive guard check
        // Check if message content was modified
        expect(message.content).toContain('SYSTEM_WATCHER_ALERT');
        expect(message.content).toContain('INSTRUCTION: Alert me immediately');
        expect(agent.db.updateWatcher).toHaveBeenCalledWith(1, expect.anything());
    });
});
