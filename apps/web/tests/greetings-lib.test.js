// Picker logic for Autopilot → Greetings and the Style picker.
const { greetingTargets, newContactsFor, peopleBehindContacts, pickTarget, pauseValue, describeContact } = require('../src/lib/greetings.js');

// Made-up numbers. Alex's phone row carries his WhatsApp ID; his WhatsApp ID
// row carries only his push name.
const alexPhoneRow = { id: '5490000000001@s.whatsapp.net', name: 'Alex', notify: 'Sunny', phone: '5490000000001', lid: '100000000000091@lid' };
const alexLidRow = { id: '100000000000091@lid', name: null, notify: 'Sunny', phone: '100000000000091', lid: null };
const cleoRow = { id: '5490000000003@s.whatsapp.net', name: 'Cleo', notify: null, phone: '5490000000003', lid: null };

describe('Style picker: "Not in People yet"', () => {
    test('a contact found by its push name is not offered when its WhatsApp ID already belongs to a person', () => {
        const people = [{ id: 'p-alex', name: 'Alex', phone: '5490000000001', whatsapp_lid: '100000000000091' }];
        // A search for the push name matches only the WhatsApp ID row.
        expect(newContactsFor(people, [alexLidRow])).toEqual([]);
        expect(newContactsFor(people, [alexPhoneRow, alexLidRow, cleoRow]).map((c) => c.id)).toEqual([cleoRow.id]);
    });

    test('a search for a push name still lists the person that contact belongs to', () => {
        const people = [
            { id: 'p-alex', name: 'Alex', phone: '5490000000001', whatsapp_lid: '100000000000091' },
            { id: 'p-cleo', name: 'Cleo', phone: '5490000000003', whatsapp_lid: null },
        ];
        expect(peopleBehindContacts(people, [alexLidRow]).map((p) => p.id)).toEqual(['p-alex']);
        expect(peopleBehindContacts(people, [cleoRow, alexPhoneRow]).map((p) => p.id).sort()).toEqual(['p-alex', 'p-cleo']);
        expect(peopleBehindContacts(people, [{ id: '5490000000009@s.whatsapp.net', lid: null }])).toEqual([]);
    });

    test('a contact nobody covers is offered once, as its phone row', () => {
        expect(newContactsFor([], [alexPhoneRow, alexLidRow]).map((c) => c.id)).toEqual([alexPhoneRow.id]);
    });
});

describe('Greetings picker', () => {
    test('people come first, and a contact not in People is saved by its WhatsApp ID', () => {
        const people = [{ id: 'p-cleo', name: 'Cleo', phone: '5490000000003', identifiers: { whatsapp: '5490000000003' } }];
        const targets = greetingTargets(people, [cleoRow, alexPhoneRow, alexLidRow]);
        expect(targets.map((t) => [t.label, t.contact])).toEqual([
            ['Cleo', '5490000000003'],
            ['Alex', '100000000000091@lid'],
        ]);
    });

    test('a person with a linked WhatsApp ID is greeted there, where the chat is filed', () => {
        const people = [{ id: 'p-alex', name: 'Alex', phone: '5490000000001', identifiers: { whatsapp: '5490000000001', whatsapp_lid: '100000000000091' } }];
        expect(greetingTargets(people, [alexPhoneRow, alexLidRow])).toEqual([
            { key: 'person:p-alex', contact: '100000000000091@lid', label: 'Alex', detail: '5490000000001 · WhatsApp ID linked' },
        ]);
    });

    test('picking a different person starts in dry run, so a wrong click cannot send as the owner', () => {
        const saved = { contact: '100000000000091@lid', name: 'Alex', mode: 'send', pausedUntil: '2030-01-05' };
        expect(pickTarget(saved, { contact: '5490000000003', label: 'Cleo' })).toEqual({ contact: '5490000000003', name: 'Cleo', mode: 'dry_run', pausedUntil: '2030-01-05' });
        expect(pickTarget(saved, { contact: '100000000000091@lid', label: 'Alex' }).mode).toBe('send');
        expect(pickTarget({ contact: '5490000000003', name: 'Cleo', dryRun: true }, { contact: '5490000000003', label: 'Cleo' })).toEqual({ contact: '5490000000003', name: 'Cleo', mode: 'dry_run' });
        expect(pickTarget(null, { contact: '5490000000003', label: 'Cleo' }).mode).toBe('dry_run');
    });

    test('typing a "Together until" year saves nothing until the date is whole and not past', () => {
        const today = '2030-01-02';
        expect(pauseValue('0002-01-05', today)).toBeUndefined();
        expect(pauseValue('0203-01-05', today)).toBeUndefined();
        expect(pauseValue('2030-01-01', today)).toBeUndefined();
        expect(pauseValue('2030-01-05', today)).toBe('2030-01-05');
        expect(pauseValue('2030-01-02', today)).toBe('2030-01-02');
        expect(pauseValue('', today)).toBeNull();
    });

    test('a saved WhatsApp ID reads as a WhatsApp ID, not as a hidden phone number', () => {
        expect(describeContact('100000000000091@lid')).toBe('WhatsApp ID');
        expect(describeContact('5490000000003')).toBe('5490000000003');
    });
});
