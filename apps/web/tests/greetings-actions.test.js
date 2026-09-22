// Server actions behind Autopilot → Greetings and the Style picker.
const mockRequireActionSession = jest.fn();
const mockFetchAPI = jest.fn();

jest.mock('@/lib/auth/guard', () => ({ requireActionSession: (...a) => mockRequireActionSession(...a) }));
jest.mock('@/lib/api', () => ({ fetchAPI: (...a) => mockFetchAPI(...a) }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

const { getPartnerGreetingState, createPersonFromContact, approveDraft } = require('../src/app/actions.js');

const notFound = () => Promise.reject(new Error('API Error 404: {"error":"Person not found"}'));

describe('greeting and style server actions', () => {
    beforeEach(() => {
        mockRequireActionSession.mockReset().mockResolvedValue({ sub: 'owner' });
        mockFetchAPI.mockReset();
    });

    test('all three reject without a session and skip the API', async () => {
        mockRequireActionSession.mockRejectedValue(new Error('Unauthorized'));
        await expect(getPartnerGreetingState()).rejects.toThrow('Unauthorized');
        await expect(createPersonFromContact({ name: 'Alex', phone: '5490000000001' })).rejects.toThrow('Unauthorized');
        await expect(approveDraft(1)).rejects.toThrow('Unauthorized');
        expect(mockFetchAPI).not.toHaveBeenCalled();
    });

    test('the Greetings tab gets the setting, the global dry run and only the greeting jobs', async () => {
        mockFetchAPI.mockImplementation(async (url) => (url === '/v1/settings'
            ? { partner_greeting: { contact: '100000000000001@lid', name: 'Alex', mode: 'review' }, communication_dry_run: true }
            : { jobs: [{ name: 'partner_good_morning', enabled: true }, { name: 'nightly_backup', enabled: true }, { name: 'partner_good_night', enabled: false }] }));
        await expect(getPartnerGreetingState()).resolves.toEqual({
            ok: true,
            value: { contact: '100000000000001@lid', name: 'Alex', mode: 'review' },
            globalDryRun: true,
            jobs: [{ name: 'partner_good_morning', enabled: true }, { name: 'partner_good_night', enabled: false }],
        });
        expect(mockFetchAPI).toHaveBeenCalledWith('/v1/tasks?includeSystem=true');
    });

    test('an unreachable agent is reported as a failed load, never as "nobody set"', async () => {
        mockFetchAPI.mockRejectedValue(new Error('API Error 502: {"error":"Bad gateway"}'));
        await expect(getPartnerGreetingState()).resolves.toEqual({ ok: false, error: 'Bad gateway' });
    });

    test('adding a contact whose WhatsApp ID is already in People returns that person and creates nobody', async () => {
        mockFetchAPI.mockImplementation((url) => (url === '/v1/people/100000000000091' ? Promise.resolve({ id: 'p-alex', name: 'Alex' }) : notFound()));
        await expect(createPersonFromContact({ name: 'Alex A.', phone: '', lid: '100000000000091@lid' }))
            .resolves.toEqual({ success: true, id: 'p-alex', existing: true });
        expect(mockFetchAPI).not.toHaveBeenCalledWith('/v1/people', expect.anything());
    });

    test('a new contact is created with its phone and WhatsApp ID', async () => {
        mockFetchAPI.mockImplementation((url, opts) => (opts?.method === 'POST' ? Promise.resolve({ id: 'p-new' }) : notFound()));
        await expect(createPersonFromContact({ name: 'Bea', phone: '5490000000002', lid: '100000000000099@lid' }))
            .resolves.toEqual({ success: true, id: 'p-new' });
        const [, opts] = mockFetchAPI.mock.calls.find(([url, o]) => url === '/v1/people' && o?.method === 'POST');
        expect(JSON.parse(opts.body)).toEqual({
            name: 'Bea', phone: '5490000000002', source: 'web',
            identifiers: { whatsapp: '5490000000002', whatsapp_lid: '100000000000099' },
        });
    });

    test('a failed approve shows the agent\'s reason, not the raw API error', async () => {
        mockFetchAPI.mockRejectedValue(new Error('API Error 410: {"error":"This draft expired and was not sent"}'));
        await expect(approveDraft(7)).resolves.toEqual({ success: false, error: 'This draft expired and was not sent' });
    });
});
