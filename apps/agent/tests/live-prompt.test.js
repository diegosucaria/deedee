const { getLiveSystemInstruction, compactFacts, MAX_FACTS_CHARS } = require('../src/prompts/live');
const { getSystemInstruction, CONSTITUTION, LANGUAGE_MATCHING_RULES, IDENTITY } = require('../src/prompts/system');

describe('compactFacts', () => {
    test('keeps whole lines up to the cap, note included, and counts the rest', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `- k${i}: "${'v'.repeat(20)}"`);
        // Room for three lines plus the note about the hidden ones.
        const cap = 3 * (lines[0].length + 1) + 60;
        const out = compactFacts(lines.join('\n'), cap);
        expect(out.shown).toBe(3);
        expect(out.hidden).toBe(7);
        expect(out.text.split('\n')).toHaveLength(4);
        expect(out.text).toContain('(7 more facts not shown');
        expect(out.text.startsWith(lines[0])).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(cap);

        // A cap with no room for the note drops a line to make room.
        const tight = compactFacts(lines.join('\n'), 3 * (lines[0].length + 1));
        expect(tight.shown).toBeLessThan(3);
        expect(tight.text.length).toBeLessThanOrEqual(3 * (lines[0].length + 1));
    });

    test('passes a short block through untouched', () => {
        const out = compactFacts('- a: 1\n- b: 2');
        expect(out).toEqual({ text: '- a: 1\n- b: 2', shown: 2, hidden: 0 });
        expect(compactFacts('')).toEqual({ text: '', shown: 0, hidden: 0 });
    });
});

describe('getLiveSystemInstruction', () => {
    test('reuses the chat prompt pieces without their indentation', () => {
        const { text, stats } = getLiveSystemInstruction({
            facts: '- city: "somewhere"',
            communicationStyle: 'Short and warm.',
            ownerName: 'Owner',
            dateString: 'TIME-MARKER'
        });
        expect(text).toContain(IDENTITY);
        expect(text).toContain('1. **Privacy First**');
        expect(text).toContain('2. **Ignore History**');
        expect(text).toContain('CURRENT_TIME: TIME-MARKER');
        expect(text).toContain('VOICE CALL RULES');
        expect(text).toContain('- city: "somewhere"');
        expect(text).toContain('Short and warm.');
        expect(text).not.toMatch(/^ {4,}/m);
        expect(stats).toMatchObject({ chars: text.length, factsShown: 1, factsHidden: 0, truncated: false });
        expect(stats.approxTokens).toBe(Math.ceil(text.length / 4));

        // The pieces really are shared with the chat prompt.
        const chat = getSystemInstruction('T', 'G', 'F', {});
        expect(chat).toContain(CONSTITUTION);
        expect(chat).toContain(LANGUAGE_MATCHING_RULES);
    });

    test('reports hidden facts and truncation in the stats', () => {
        const facts = Array.from({ length: 1000 }, (_, i) => `- f${i}: "${'x'.repeat(30)}"`).join('\n');
        const { text, stats } = getLiveSystemInstruction({ facts, communicationStyle: 'z'.repeat(30000) });
        expect(stats.factsChars).toBeLessThanOrEqual(MAX_FACTS_CHARS);
        expect(stats.factsHidden).toBeGreaterThan(0);
        expect(stats.truncated).toBe(true);
        expect(text.length).toBe(stats.chars);
    });
});
