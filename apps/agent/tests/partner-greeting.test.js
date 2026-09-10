jest.mock('axios');
const axios = require('axios');
const { PartnerGreetingService, dayStartMs } = require('../src/services/partner-greeting');

const TZ = 'America/Argentina/Buenos_Aires'; // UTC-3, no DST
const at = iso => Date.parse(iso);

describe('dayStartMs', () => {
    test('a day starts at 04:00 local', () => {
        expect(dayStartMs(at('2026-01-15T12:00:00Z'), TZ)).toBe(at('2026-01-15T07:00:00Z')); // 09:00 local → 04:00 local today
    });

    test('02:00 local still belongs to the previous day', () => {
        expect(dayStartMs(at('2026-01-15T05:00:00Z'), TZ)).toBe(at('2026-01-14T07:00:00Z'));
    });
});

describe('PartnerGreetingService', () => {
    const OWNER = '5490000000000';
    const PARTNER = '100000000000001@lid';
    let agent;
    let settings;
    let modelReply;

    const service = () => new PartnerGreetingService(agent);
    const history = msgs => axios.get.mockResolvedValue({ data: msgs });

    beforeEach(() => {
        process.env.TZ = TZ;
        settings = { partner_greeting: { contact: PARTNER, name: 'Alex' }, owner_phone: OWNER };
        modelReply = { send: true, text: 'Good morning love', reason: 'normal day' };
        agent = {
            db: { getAgentSetting: key => (key in settings ? { key, value: settings[key] } : null), logTokenUsage: jest.fn() },
            interface: { send: jest.fn().mockResolvedValue({}) },
            client: { models: { generateContent: jest.fn(async () => ({ text: JSON.stringify(modelReply) })) } }
        };
        axios.get.mockReset();
    });

    const NOW = at('2026-01-15T10:30:00Z'); // 07:30 local

    test('does nothing when the setting is missing', async () => {
        delete settings.partner_greeting;
        const r = await service().run('morning', { now: () => NOW });
        expect(r.skipped).toBe(true);
        expect(axios.get).not.toHaveBeenCalled();
        expect(agent.interface.send).not.toHaveBeenCalled();
    });

    test('skips the morning when the owner already wrote today, without calling the model', async () => {
        history([
            { role: 'user', content: 'night', timestamp: at('2026-01-15T02:00:00Z') },
            { role: 'assistant', content: 'morning!', timestamp: at('2026-01-15T10:05:00Z') }
        ]);
        const r = await service().run('morning', { now: () => NOW });
        expect(r).toEqual({ skipped: true, reason: 'the owner already wrote today' });
        expect(agent.client.models.generateContent).not.toHaveBeenCalled();
        expect(agent.interface.send).not.toHaveBeenCalled();
    });

    test('a late-night owner message does not count as today\'s morning greeting', async () => {
        history([{ role: 'assistant', content: 'sleep well', timestamp: at('2026-01-15T05:30:00Z') }]); // 02:30 local
        const r = await service().run('morning', { now: () => NOW });
        expect(r.sent).toBe(true);
    });

    test('sends the draft from the owner\'s session and tells the owner', async () => {
        history([{ role: 'user', content: 'see you tomorrow', timestamp: at('2026-01-15T01:00:00Z') }]);
        const r = await service().run('morning', { now: () => NOW });
        expect(r).toEqual({ sent: true, kind: 'morning', text: 'Good morning love' });
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/whatsapp/history'), expect.objectContaining({
            params: expect.objectContaining({ jid: PARTNER, session: 'user' })
        }));
        const [toPartner, toOwner] = agent.interface.send.mock.calls.map(c => c[0]);
        expect(toPartner).toEqual(expect.objectContaining({ content: 'Good morning love', metadata: { chatId: PARTNER, session: 'user' } }));
        expect(toOwner.metadata).toEqual({ chatId: `${OWNER}@s.whatsapp.net`, session: 'assistant' });
        expect(toOwner.content).toContain('Good morning love');
    });

    test('when the model declines, nothing goes to the partner and the owner hears why', async () => {
        history([{ role: 'user', content: 'we need to talk', timestamp: at('2026-01-15T01:00:00Z') }]);
        modelReply = { send: false, text: '', reason: 'last night ended in an argument' };
        const r = await service().run('morning', { now: () => NOW });
        expect(r.skipped).toBe(true);
        expect(agent.interface.send).toHaveBeenCalledTimes(1);
        expect(agent.interface.send.mock.calls[0][0].metadata.chatId).toBe(`${OWNER}@s.whatsapp.net`);
        expect(agent.interface.send.mock.calls[0][0].content).toContain('argument');
    });

    test('night skips when the owner wrote within the last hour', async () => {
        const night = at('2026-01-16T01:40:00Z'); // 22:40 local
        history([{ role: 'assistant', content: 'almost home', timestamp: night - 20 * 60 * 1000 }]);
        const r = await service().run('night', { now: () => night });
        expect(r).toEqual({ skipped: true, reason: 'the owner wrote within the last hour' });
    });

    test('the prompt labels owner and partner lines', async () => {
        history([
            { role: 'user', content: 'PARTNER-LINE', timestamp: at('2026-01-15T01:00:00Z') },
            { role: 'assistant', content: 'OWNER-LINE', timestamp: at('2026-01-15T01:01:00Z') }
        ]);
        await service().run('morning', { now: () => NOW });
        const prompt = agent.client.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
        expect(prompt).toMatch(/PARTNER: PARTNER-LINE/);
        expect(prompt).toMatch(/OWNER: OWNER-LINE/);
    });
});
