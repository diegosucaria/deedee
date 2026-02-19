/**
 * Tests for Browser V2 — State Management
 */

const { storeRefs, getCurrentRefs, getCurrentUrl, clearRefs, refLocator } = require('../src/state');

describe('State Management', () => {
    beforeEach(() => {
        clearRefs();
    });

    describe('storeRefs / getCurrentRefs', () => {
        test('should store and retrieve refs', () => {
            const refs = {
                e1: { role: 'button', name: 'Submit' },
                e2: { role: 'textbox', name: 'Email' },
            };
            storeRefs(refs, 'https://example.com');

            expect(getCurrentRefs()).toBe(refs);
            expect(getCurrentUrl()).toBe('https://example.com');
        });
    });

    describe('clearRefs', () => {
        test('should clear stored refs', () => {
            storeRefs({ e1: { role: 'button', name: 'OK' } }, 'https://x.com');
            clearRefs();
            expect(getCurrentRefs()).toEqual({});
            expect(getCurrentUrl()).toBe('');
        });
    });

    describe('refLocator', () => {
        test('should resolve ref to locator with name', () => {
            storeRefs({ e1: { role: 'button', name: 'Submit' } }, 'https://example.com');

            const mockPage = {
                getByRole: jest.fn().mockReturnValue({
                    nth: jest.fn().mockReturnThis(),
                }),
            };

            refLocator(mockPage, 'e1');
            expect(mockPage.getByRole).toHaveBeenCalledWith('button', { name: 'Submit', exact: true });
        });

        test('should resolve ref without name', () => {
            storeRefs({ e1: { role: 'textbox', name: '' } }, 'https://example.com');

            const mockLocator = {};
            const mockPage = {
                getByRole: jest.fn().mockReturnValue(mockLocator),
            };

            const result = refLocator(mockPage, 'e1');
            expect(mockPage.getByRole).toHaveBeenCalledWith('textbox');
            expect(result).toBe(mockLocator);
        });

        test('should apply nth for duplicates', () => {
            storeRefs({
                e1: { role: 'button', name: 'Delete', nth: 0 },
                e2: { role: 'button', name: 'Delete', nth: 1 },
            }, 'https://example.com');

            const nthLocator = {};
            const mockPage = {
                getByRole: jest.fn().mockReturnValue({
                    nth: jest.fn().mockReturnValue(nthLocator),
                }),
            };

            const result = refLocator(mockPage, 'e2');
            expect(mockPage.getByRole).toHaveBeenCalledWith('button', { name: 'Delete', exact: true });
            expect(mockPage.getByRole().nth).toHaveBeenCalledWith(1);
        });

        test('should throw on unknown ref', () => {
            storeRefs({ e1: { role: 'button', name: 'OK' } }, 'https://example.com');

            const mockPage = {};
            expect(() => refLocator(mockPage, 'e99')).toThrow(/Unknown ref "e99"/);
            expect(() => refLocator(mockPage, 'e99')).toThrow(/browser_snapshot/);
        });

        test('should list available refs in error message', () => {
            storeRefs({
                e1: { role: 'button', name: 'A' },
                e2: { role: 'button', name: 'B' },
            }, 'https://example.com');

            const mockPage = {};
            try {
                refLocator(mockPage, 'e99');
            } catch (e) {
                expect(e.message).toContain('e1');
                expect(e.message).toContain('e2');
            }
        });
    });
});
