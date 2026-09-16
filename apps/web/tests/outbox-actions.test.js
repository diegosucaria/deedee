// The delivery outbox server actions gate on a session before touching the API.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { getNotificationOutbox, retryOutboxDelivery } = require('../src/app/actions.js');

describe('delivery outbox server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
    });

    test('both actions reject without a session and skip the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getNotificationOutbox()).rejects.toThrow('Unauthorized');
        await expect(retryOutboxDelivery('r1')).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('with a session they call the outbox API', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ rows: [{ id: 'r1' }], counts: { pending: 1, sent: 0, failed: 0, dead: 0 } });
        await expect(getNotificationOutbox(20)).resolves.toMatchObject({ rows: [{ id: 'r1' }] });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/notifications/outbox?limit=20');

        mockFetchAPI.mockResolvedValueOnce({ delivered: true, status: 'sent', via: 'telegram', row: { id: 'r 1' } });
        await expect(retryOutboxDelivery('r 1')).resolves.toEqual({ success: true, delivered: true, status: 'sent', via: 'telegram', row: { id: 'r 1' } });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/notifications/outbox/r%201/retry', { method: 'POST' });
    });

    test('API failures are reported, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(getNotificationOutbox()).resolves.toMatchObject({ rows: [], error: 'Outbox unavailable' });
        await expect(retryOutboxDelivery('r1')).resolves.toEqual({ success: false, error: 'down' });
        spy.mockRestore();
    });
});
