// How hard the model should think on the next chat turn. 'auto' leaves the
// agent's own defaults in charge; quick and deep map to the two ends of the
// thinking levels. The agent clamps anything a model does not accept.

export const THINKING_PREF_KEY = 'deedee_thinking_pref';
export const AUTO_THINKING = 'auto';

export const THINKING_CHOICES = [
    { value: 'auto', label: 'Auto', level: null },
    { value: 'quick', label: 'Quick', level: 'MINIMAL' },
    { value: 'deep', label: 'Deep', level: 'HIGH' },
];

/**
 * The choice the control should hold, given what was saved.
 * @param {string|null|undefined} saved
 * @returns {string} one of auto, quick, deep
 */
export function resolveThinkingPref(saved) {
    return THINKING_CHOICES.some(c => c.value === saved) ? saved : AUTO_THINKING;
}

/**
 * The level to send with a message, or undefined for auto.
 * @param {string} choice
 * @returns {string|undefined}
 */
export function thinkingLevelFor(choice) {
    const found = THINKING_CHOICES.find(c => c.value === choice);
    return found?.level || undefined;
}
