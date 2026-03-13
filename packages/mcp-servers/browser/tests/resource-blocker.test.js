/**
 * Tests for Browser V2 — Resource Blocker
 */

const { setBlockedTypes, getBlockedTypes } = require('../src/resource-blocker');

describe('Resource Blocker', () => {
    test('should have default blocked types', () => {
        // Reset to defaults
        setBlockedTypes(['image', 'font', 'media']);
        const types = getBlockedTypes();
        expect(types).toContain('image');
        expect(types).toContain('font');
        expect(types).toContain('media');
    });

    test('should update blocked types', () => {
        setBlockedTypes(['image', 'stylesheet']);
        const types = getBlockedTypes();
        expect(types).toContain('image');
        expect(types).toContain('stylesheet');
        expect(types).not.toContain('font');
    });

    test('should disable all blocking with "none"', () => {
        setBlockedTypes(['none']);
        expect(getBlockedTypes()).toEqual([]);
    });

    test('should disable all blocking with empty array', () => {
        setBlockedTypes([]);
        expect(getBlockedTypes()).toEqual([]);
    });

    test('should re-enable blocking after disabling', () => {
        setBlockedTypes(['none']);
        expect(getBlockedTypes()).toEqual([]);

        setBlockedTypes(['image', 'font']);
        expect(getBlockedTypes()).toContain('image');
        expect(getBlockedTypes()).toContain('font');
    });
});
