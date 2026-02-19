/**
 * Tests for Browser V2 — Wait Module
 */

const { handleWait } = require('../src/wait');

describe('Wait Module', () => {
    let mockPage;

    beforeEach(() => {
        mockPage = {
            waitForTimeout: jest.fn().mockResolvedValue(),
            waitForURL: jest.fn().mockResolvedValue(),
            waitForLoadState: jest.fn().mockResolvedValue(),
            url: jest.fn().mockReturnValue('https://example.com'),
            getByText: jest.fn().mockReturnValue({
                first: jest.fn().mockReturnValue({
                    waitFor: jest.fn().mockResolvedValue(),
                }),
            }),
        };
    });

    test('should wait for text to appear', async () => {
        const result = await handleWait(mockPage, { text: 'Welcome' });
        expect(mockPage.getByText).toHaveBeenCalledWith('Welcome');
        expect(result.success).toBe(true);
        expect(result.message).toContain('appeared');
    });

    test('should wait for text to disappear', async () => {
        const result = await handleWait(mockPage, { textGone: 'Loading...' });
        expect(mockPage.getByText).toHaveBeenCalledWith('Loading...');
        expect(result.success).toBe(true);
        expect(result.message).toContain('disappeared');
    });

    test('should wait for URL', async () => {
        const result = await handleWait(mockPage, { url: '**/dashboard' });
        expect(mockPage.waitForURL).toHaveBeenCalledWith('**/dashboard', expect.any(Object));
        expect(result.success).toBe(true);
    });

    test('should wait for load state', async () => {
        const result = await handleWait(mockPage, { loadState: 'networkidle' });
        expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', expect.any(Object));
        expect(result.success).toBe(true);
    });

    test('should wait for fixed time (capped at 10s)', async () => {
        await handleWait(mockPage, { timeMs: 5000 });
        expect(mockPage.waitForTimeout).toHaveBeenCalledWith(5000);

        await handleWait(mockPage, { timeMs: 30000 });
        expect(mockPage.waitForTimeout).toHaveBeenCalledWith(10000); // capped
    });

    test('should handle multiple conditions', async () => {
        const result = await handleWait(mockPage, { timeMs: 500, text: 'Ready' });
        expect(mockPage.waitForTimeout).toHaveBeenCalled();
        expect(mockPage.getByText).toHaveBeenCalledWith('Ready');
        expect(result.success).toBe(true);
    });

    test('should cap timeout at 60s', async () => {
        await handleWait(mockPage, { text: 'X', timeout: 120000 });
        const waitForCall = mockPage.getByText('X').first().waitFor;
        expect(waitForCall).toHaveBeenCalledWith({ state: 'visible', timeout: 60000 });
    });

    test('should return current URL', async () => {
        const result = await handleWait(mockPage, { timeMs: 100 });
        expect(result.url).toBe('https://example.com');
    });
});
