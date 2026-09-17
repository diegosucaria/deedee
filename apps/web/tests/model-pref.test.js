// The chat model picker: a saved id that the provider config dropped.
const { resolveModelPref, modelOptions, AUTO_MODEL } = require('../src/lib/model-pref.js');

describe('resolveModelPref', () => {
    test('keeps a saved id the config still lists', () => {
        expect(resolveModelPref('model-two', ['model-one', 'model-two'])).toBe('model-two');
    });

    test('falls back to auto when the config dropped the saved id', () => {
        expect(resolveModelPref('retired-id', ['model-one'])).toBe(AUTO_MODEL);
    });

    test('falls back to auto when the provider is not configured', () => {
        expect(resolveModelPref('retired-id', [])).toBe(AUTO_MODEL);
        expect(resolveModelPref('retired-id', undefined)).toBe(AUTO_MODEL);
    });

    test('nothing saved means auto', () => {
        expect(resolveModelPref(null, ['model-one'])).toBe(AUTO_MODEL);
        expect(resolveModelPref(AUTO_MODEL, ['model-one'])).toBe(AUTO_MODEL);
    });
});

describe('modelOptions', () => {
    test('lists the configured ids', () => {
        expect(modelOptions(['model-one'], AUTO_MODEL)).toEqual(['model-one']);
        expect(modelOptions(['model-one'], 'model-one')).toEqual(['model-one']);
    });

    test('adds the held id while the config is still loading', () => {
        expect(modelOptions([], 'model-two')).toEqual(['model-two']);
    });
});
