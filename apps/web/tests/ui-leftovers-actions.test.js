// The three new server actions gate on a session before touching the API,
// and none of them throws an API failure at the page.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { getModels, clearSummaries, diagnoseWhatsApp } = require('../src/app/actions.js');

describe('models, summaries and diagnostics actions', () => {
    let errorSpy;

    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => errorSpy.mockRestore());

    test('all three reject without a session and skip the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getModels()).rejects.toThrow('Unauthorized');
        await expect(clearSummaries()).rejects.toThrow('Unauthorized');
        await expect(diagnoseWhatsApp('user')).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('getModels reads the model list', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ roles: [{ role: 'PRO' }], smoke: null });
        await expect(getModels()).resolves.toEqual({ roles: [{ role: 'PRO' }], smoke: null });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/models');
    });

    test('a models failure leaves the tab with an empty list, not an error page', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('agent down'));
        await expect(getModels()).resolves.toEqual({ roles: [], smoke: null, error: 'agent down' });
    });

    test('clearSummaries posts and says so', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ success: true });
        await expect(clearSummaries()).resolves.toEqual({ success: true });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/summaries/clear', { method: 'POST' });
    });

    test('a failed clear is reported, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('DB not ready'));
        await expect(clearSummaries()).resolves.toEqual({ success: false, error: 'DB not ready' });
    });

    test('diagnoseWhatsApp asks about one session and returns the report', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ session: 'user', status: 'connected', probes: {} });
        await expect(diagnoseWhatsApp('user')).resolves.toEqual({
            success: true, report: { session: 'user', status: 'connected', probes: {} }
        });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/whatsapp/diagnose', { method: 'POST', body: JSON.stringify({ session: 'user' }) });
    });

    test('a failed diagnose is reported, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('Interfaces Service unavailable'));
        await expect(diagnoseWhatsApp('assistant')).resolves.toEqual({ success: false, error: 'Interfaces Service unavailable' });
    });
});
