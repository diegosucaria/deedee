// The People sync links phone numbers to WhatsApp IDs using the contact list
// the WhatsApp service returns. Its tests once fed hand-made contacts that
// already carried `lid`, while the real service dropped the field, so on the
// device nothing was ever linked. This test runs the real service's output
// through the real link pass.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { PeopleService } = require('../src/services/people-service');
const { WhatsAppService } = require('../../interfaces/src/whatsapp');

describe('People link pass reads the real WhatsApp contact shape', () => {
    let dir;
    let db;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-contract-'));
        db = new AgentDB(dir);
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('contacts from WhatsAppService.getContacts() carry lid, and the link pass uses it', async () => {
        const wa = new WhatsAppService('http://agent.invalid', 'user');
        wa.store = {
            getContacts: () => [
                { id: '5490000000001@s.whatsapp.net', name: 'Alex', notify: 'Alex', lid: '100000000000001@lid' },
                { id: '100000000000001@lid', name: null, notify: 'Alex A.', lid: null },
                { id: '5490000000002@s.whatsapp.net', name: 'Bea', notify: null, lid: null }
            ]
        };
        const contacts = wa.getContacts();
        expect(contacts[0].lid).toBe('100000000000001@lid');

        const alex = db.createPerson({ name: 'Alex', phone: '5490000000001', identifiers: { whatsapp: '5490000000001' } });
        const people = new PeopleService({ db });
        expect(await people.linkWhatsAppIdentities(contacts)).toEqual({ linked: 1, upgraded: 0 });
        expect(db.getPerson('100000000000001@lid').id).toBe(alex);
    });

    test('getContact() and searchContacts() return lid too', () => {
        const wa = new WhatsAppService('http://agent.invalid', 'user');
        const rows = [{ id: '5490000000001@s.whatsapp.net', name: 'Alex', notify: 'Alex', lid: '100000000000001@lid' }];
        wa.store = { getContact: () => rows[0], getAllContactsRaw: () => rows, getContacts: () => rows };
        expect(wa.getContact('5490000000001@s.whatsapp.net').lid).toBe('100000000000001@lid');
        expect(wa.searchContacts('alex')[0].lid).toBe('100000000000001@lid');
    });
});
