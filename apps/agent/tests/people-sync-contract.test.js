// The People sync links phone numbers to WhatsApp IDs using the contact list
// the WhatsApp service returns. Its tests once fed hand-made contacts that
// already carried `lid`, while the real service dropped the field, so on the
// device nothing was ever linked. These tests run the real store's rows
// through the real service and the real link pass.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { PeopleService } = require('../src/services/people-service');
const { WhatsAppService, SQLiteStore } = require('../../interfaces/src/whatsapp');

// Made-up numbers. Their last 7 digits differ on purpose: the store ties an
// unlinked WhatsApp ID to a phone contact with the same last 7 digits, which
// would hide a missing link.
const PHONE = '5490000000001', LID = '100000000000091';

describe('People link pass reads the real WhatsApp contact shape', () => {
    let dir;
    let db;
    let store;
    let wa;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-contract-'));
        db = new AgentDB(dir);
        jest.spyOn(console, 'log').mockImplementation(() => {});
        store = new SQLiteStore(path.join(dir, 'messages_user.db'));
        await store.upsertContacts([
            { id: `${PHONE}@s.whatsapp.net`, name: 'Alex', notify: 'Alex', lid: `${LID}@lid` },
            { id: `${LID}@lid`, name: null, notify: 'Alex A.', lid: null },
            { id: '5490000000002@s.whatsapp.net', name: 'Bea', notify: null, lid: null }
        ]);
        wa = new WhatsAppService('http://agent.invalid', 'user');
        wa.store = store;
    });

    afterEach(() => {
        clearInterval(store.queueFlushInterval);
        store.close();
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('contacts from WhatsAppService.getContacts() carry lid, and the link pass uses it', async () => {
        const contacts = wa.getContacts();
        expect(contacts.find(c => c.id === `${PHONE}@s.whatsapp.net`).lid).toBe(`${LID}@lid`);

        const alex = db.createPerson({ name: 'Alex', phone: PHONE, identifiers: { whatsapp: PHONE } });
        const people = new PeopleService({ db });
        expect(await people.linkWhatsAppIdentities(contacts)).toEqual({ linked: 1, upgraded: 0 });
        expect(db.getPerson(`${LID}@lid`).id).toBe(alex);
    });

    test('getContact() and searchContacts() return lid too', () => {
        expect(wa.getContact(`${PHONE}@s.whatsapp.net`).lid).toBe(`${LID}@lid`);
        const found = wa.searchContacts('alex');
        expect(found.find(c => c.id === `${PHONE}@s.whatsapp.net`).lid).toBe(`${LID}@lid`);
    });
});
