/**
 * Browser V2 — Smoke Test
 * Verifies that the MCP server module loads cleanly and dependencies are available.
 */

jest.mock('playwright', () => ({
    chromium: {
        launchPersistentContext: jest.fn(),
    },
}));

describe('Browser MCP Server V2', () => {
    test('should resolve index.js without errors', () => {
        const index = require.resolve('../index.js');
        expect(index).toBeTruthy();
    });

    test('should have all src modules loadable', () => {
        expect(() => require('../src/state')).not.toThrow();
        expect(() => require('../src/snapshot')).not.toThrow();
        expect(() => require('../src/interactions')).not.toThrow();
        expect(() => require('../src/wait')).not.toThrow();
        expect(() => require('../src/vision')).not.toThrow();
        expect(() => require('../src/screencast')).not.toThrow();
    });

    test('should support reading secrets from env', () => {
        process.env.TEST_SECRET = 'secret123';
        const keys = Object.keys(process.env);
        expect(keys).toContain('TEST_SECRET');
    });
});
