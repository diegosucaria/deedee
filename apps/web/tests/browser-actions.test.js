// The /browser server actions gate on a session before touching the API.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { getBrowserStatus, startBrowser } = require('../src/app/actions.js');

describe('browser server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
    });

    test('getBrowserStatus and startBrowser reject without a session and skip the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getBrowserStatus()).rejects.toThrow('Unauthorized');
        await expect(startBrowser()).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('with a session they call the browser API', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ running: true, url: 'about:blank', agentBusy: false, watchers: 1 });
        await expect(getBrowserStatus()).resolves.toMatchObject({ running: true });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/browser/status');

        mockFetchAPI.mockResolvedValueOnce({ running: true });
        await expect(startBrowser()).resolves.toEqual({ running: true });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/browser/start', { method: 'POST' });
    });

    test('an API failure is reported, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(getBrowserStatus()).resolves.toMatchObject({ running: false, error: 'Browser status unavailable' });
        await expect(startBrowser()).resolves.toEqual({ error: 'down' });
        spy.mockRestore();
    });
});
