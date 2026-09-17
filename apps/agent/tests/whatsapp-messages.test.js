jest.mock('axios');
const axios = require('axios');
const { fetchWhatsAppMessagesByDate } = require('../src/services/whatsapp-messages');

describe('fetchWhatsAppMessagesByDate', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.INTERFACES_URL = 'http://interfaces:5000';
        process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    test('asks the interfaces service with the internal token', async () => {
        axios.get.mockResolvedValue({ data: { messages: [{ content: 'hi' }] } });

        const rows = await fetchWhatsAppMessagesByDate('2026-01-15');

        expect(rows).toEqual([{ content: 'hi' }]);
        expect(axios.get).toHaveBeenCalledWith(
            'http://interfaces:5000/internal/whatsapp/messages-by-date',
            expect.objectContaining({
                params: { date: '2026-01-15', session: 'user' },
                headers: { Authorization: 'Bearer internal-token' }
            })
        );
    });

    test('a failure leaves consolidation with the agent messages alone', async () => {
        axios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
        await expect(fetchWhatsAppMessagesByDate('2026-01-15')).resolves.toEqual([]);
    });

    test('a reply without a messages array returns []', async () => {
        axios.get.mockResolvedValue({ data: { error: 'nope' } });
        await expect(fetchWhatsAppMessagesByDate('2026-01-15')).resolves.toEqual([]);
    });
});
