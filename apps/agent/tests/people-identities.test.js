const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { PeopleService } = require('../src/services/people-service');
const { ImpersonationService } = require('../src/services/impersonation');

// Made-up numbers only. PHONE_A's WhatsApp ID is LID_A, and so on.
const PHONE_A = '5490000000001', LID_A = '100000000000001';
const PHONE_B = '5490000000002', LID_B = '100000000000002';
const PHONE_C = '5490000000003', LID_C = '100000000000003';
const LID_D = '100000000000004'; // a contact known only by its WhatsApp ID

const contact = (phone, lid, name) => ({ id: `${phone}@s.whatsapp.net`, lid: lid ? `${lid}@lid` : undefined, name });

describe('People linked by phone and WhatsApp ID', () => {
    let dir;
    let db;
    let people;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-ids-'));
        db = new AgentDB(dir);
        people = new PeopleService({ db, notifications: null });
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('getPerson finds a person by id, phone, phone JID, and linked WhatsApp ID', () => {
        const id = db.createPerson({ name: 'Alex', phone: PHONE_A, identifiers: { whatsapp: PHONE_A, whatsapp_lid: LID_A } });
        expect(db.getPerson(id).name).toBe('Alex');
        expect(db.getPerson(PHONE_A).id).toBe(id);
        expect(db.getPerson(`${PHONE_A}@s.whatsapp.net`).id).toBe(id);
        expect(db.getPerson(`${LID_A}@lid`).id).toBe(id);
        expect(db.getPerson(LID_A).id).toBe(id);
        expect(db.getPerson(`${LID_B}@lid`)).toBeUndefined();
    });

    test('search matches a stored WhatsApp ID', () => {
        db.createPerson({ name: 'Alex', phone: PHONE_A, identifiers: { whatsapp: PHONE_A, whatsapp_lid: LID_A } });
        expect(db.searchPeople(LID_A).map(p => p.name)).toEqual(['Alex']);
        expect(db.listPeople({ query: LID_A }).map(p => p.name)).toEqual(['Alex']);
    });

    test('linkWhatsAppIdentities adds the WhatsApp ID to people found by phone', async () => {
        const a = db.createPerson({ name: 'Alex', phone: PHONE_A, identifiers: { whatsapp: PHONE_A } });
        db.createPerson({ name: 'NoLink', phone: PHONE_C });
        const stats = await people.linkWhatsAppIdentities([contact(PHONE_A, LID_A, 'Alex'), contact(PHONE_C, null, 'NoLink')]);
        expect(stats).toEqual({ linked: 1, upgraded: 0 });
        expect(db.getPerson(a).identifiers).toEqual({ whatsapp: PHONE_A, whatsapp_lid: LID_A });
        // Running again changes nothing.
        expect(await people.linkWhatsAppIdentities([contact(PHONE_A, LID_A, 'Alex')])).toEqual({ linked: 0, upgraded: 0 });
    });

    test('a person stored under a WhatsApp ID moves onto the linked phone number', async () => {
        const b = db.createPerson({ name: 'Bea', phone: LID_B });
        const stats = await people.linkWhatsAppIdentities([contact(PHONE_B, LID_B, 'Bea')]);
        expect(stats).toEqual({ linked: 0, upgraded: 1 });
        const moved = db.getPerson(b);
        expect(moved.phone).toBe(PHONE_B);
        expect(moved.identifiers).toEqual({ whatsapp: PHONE_B, whatsapp_lid: LID_B });
    });

    test('no move when another person already has that phone number', async () => {
        const byLid = db.createPerson({ name: 'Bea (ID)', phone: LID_B });
        const byPhone = db.createPerson({ name: 'Bea', phone: PHONE_B });
        const stats = await people.linkWhatsAppIdentities([contact(PHONE_B, LID_B, 'Bea')]);
        expect(stats).toEqual({ linked: 1, upgraded: 0 }); // the phone record gets linked
        expect(db.getPerson(byLid).phone).toBe(LID_B);
        expect(db.getPerson(byPhone).identifiers.whatsapp_lid).toBe(LID_B);
    });

    test('sync does not add a second person for a contact whose WhatsApp ID already belongs to someone', async () => {
        db.createPerson({ name: 'Cleo', phone: LID_C });
        const axios = require('axios');
        jest.spyOn(axios, 'get').mockResolvedValue({ data: [contact(PHONE_C, LID_C, 'Cleo saved'), contact(PHONE_A, LID_A, 'Alex')] });
        const stats = await people.syncFromWhatsApp();
        expect(stats.added).toBe(1); // only Alex
        expect(stats.upgraded).toBe(1); // Cleo moved onto her phone number
        expect(db.listPeople().map(p => p.name).sort()).toEqual(['Alex', 'Cleo']);
        expect(db.getPerson(`${LID_A}@lid`).name).toBe('Alex');
    });

    test('sync makes one person, not two, from a contact whose phone row and WhatsApp ID row both carry a saved name', async () => {
        const axios = require('axios');
        jest.spyOn(axios, 'get').mockResolvedValue({ data: [
            { id: `${PHONE_A}@s.whatsapp.net`, name: 'Alex', phone: PHONE_A, lid: `${LID_A}@lid` },
            { id: `${LID_A}@lid`, name: 'Alex A.', phone: LID_A, lid: null }
        ] });
        const stats = await people.syncFromWhatsApp();
        expect(stats.added).toBe(1);
        expect(db.listPeople().map(p => p.name)).toEqual(['Alex']);
        expect(db.getPerson(`${LID_A}@lid`).phone).toBe(PHONE_A);
    });

    test('a person stored under a WhatsApp ID with no known phone gets it recorded, so a lookup by WhatsApp ID finds them', async () => {
        const d = db.createPerson({ name: 'Dan', phone: LID_D });
        const list = [{ id: `${LID_D}@lid`, name: null, notify: 'Dan', lid: null }];
        expect(await people.linkWhatsAppIdentities(list)).toEqual({ linked: 1, upgraded: 0 });
        expect(db.getPerson(d).identifiers.whatsapp_lid).toBe(LID_D);
        expect(db.getPerson(`${LID_D}@lid`).id).toBe(d);
        // Running again changes nothing.
        expect(await people.linkWhatsAppIdentities(list)).toEqual({ linked: 0, upgraded: 0 });
    });

    test('sync stores a saved contact known only by its WhatsApp ID as a WhatsApp ID', async () => {
        const axios = require('axios');
        jest.spyOn(axios, 'get').mockResolvedValue({ data: [{ id: `${LID_D}@lid`, name: 'Dan', phone: LID_D, lid: null }] });
        await people.syncFromWhatsApp();
        const dan = db.getPerson(`${LID_D}@lid`);
        expect(dan.name).toBe('Dan');
        expect(dan.identifiers.whatsapp_lid).toBe(LID_D);
    });

    test('autopilot and style lookups follow the WhatsApp ID, and never match on digit suffixes', () => {
        const impersonation = new ImpersonationService({ db });
        const a = db.createPerson({ name: 'Alex', phone: PHONE_A, identifiers: { whatsapp: PHONE_A, whatsapp_lid: LID_A } });
        db.updatePerson(a, { autopilot_status: 'assisted', relationship: 'Friend', metadata: { style_profile: 'short' } });
        expect(impersonation.getAutopilotStatus(`${LID_A}@lid`)).toBe('assisted');
        expect(impersonation.getPersonRelationship(`${LID_A}@lid`)).toBe('Friend');
        expect(impersonation.getContactStyle(`${LID_A}@lid`)).toBe('short');

        // An unlinked WhatsApp ID whose last 7 digits equal someone's phone suffix must not match them.
        const suffixTwin = `90000000${PHONE_A.slice(-7)}@lid`;
        expect(impersonation.getAutopilotStatus(suffixTwin)).toBe('off');
        expect(impersonation.getContactStyle(suffixTwin)).toBeNull();
    });
});
