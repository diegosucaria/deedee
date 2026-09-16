// The approvals server actions gate on a session before touching the API.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { getApprovals, decideApproval } = require('../src/app/actions.js');

describe('approvals server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
    });

    test('both actions reject without a session and skip the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getApprovals()).rejects.toThrow('Unauthorized');
        await expect(decideApproval('abc123', 'approve')).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('with a session they call the approvals API; unknown decisions become deny', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ pending: [{ id: 'abc123' }], counts: { pending: 1 } });
        await expect(getApprovals(20)).resolves.toMatchObject({ pending: [{ id: 'abc123' }] });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/approvals?limit=20');

        mockFetchAPI.mockResolvedValueOnce({ id: 'a b', status: 'approved', result: { ok: true } });
        await expect(decideApproval('a b', 'approve')).resolves.toEqual({ success: true, id: 'a b', status: 'approved', result: { ok: true } });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/approvals/a%20b/approve', { method: 'POST' });

        mockFetchAPI.mockResolvedValueOnce({ id: 'abc123', status: 'denied' });
        await decideApproval('abc123', 'whatever');
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/approvals/abc123/deny', { method: 'POST' });
    });

    test('API failures are reported, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(getApprovals()).resolves.toMatchObject({ pending: [], error: 'Approvals unavailable' });
        await expect(decideApproval('abc123', 'deny')).resolves.toEqual({ success: false, error: 'down' });
        spy.mockRestore();
    });
});
