// A contact known only by its WhatsApp ID (LID) is stored with those digits
// as its phone number too. sendMessage built "<digits>@s.whatsapp.net" from
// that, which is a stranger's number or nobody. A known WhatsApp ID must go
// to "<digits>@lid", whether the model names the person or passes the digits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { CommunicationExecutor } = require('../src/executors/communication');

// Made-up numbers only.
const PHONE = '5490000000001', LID = '100000000000091', LID_ONLY = '100000000000099';

describe('Messages to a person stored under a WhatsApp ID', () => {
    let dir;
    let db;
    let send;
    let executor;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-id-recipient-'));
        db = new AgentDB(dir);
        send = jest.fn().mockResolvedValue(true);
        executor = new CommunicationExecutor({ db, interface: { send } });
        jest.spyOn(console, 'log').mockImplementation(() => {});
        db.createPerson({ name: 'Alex', phone: PHONE, identifiers: { whatsapp: PHONE, whatsapp_lid: LID } });
        db.createPerson({ name: 'Dana', phone: LID_ONLY, identifiers: { whatsapp_lid: LID_ONLY } });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const sentTo = () => send.mock.calls[0][0].metadata.chatId;

    test('a name that resolves to a WhatsApp ID sends to "@lid", not to a phone number made of its digits', async () => {
        const r = await executor.execute('sendMessage', { to: 'Dana', content: 'see you at six' }, { approved: true });
        expect(r.success).not.toBe(false);
        expect(sentTo()).toBe(`${LID_ONLY}@lid`);
    });

    test('the bare digits of a known WhatsApp ID send to "@lid"', async () => {
        await executor.execute('sendMessage', { to: LID_ONLY, content: 'see you at six' }, { approved: true });
        expect(sentTo()).toBe(`${LID_ONLY}@lid`);
    });

    test('a person with a real phone number still gets the phone JID', async () => {
        await executor.execute('sendMessage', { to: 'Alex', content: 'see you at six' }, { approved: true });
        expect(sentTo()).toBe(`${PHONE}@s.whatsapp.net`);
    });

    test('isWhatsAppId tells a WhatsApp ID from a phone number', () => {
        expect(db.isWhatsAppId(LID)).toBe(true);
        expect(db.isWhatsAppId(LID_ONLY)).toBe(true);
        expect(db.isWhatsAppId(PHONE)).toBe(false);
        expect(db.isWhatsAppId('')).toBe(false);
    });
});
