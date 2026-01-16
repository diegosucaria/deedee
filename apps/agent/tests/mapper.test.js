const { geminiToOpenAIHistory, openAIToGeminiChunk } = require('../src/utils/mapper');

describe('Mapper Utils', () => {

    describe('geminiToOpenAIHistory', () => {
        it('should convert user text messages correctly', () => {
            const input = [{ role: 'user', content: 'Hello' }];
            const expected = [{ role: 'user', content: 'Hello' }];
            expect(geminiToOpenAIHistory(input)).toEqual(expected);
        });

        it('should convert model text messages to assistant', () => {
            const input = [{ role: 'model', content: 'Hi there' }];
            const expected = [{ role: 'assistant', content: 'Hi there' }];
            expect(geminiToOpenAIHistory(input)).toEqual(expected);
        });

        it('should extract text from parts', () => {
            const input = [{ role: 'user', parts: [{ text: 'Part 1' }, { text: 'Part 2' }] }];
            const expected = [{ role: 'user', content: 'Part 1\nPart 2' }];
            expect(geminiToOpenAIHistory(input)).toEqual(expected);
        });

        it('should default empty content string if missing', () => {
            const input = [{ role: 'user', parts: [] }];
            const expected = [{ role: 'user', content: '' }];
            expect(geminiToOpenAIHistory(input)).toEqual(expected);
        });
    });

    describe('openAIToGeminiChunk', () => {
        it('should convert openai delta to gemini candidate', () => {
            const chunk = { choices: [{ delta: { content: 'Hello' } }] };
            const expected = {
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'Hello' }]
                    }
                }]
            };
            expect(openAIToGeminiChunk(chunk)).toEqual(expected);
        });

        it('should return null if no content in delta', () => {
            const chunk = { choices: [{ delta: { role: 'assistant' } }] };
            expect(openAIToGeminiChunk(chunk)).toBeNull();
        });
    });

});
