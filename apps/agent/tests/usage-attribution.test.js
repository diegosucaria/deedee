const { estimateTokens, usageTag, prefixHash, promptComposition, usageColumns } = require('../src/services/usage-attribution');

describe('usage attribution helpers', () => {
    const decl = (name) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } });

    test('usageTag picks the call class from the message and adds the loop suffix', () => {
        expect(usageTag({ source: 'web', metadata: {} })).toBe('chat');
        expect(usageTag({ source: 'whatsapp', metadata: {} })).toBe('chat');
        expect(usageTag({ source: 'scheduler', metadata: { jobName: 'x' } })).toBe('job');
        expect(usageTag({ source: 'subagent', metadata: { isSubAgent: true } })).toBe('subagent');
        expect(usageTag({ source: 'system', metadata: {} }, { watcher: true })).toBe('watcher');
        expect(usageTag({ source: 'web', metadata: {} }, { toolLoop: true })).toBe('chat_tool_loop');
        expect(usageTag({ source: 'scheduler' }, { toolLoop: true })).toBe('job_tool_loop');
        expect(usageTag({ source: 'scheduler', metadata: { isSubAgent: true } }, { toolLoop: true })).toBe('subagent_tool_loop');
        expect(usageTag(undefined)).toBe('chat');
    });

    test('sub-agent wins over the watcher flag, watcher over scheduler', () => {
        expect(usageTag({ source: 'scheduler', metadata: { isSubAgent: true } }, { watcher: true })).toBe('subagent');
        expect(usageTag({ source: 'scheduler', metadata: {} }, { watcher: true })).toBe('watcher');
    });

    test('estimateTokens is JSON length / 4, rounded up, 0 for nothing', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens(null)).toBe(0);
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('abcde')).toBe(2);
        expect(estimateTokens({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 4));
    });

    test('promptComposition estimates the three parts and counts declarations', () => {
        const tools = [{ functionDeclarations: [decl('getTime'), decl('askUser')] }];
        const history = [{ role: 'user', parts: [{ text: 'hello there' }] }];
        const c = promptComposition({ systemInstruction: 'x'.repeat(400), tools, history });
        expect(c.sysTokensEst).toBe(100);
        expect(c.toolsTokensEst).toBe(Math.ceil(JSON.stringify(tools[0].functionDeclarations).length / 4));
        expect(c.historyTokensEst).toBe(Math.ceil(JSON.stringify(history).length / 4));
        expect(c.declCount).toBe(2);
        expect(c.prefixHash).toMatch(/^[0-9a-f]{40}$/);
    });

    test('googleSearch mode has no declarations but still a tool estimate', () => {
        const c = promptComposition({ systemInstruction: 'sys', tools: [{ googleSearch: {} }], history: [] });
        expect(c.declCount).toBe(0);
        expect(c.toolsTokensEst).toBeGreaterThan(0);
        expect(c.historyTokensEst).toBe(Math.ceil('[]'.length / 4));
    });

    test('prefix hash ignores declaration order and bodies, changes with names or prompt', () => {
        const a = prefixHash('sys', [{ functionDeclarations: [decl('a'), decl('b')] }]);
        const reordered = prefixHash('sys', [{ functionDeclarations: [decl('b'), decl('a')] }]);
        const otherBody = prefixHash('sys', [{ functionDeclarations: [{ ...decl('a'), description: 'changed' }, decl('b')] }]);
        const moreTools = prefixHash('sys', [{ functionDeclarations: [decl('a'), decl('b'), decl('c')] }]);
        const otherPrompt = prefixHash('sys2', [{ functionDeclarations: [decl('a'), decl('b')] }]);
        expect(reordered).toBe(a);
        expect(otherBody).toBe(a);
        expect(moreTools).not.toBe(a);
        expect(otherPrompt).not.toBe(a);
    });

    test('usageColumns maps a composition to the four columns and is empty without one', () => {
        expect(usageColumns(undefined)).toEqual({});
        expect(usageColumns({ sysTokensEst: 1, toolsTokensEst: 2, historyTokensEst: 3, declCount: 4, prefixHash: 'h' }))
            .toEqual({ sysTokensEst: 1, toolsTokensEst: 2, historyTokensEst: 3, declCount: 4 });
    });
});
