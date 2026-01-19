const { ToolExecutor } = require('../src/tool-executor');

describe('ToolExecutor Integration', () => {
    let toolExecutor;
    let mockServices;

    beforeEach(() => {
        mockServices = {
            mcp: {
                callTool: jest.fn().mockResolvedValue('mcp_result')
            },
            dj: {},
            db: {},
            // Add other mock services if executors need them in constructor
            configService: { getModel: jest.fn() },
            agent: { ragService: {} }
        };

        // We need to support instantiation of all executors.
        // Some might fail if services are missing.
        // Let's rely on the fact that most executors assign services in constructor but don't use them until execute.
        // However, some might check things in constructor. 
        // Let's try to instantiate.
        toolExecutor = new ToolExecutor(mockServices);
    });

    test('should have all executors with an execute method', () => {
        toolExecutor.executors.forEach(executor => {
            expect(typeof executor.execute).toBe('function');
        });
    });

    test('should fallback to MCP for unknown tools without crashing', async () => {
        const mockContext = { message: { metadata: {} } };
        const result = await toolExecutor.execute('unknown_tool_xyz', { some: 'arg' }, mockContext);
        expect(result).toBe('mcp_result');
        expect(mockServices.mcp.callTool).toHaveBeenCalledWith('unknown_tool_xyz', { some: 'arg' });
    });
});
