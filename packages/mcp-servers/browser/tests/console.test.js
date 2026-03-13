/**
 * Tests for Browser V2 — Console Capture
 */

const { installConsoleCapture, getConsoleMessages, getRecentErrors, clearConsoleMessages } = require('../src/console');

describe('Console Capture', () => {
    let mockPage;
    let listeners;

    beforeEach(() => {
        clearConsoleMessages();
        listeners = {};
        mockPage = {
            on: jest.fn((event, handler) => {
                listeners[event] = handler;
            }),
        };
        installConsoleCapture(mockPage);
    });

    test('should install console and pageerror listeners', () => {
        expect(mockPage.on).toHaveBeenCalledWith('console', expect.any(Function));
        expect(mockPage.on).toHaveBeenCalledWith('pageerror', expect.any(Function));
    });

    test('should capture console messages', () => {
        listeners.console({
            type: () => 'log',
            text: () => 'Hello world',
            location: () => ({ url: 'test.js', lineNumber: 10, columnNumber: 5 }),
        });

        const { messages } = getConsoleMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].level).toBe('log');
        expect(messages[0].text).toBe('Hello world');
        expect(messages[0].location).toBe('test.js:10:5');
    });

    test('should filter by level', () => {
        listeners.console({ type: () => 'log', text: () => 'info msg', location: () => null });
        listeners.console({ type: () => 'error', text: () => 'error msg', location: () => null });
        listeners.console({ type: () => 'warn', text: () => 'warn msg', location: () => null });

        const { messages } = getConsoleMessages('error');
        expect(messages).toHaveLength(1);
        expect(messages[0].text).toBe('error msg');
    });

    test('should capture page errors', () => {
        listeners.pageerror({
            message: 'Uncaught TypeError: x is not a function',
            stack: 'TypeError: x is not a function\n    at test.js:5\n    at main.js:10',
        });

        const { errors } = getConsoleMessages();
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('TypeError');
    });

    test('should get recent errors as string', () => {
        listeners.console({ type: () => 'error', text: () => 'API failed', location: () => null });

        const errStr = getRecentErrors();
        expect(errStr).toContain('API failed');
    });

    test('should return empty for no errors', () => {
        expect(getRecentErrors()).toBe('');
    });

    test('should clear messages', () => {
        listeners.console({ type: () => 'log', text: () => 'test', location: () => null });
        clearConsoleMessages();

        const { messages } = getConsoleMessages();
        expect(messages).toHaveLength(0);
    });
});
