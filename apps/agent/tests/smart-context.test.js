const { SmartContextManager } = require('../src/smart-context');

describe('SmartContextManager.ensureAlternation', () => {
    const ea = SmartContextManager.ensureAlternation;

    it('should return empty array for empty input', () => {
        expect(ea([])).toEqual([]);
        expect(ea(null)).toEqual([]);
        expect(ea(undefined)).toEqual([]);
    });

    it('should pass through properly alternating history unchanged', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi there' }] },
            { role: 'user', parts: [{ text: 'How are you?' }] },
            { role: 'model', parts: [{ text: 'Good!' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(4);
        expect(result.map(m => m.role)).toEqual(['user', 'model', 'user', 'model']);
    });

    it('should drop leading model messages', () => {
        const history = [
            { role: 'model', parts: [{ text: 'Orphan model response' }] },
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('user');
        expect(result[0].parts[0].text).toBe('Hello');
    });

    it('should merge consecutive same-role messages (the core bug fix)', () => {
        // This is the exact scenario: summary ack (model) + first history message (model)
        const history = [
            { role: 'user', parts: [{ text: 'Summary context' }] },
            { role: 'model', parts: [{ text: 'Acknowledged summary' }] },
            { role: 'model', parts: [{ text: 'Previous model response from history' }] },
            { role: 'user', parts: [{ text: 'New user message' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('user');
        expect(result[1].role).toBe('model');
        // Model parts should be merged
        expect(result[1].parts).toHaveLength(2);
        expect(result[1].parts[0].text).toBe('Acknowledged summary');
        expect(result[1].parts[1].text).toBe('Previous model response from history');
        expect(result[2].role).toBe('user');
    });

    it('should merge multiple consecutive user messages', () => {
        const history = [
            { role: 'user', parts: [{ text: 'First' }] },
            { role: 'user', parts: [{ text: 'Second' }] },
            { role: 'model', parts: [{ text: 'Reply' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('user');
        expect(result[0].parts).toHaveLength(2);
        expect(result[0].parts[0].text).toBe('First');
        expect(result[0].parts[1].text).toBe('Second');
    });

    it('should handle history that is all model messages (return empty)', () => {
        const history = [
            { role: 'model', parts: [{ text: 'A' }] },
            { role: 'model', parts: [{ text: 'B' }] },
        ];
        const result = ea(history);
        expect(result).toEqual([]);
    });

    it('should handle single user message', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Hello' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    it('should handle function call/response patterns (model with functionCall + user with functionResponse)', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Turn on the lights' }] },
            { role: 'model', parts: [{ functionCall: { name: 'toggleLight', args: { on: true } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'toggleLight', response: { success: true } } }] },
            { role: 'model', parts: [{ text: 'Done! Lights are on.' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(4);
        expect(result.map(m => m.role)).toEqual(['user', 'model', 'user', 'model']);
    });

    it('should not mutate original messages', () => {
        const original = [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'user', parts: [{ text: 'World' }] },
        ];
        const originalParts0 = [...original[0].parts];
        ea(original);
        // Original should not be mutated
        expect(original[0].parts).toEqual(originalParts0);
        expect(original).toHaveLength(2);
    });

    it('should handle the full summary injection scenario with model-starting history', () => {
        // Simulate: summary user + summary ack(model) + history starts with model (the bug)
        const summaryUser = { role: 'user', parts: [{ text: '[SYSTEM: Context Summary]\nSome summary' }] };
        const summaryAck = { role: 'model', parts: [{ text: 'Understood.' }] };
        const historyStartingWithModel = [
            { role: 'model', parts: [{ text: 'Previous response' }] },
            { role: 'user', parts: [{ text: 'Follow up' }] },
            { role: 'model', parts: [{ text: 'Another response' }] },
        ];

        const combined = [summaryUser, summaryAck, ...historyStartingWithModel];
        const result = ea(combined);

        // Verify strict alternation
        for (let i = 1; i < result.length; i++) {
            expect(result[i].role).not.toBe(result[i - 1].role);
        }
        // Should start with user
        expect(result[0].role).toBe('user');
        // The two model messages (ack + first history) should be merged
        expect(result[1].role).toBe('model');
        expect(result[1].parts).toHaveLength(2);
    });

    it('should handle history with multiple parts per message', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Part 1' }, { text: 'Part 2' }] },
            { role: 'model', parts: [{ text: 'Response' }] },
        ];
        const result = ea(history);
        expect(result[0].parts).toHaveLength(2);
    });
});
