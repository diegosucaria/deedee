// The Guardian page's server actions gate on a session before touching the API.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const {
    getGuardianHistory, getGuardianDecision, getGuardianStats, getGuardianPolicy,
    saveGuardianPolicy, guardianDryRun, setGuardianFeedback,
} = require('../src/app/actions.js');

const calls = () => [
    getGuardianHistory({ outcome: 'auto_denied' }),
    getGuardianDecision('d1'),
    getGuardianStats({ from: '2026-09-01' }),
    getGuardianPolicy(),
    saveGuardianPolicy({ mode: 'smart' }),
    guardianDryRun({ toolName: 'sendMessage' }),
    setGuardianFeedback('d1', 'should_allow'),
];

describe('guardian server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset();
        mockFetchAPI.mockReset();
    });

    test('every action rejects without a session and skips the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        for (const p of calls()) await expect(p).rejects.toThrow('Unauthorized');
        expect(mockRequireActionSession).toHaveBeenCalledTimes(7);
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('history drops unknown filters; detail and stats hit the right paths', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValue({ rows: [], total: 0 });
        await getGuardianHistory({ outcome: 'auto_denied,bogus', risk: 'extreme', tool: 'send*', from: 'yesterday', limit: 25 });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/guardian/history?outcome=auto_denied&tool=send*&limit=25');

        mockFetchAPI.mockResolvedValueOnce({ id: 'a b', guardian_input: { tool: 'x' } });
        await expect(getGuardianDecision('a b')).resolves.toEqual({ success: true, row: { id: 'a b', guardian_input: { tool: 'x' } } });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/guardian/history/a%20b');

        await getGuardianStats({ from: '2026-09-01', to: '2026-09-17' });
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/guardian/stats?from=2026-09-01&to=2026-09-17');
        await getGuardianStats();
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/guardian/stats');
        await getGuardianPolicy();
        expect(mockFetchAPI).toHaveBeenLastCalledWith('/v1/guardian/policy');
    });

    test('saving the policy sends only known fields', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValueOnce({ mode: 'off' });
        const res = await saveGuardianPolicy({ mode: 'off', smart_policy: 'be careful', always_ask: ['category:shell'], floor: [] });
        expect(res).toEqual({ success: true, policy: { mode: 'off' } });
        const [path, opts] = mockFetchAPI.mock.calls[0];
        expect(path).toBe('/v1/guardian/policy');
        expect(opts.method).toBe('PUT');
        expect(JSON.parse(opts.body)).toEqual({ mode: 'off', smart_policy: 'be careful', always_ask: ['category:shell'] });
    });

    test('dry run validates the form before calling the API', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        await expect(guardianDryRun({ toolName: 'x', args: '{bad' })).resolves.toEqual({ success: false, error: 'Arguments must be valid JSON.' });
        expect(mockFetchAPI).not.toHaveBeenCalled();

        mockFetchAPI.mockResolvedValueOnce({ outcome: 'auto_allowed', executed: false });
        const res = await guardianDryRun({ toolName: 'sendMessage', args: '{"to":"someone"}', sourceKind: 'job', taintSources: 'readEmail\n' });
        expect(res).toEqual({ success: true, result: { outcome: 'auto_allowed', executed: false } });
        const [path, opts] = mockFetchAPI.mock.calls[0];
        expect(path).toBe('/v1/guardian/dry-run');
        expect(JSON.parse(opts.body)).toEqual({ toolName: 'sendMessage', args: { to: 'someone' }, sourceKind: 'job', taintSources: ['readEmail'] });
    });

    test('feedback sends a known value or null', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockResolvedValue({ success: true, row: { id: 'd1', feedback: 'should_deny' } });
        await expect(setGuardianFeedback('d1', 'should_deny')).resolves.toEqual({ success: true, row: { id: 'd1', feedback: 'should_deny' } });
        expect(JSON.parse(mockFetchAPI.mock.calls[0][1].body)).toEqual({ feedback: 'should_deny' });
        await setGuardianFeedback('d1', 'something else');
        expect(mockFetchAPI.mock.calls[1][0]).toBe('/v1/guardian/feedback/d1');
        expect(JSON.parse(mockFetchAPI.mock.calls[1][1].body)).toEqual({ feedback: null });
    });

    test('API failures are reported with the route message, not thrown', async () => {
        mockRequireActionSession.mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockRejectedValue(new Error('API Error 400: {"error":"mode must be manual, smart or off"}'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(saveGuardianPolicy({ mode: 'x' })).resolves.toEqual({ success: false, error: 'mode must be manual, smart or off' });
        await expect(getGuardianHistory()).resolves.toMatchObject({ rows: [], error: 'mode must be manual, smart or off' });
        await expect(getGuardianStats()).resolves.toMatchObject({ error: expect.any(String) });
        await expect(getGuardianPolicy()).resolves.toMatchObject({ error: expect.any(String) });
        await expect(getGuardianDecision('d1')).resolves.toMatchObject({ success: false });
        await expect(guardianDryRun({ toolName: 't' })).resolves.toMatchObject({ success: false });
        await expect(setGuardianFeedback('d1', 'should_allow')).resolves.toMatchObject({ success: false });
        spy.mockRestore();
    });
});
