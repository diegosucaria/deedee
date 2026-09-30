// Server actions behind Autopilot → Errands.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();
const mockRevalidatePath = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: (...a) => mockRevalidatePath(...a) }));

const { getErrands, getErrand, cancelErrand } = require('../src/app/actions.js');

const errand = { id: 3, goal: 'book', mode: 'ask', state: 'waiting_owner', contactName: 'Alice', request: 'book me a haircut on Thursday' };

describe('errand server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset().mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockReset();
        mockRevalidatePath.mockReset();
    });

    test('all three reject without a session and never reach the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getErrands({ all: true })).rejects.toThrow('Unauthorized');
        await expect(getErrand(3)).rejects.toThrow('Unauthorized');
        await expect(cancelErrand(3)).rejects.toThrow('Unauthorized');
        expect(mockRequireActionSession).toHaveBeenCalledTimes(3);
        expect(mockFetchAPI).not.toHaveBeenCalled();
        expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    test('the list asks for closed errands too only when told to', async () => {
        mockFetchAPI.mockResolvedValue({ enabled: true, limits: { openErrands: 3 }, errands: [errand] });
        await expect(getErrands({ all: true })).resolves.toEqual({ ok: true, enabled: true, limits: { openErrands: 3 }, errands: [errand] });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/autopilot/errands?all=1');
        await getErrands();
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/autopilot/errands');
    });

    test('errands turned off come back as enabled: false; a missing list is empty', async () => {
        mockFetchAPI.mockResolvedValue({ enabled: false, limits: {} });
        await expect(getErrands({ all: true })).resolves.toEqual({ ok: true, enabled: false, limits: {}, errands: [] });
    });

    test('an unreachable agent is a failed load, never "no errands"', async () => {
        mockFetchAPI.mockRejectedValue(new Error('API Error 502: {"error":"Agent Service unavailable"}'));
        await expect(getErrands({ all: true })).resolves.toEqual({ ok: false, error: 'Agent Service unavailable' });
        await expect(getErrand(3)).resolves.toEqual({ ok: false, error: 'Agent Service unavailable' });
    });

    test('one errand comes with its steps, from an encoded path', async () => {
        const events = [{ id: 1, errand_id: 3, at: '2026-10-05T12:00:00.000Z', kind: 'started', detail: { goal: 'book' } }];
        mockFetchAPI.mockResolvedValue({ errand, events });
        await expect(getErrand(3)).resolves.toEqual({ ok: true, errand, events });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/autopilot/errands/3');
        await getErrand('3/../settings');
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/autopilot/errands/3%2F..%2Fsettings');
    });

    test('a missing errand shows the agent\'s reason, not the raw API error', async () => {
        mockFetchAPI.mockRejectedValue(new Error('API Error 404: {"error":"Errand not found"}'));
        await expect(getErrand(99)).resolves.toEqual({ ok: false, error: 'Errand not found' });
    });

    test('cancel posts to the errand\'s cancel route and refreshes the page', async () => {
        mockFetchAPI.mockResolvedValue({ success: true, info: 'Errand #3 with Alice is cancelled. Nothing was sent.' });
        await expect(cancelErrand(3)).resolves.toEqual({ success: true });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/autopilot/errands/3/cancel', { method: 'POST' });
        expect(mockRevalidatePath).toHaveBeenCalledWith('/autopilot');
    });

    test('a refused cancel returns the agent\'s reason and refreshes nothing', async () => {
        mockFetchAPI.mockRejectedValue(new Error('API Error 409: {"error":"Errand #3 is already done."}'));
        await expect(cancelErrand(3)).resolves.toEqual({ success: false, error: 'Errand #3 is already done.' });
        mockFetchAPI.mockRejectedValue(new Error('API Error 500: <html>Internal error</html>'));
        await expect(cancelErrand(3)).resolves.toEqual({ success: false, error: 'Request failed (500)' });
        expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    test('a blank id is refused before any call', async () => {
        await expect(getErrand('  ')).resolves.toEqual({ ok: false, error: 'No errand id.' });
        await expect(cancelErrand(undefined)).resolves.toEqual({ success: false, error: 'No errand id.' });
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });
});
