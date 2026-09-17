const { isSecretName, maskSecrets, maskSettings, unmaskSecrets, hasSecretMarker } = require('../src/utils/secret-mask');

describe('isSecretName', () => {
    test('names that hold credentials', () => {
        for (const name of ['apiKey', 'api_key', 'token', 'clientSecret', 'password', 'PASS', 'refresh_token', 'webhookUrl']) {
            expect(isSecretName(name)).toBe(true);
        }
    });

    test('names that do not', () => {
        for (const name of ['models', 'owner_phone', 'search_strategy', 'keywords', 'mode', '']) {
            expect(isSecretName(name)).toBe(false);
        }
    });
});

describe('maskSettings', () => {
    test('a provider key comes back as a flag, the rest untouched', () => {
        const masked = maskSettings({
            'provider:xai': { apiKey: 'xai-abc123', models: ['grok-4'] },
            owner_phone: '+10000000000',
            discogs_token: 'dg-secret'
        });

        expect(masked['provider:xai']).toEqual({ apiKey: { __secret: true, set: true }, models: ['grok-4'] });
        expect(masked.owner_phone).toBe('+10000000000');
        expect(masked.discogs_token).toEqual({ __secret: true, set: true });
        expect(JSON.stringify(masked)).not.toContain('xai-abc123');
        expect(JSON.stringify(masked)).not.toContain('dg-secret');
    });

    test('an empty secret reads as unset', () => {
        expect(maskSettings({ 'provider:xai': { apiKey: '' } })['provider:xai'].apiKey)
            .toEqual({ __secret: true, set: false });
    });

    test('nested tokens are masked too', () => {
        const masked = maskSecrets({ accounts: [{ label: 'work', refresh_token: 'rt-1' }] }, 'gws');
        expect(masked.accounts[0]).toEqual({ label: 'work', refresh_token: { __secret: true, set: true } });
    });
});

describe('unmaskSecrets', () => {
    test('a marker keeps the stored value', () => {
        const merged = unmaskSecrets(
            { apiKey: { __secret: true }, models: ['grok-4', 'grok-5'] },
            { apiKey: 'xai-abc123', models: ['grok-4'] }
        );
        expect(merged).toEqual({ apiKey: 'xai-abc123', models: ['grok-4', 'grok-5'] });
    });

    test('an empty string clears the stored value', () => {
        expect(unmaskSecrets({ apiKey: '' }, { apiKey: 'xai-abc123' })).toEqual({ apiKey: '' });
    });

    test('a new value replaces the stored one', () => {
        expect(unmaskSecrets({ apiKey: 'xai-new' }, { apiKey: 'xai-old' })).toEqual({ apiKey: 'xai-new' });
    });

    test('a marker with nothing stored writes no field', () => {
        expect(unmaskSecrets({ apiKey: { __secret: true }, models: [] }, undefined)).toEqual({ models: [] });
    });

    test('the marker never survives into storage', () => {
        const merged = unmaskSecrets({ apiKey: { __secret: true, set: true } }, { apiKey: 'kept' });
        expect(JSON.stringify(merged)).not.toContain('__secret');
    });
});

describe('hasSecretMarker', () => {
    test('finds a marker at any depth', () => {
        expect(hasSecretMarker({ a: { b: [{ __secret: true }] } })).toBe(true);
        expect(hasSecretMarker({ a: 'plain' })).toBe(false);
    });
});
