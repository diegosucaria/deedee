// setJobScope edits what a system job runs with; it needs a session first.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { setJobScope, getSubAgentTask } = require('../src/app/actions.js');

describe('setJobScope', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
    });

    test('rejects without a session and never calls the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(setJobScope('nightly_dream', { model: 'PRO' })).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('PATCHes the scope route with the encoded job name', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ success: true, model: 'PRO', allowedTools: ['getFact'] });

        await expect(setJobScope('nightly dream', { model: 'PRO', allowedTools: ['getFact'] }))
            .resolves.toEqual({ success: true, model: 'PRO', allowedTools: ['getFact'] });

        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/tasks/nightly%20dream/scope', {
            method: 'PATCH',
            body: JSON.stringify({ model: 'PRO', allowedTools: ['getFact'] })
        });
    });

    test('only sends the fields it was given', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValue({ success: true });

        await setJobScope('nightly_dream', { model: 'auto' });
        expect(JSON.parse(mockFetchAPI.mock.calls[0][1].body)).toEqual({ model: 'auto' });

        await setJobScope('nightly_dream', { allowedTools: [] });
        expect(JSON.parse(mockFetchAPI.mock.calls[1][1].body)).toEqual({ allowedTools: [] });
    });

    test('an API failure comes back as a result, not a throw', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('API Error 400: bad model'));
        await expect(setJobScope('nightly_dream', { model: 'nope' }))
            .resolves.toEqual({ success: false, error: 'API Error 400: bad model' });
    });
});

describe('getSubAgentTask', () => {
    beforeEach(() => { mockFetchAPI.mockReset(); });

    test('reads one sub-agent task, for the full result', async () => {
        mockFetchAPI.mockResolvedValueOnce({ task: { id: 7, result_full: 'the whole thing' } });
        await expect(getSubAgentTask(7)).resolves.toEqual({ task: { id: 7, result_full: 'the whole thing' } });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/subagents/7');
    });

    test('a failure returns null instead of throwing', async () => {
        mockFetchAPI.mockRejectedValue(new Error('down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(getSubAgentTask(7)).resolves.toBeNull();
        spy.mockRestore();
    });
});
