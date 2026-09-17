// The chat thinking control: what it holds and what it sends.
const { resolveThinkingPref, thinkingLevelFor, THINKING_CHOICES, AUTO_THINKING } = require('../src/lib/thinking-pref.js');

describe('resolveThinkingPref', () => {
    test('keeps a saved choice', () => {
        expect(resolveThinkingPref('quick')).toBe('quick');
        expect(resolveThinkingPref('deep')).toBe('deep');
        expect(resolveThinkingPref('auto')).toBe(AUTO_THINKING);
    });

    test('anything else is auto', () => {
        for (const saved of [null, undefined, '', 'HIGH', 'turbo']) {
            expect(resolveThinkingPref(saved)).toBe(AUTO_THINKING);
        }
    });
});

describe('thinkingLevelFor', () => {
    test('quick is the lowest level, deep the highest', () => {
        expect(thinkingLevelFor('quick')).toBe('MINIMAL');
        expect(thinkingLevelFor('deep')).toBe('HIGH');
    });

    test('auto sends nothing, so the agent keeps its own default', () => {
        expect(thinkingLevelFor('auto')).toBeUndefined();
        expect(thinkingLevelFor('nonsense')).toBeUndefined();
    });

    test('the control offers exactly three choices', () => {
        expect(THINKING_CHOICES.map(c => c.value)).toEqual(['auto', 'quick', 'deep']);
    });
});
