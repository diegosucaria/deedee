/**
 * Tests for Browser V2 — Downloads Module
 */

const { sanitizeFilename, getDownloads } = require('../src/downloads');

describe('Downloads', () => {
    describe('sanitizeFilename', () => {
        test('should pass through normal filenames', () => {
            expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
            expect(sanitizeFilename('data-2024.csv')).toBe('data-2024.csv');
        });

        test('should strip path traversal', () => {
            // Slashes are replaced with _, leading dots stripped
            const result1 = sanitizeFilename('../../../etc/passwd');
            expect(result1).not.toContain('/');
            expect(result1).not.toMatch(/^\./);

            const result2 = sanitizeFilename('..\\..\\windows\\system32');
            expect(result2).not.toContain('\\');
            expect(result2).not.toMatch(/^\./);
        });

        test('should strip leading dots', () => {
            expect(sanitizeFilename('.hidden')).toBe('hidden');
            expect(sanitizeFilename('...triple')).toBe('triple');
        });

        test('should truncate long filenames', () => {
            const longName = 'a'.repeat(250) + '.pdf';
            const result = sanitizeFilename(longName);
            expect(result.length).toBeLessThanOrEqual(200);
            expect(result).toMatch(/\.pdf$/);
        });

        test('should return default for empty', () => {
            expect(sanitizeFilename('')).toBe('download');
        });
    });

    describe('getDownloads', () => {
        test('should return empty array initially', () => {
            // Note: this tests the module state, not after install
            expect(getDownloads()).toEqual([]);
        });
    });
});
