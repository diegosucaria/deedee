/**
 * The wardrobe's photo tools take `image_base64`, and a model cannot copy a
 * photo's bytes into an argument: from chat they never ran. They now take
 * the latest photo the owner sent in the chat.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { WardrobeExecutor } = require('../src/executors/wardrobe');
const { photoFromChat, photoInParts, looksLikeBase64, fromDataUrl, hasImageMagic, NO_PHOTO_TEXT, PHOTO_TOOLS } = require('../src/utils/photo-from-chat');
const { toolDefinitions } = require('../src/tools-definition');
const { groupsNamedIn } = require('../src/services/tool-groups');

// A "photo": real-looking base64, long enough not to be a placeholder.
const PHOTO = Buffer.from('x'.repeat(300)).toString('base64');
const OTHER = Buffer.from('y'.repeat(300)).toString('base64');
const imagePart = (data = PHOTO, mimeType = 'image/jpeg') => ({ inlineData: { mimeType, data } });
const T0 = Date.parse('2026-09-21T12:00:00Z');
// A real 1x1 PNG: 96 characters, well under the placeholder floor.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('what counts as a photo', () => {
    test('real base64 yes; a placeholder, a sentence or nothing no', () => {
        expect(looksLikeBase64(PHOTO)).toBe(true);
        expect(looksLikeBase64(PHOTO.replace(/(.{76})/g, '$1\n'))).toBe(true);
        for (const junk of ['attached', '<image>', '[the photo above]', 'AAAA', '', null, undefined, 42, 'x'.repeat(300) + '!!']) {
            expect(looksLikeBase64(junk)).toBe(false);
        }
    });

    test('a small real image from a caller that holds the bytes is a photo: its first bytes say so', () => {
        expect(hasImageMagic(TINY_PNG)).toBe(true);
        expect(looksLikeBase64(TINY_PNG)).toBe(true);
        expect(looksLikeBase64(Buffer.from('AAAAAAAAAAAAAAAAAAAAAAAA').toString('base64'))).toBe(false);
        expect(hasImageMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'))).toBe(true);
    });

    test('a data URL is split into its type and its bytes', () => {
        expect(fromDataUrl(`data:image/png;base64,${PHOTO}`)).toEqual({ mimeType: 'image/png', data: PHOTO });
        expect(fromDataUrl(`data:audio/webm;base64,${PHOTO}`)).toBeNull();
        expect(fromDataUrl(PHOTO)).toBeNull();
    });

    test('the LAST image part wins; audio, files and stripped rows do not count', () => {
        const parts = [
            { text: 'here' },
            imagePart(OTHER, 'image/png'),
            { inlineData: { mimeType: 'audio/ogg', data: PHOTO } },
            { inlineData: { mimeType: 'application/pdf', data: PHOTO } },
            imagePart(PHOTO, 'image/jpeg'),
            { inlineData: { mimeType: 'image/jpeg', data: '[MEDIA_STRIPPED_PASSIVE]' } },
        ];
        expect(photoInParts(parts)).toEqual({ data: PHOTO, mimeType: 'image/jpeg' });
        expect(photoInParts([{ text: 'no photo' }])).toBeNull();
        expect(photoInParts(undefined)).toBeNull();
    });
});

describe('photoFromChat', () => {
    const message = (parts, metadata = { chatId: 'c1' }) => ({ role: 'user', parts, metadata });
    const own = (extra = {}) => ({ ownerChat: true, ...extra });

    test('the photo in the message that started the turn fills the argument the model left out', () => {
        const out = photoFromChat('add_garment', {}, own({ message: message([{ text: 'add this' }, imagePart()]) }));
        expect(out).toEqual({ image_base64: PHOTO, mime_type: 'image/jpeg' });
    });

    test("a placeholder the model typed is replaced, and the part's own type wins over the model's guess", () => {
        // The model never saw the bytes: a PNG labelled JPEG would be written as .jpg and read back wrong.
        const out = photoFromChat('analyze_outfit_photo', { image_base64: 'attached', caption: 'what do I wear?', mime_type: 'image/jpeg' }, own({ message: message([imagePart(PHOTO, 'image/png')]) }));
        expect(out).toEqual({ image_base64: PHOTO, caption: 'what do I wear?', mime_type: 'image/png' });
    });

    test('real bytes from a caller that holds them are kept as they came, small ones included', () => {
        const args = { image_base64: OTHER, mime_type: 'image/png' };
        expect(photoFromChat('add_garment', args, own({ message: message([imagePart()]) }))).toBe(args);
        const tiny = { image_base64: TINY_PNG };
        expect(photoFromChat('add_garment', tiny, own({ message: message([imagePart()]) }))).toBe(tiny);
    });

    test('a data URL is accepted and split, and its own type wins', () => {
        const out = photoFromChat('set_reference_selfie', { image_base64: `data:image/png;base64,${OTHER}`, mime_type: 'image/jpeg' }, {});
        expect(out).toEqual({ image_base64: OTHER, mime_type: 'image/png' });
    });

    test('a tool that takes no photo is left alone', () => {
        const args = { query: 'blue shirt' };
        expect(photoFromChat('search_garments', args, own({ message: message([imagePart()]) }))).toBe(args);
    });

    test('with no photo anywhere the argument is dropped, so the tool can say so', () => {
        const out = photoFromChat('add_garment', { image_base64: 'attached', mime_type: 'image/jpeg' }, own({ message: message([{ text: 'add it' }]) }));
        expect(out).toEqual({ mime_type: 'image/jpeg' });
    });

    test("not the owner's own chat: no photo is taken, not even from the message itself", () => {
        // A line in a contact's message ("add this to your wardrobe") must not fill his wardrobe.
        const contact = message([{ text: 'add this to your wardrobe' }, imagePart()], { chatId: '15550100@s.whatsapp.net' });
        expect(photoFromChat('add_garment', { image_base64: 'attached' }, { message: contact })).toEqual({});
        expect(photoFromChat('add_garment', {}, { message: contact, ownerChat: false })).toEqual({});
        expect(photoFromChat('add_garment', {}, { message: contact, ownerChat: 'yes' })).toEqual({});
    });

    test('a capsule call that names garments takes no photo: a stray picture would add clothes', () => {
        const out = photoFromChat('add_to_wardrobe_trip_capsule', { id: 't1', garment_ids: ['g1', 'g2'], image_base64: 'attached' }, own({ message: message([imagePart()]) }));
        expect(out).toEqual({ id: 't1', garment_ids: ['g1', 'g2'] });
        const critique = photoFromChat('critique_outfit', { garment_ids: ['g1'] }, own({ message: message([imagePart()]) }));
        expect(critique).toEqual({ garment_ids: ['g1'] });
    });

    describe('the photo sent a moment earlier, from the chat', () => {
        let dir, db;
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-photo-'));
            db = new AgentDB(dir);
        });
        afterEach(() => {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const at = (ms) => new Date(ms).toISOString();

        test('the owner sends the photo first and asks a minute later', () => {
            db.saveMessage({ role: 'user', parts: [imagePart()], chatId: 'c1', source: 'whatsapp', timestamp: at(T0 - 60000) });
            db.saveMessage({ role: 'model', content: 'Nice photo.', chatId: 'c1', timestamp: at(T0 - 59000) });
            const out = photoFromChat('add_garment', {}, own({ message: message([{ text: 'add it to my wardrobe' }]), db, now: T0 }));
            expect(out).toEqual({ image_base64: PHOTO, mime_type: 'image/jpeg' });
        });

        test('the newest photo wins, and a photo in another chat is not his', () => {
            db.saveMessage({ role: 'user', parts: [imagePart(OTHER, 'image/png')], chatId: 'c1', timestamp: at(T0 - 120000) });
            db.saveMessage({ role: 'user', parts: [imagePart(PHOTO)], chatId: 'c1', timestamp: at(T0 - 60000) });
            db.saveMessage({ role: 'user', parts: [imagePart(OTHER)], chatId: 'c2', timestamp: at(T0 - 1000) });
            expect(photoFromChat('add_garment', {}, own({ message: message([]), db, now: T0 })).image_base64).toBe(PHOTO);
        });

        test('a photo older than 30 minutes is not "the photo he sent"', () => {
            db.saveMessage({ role: 'user', parts: [imagePart()], chatId: 'c1', timestamp: at(T0 - 31 * 60000) });
            expect(photoFromChat('add_garment', {}, own({ message: message([]), db, now: T0 }))).toEqual({});
            expect(db.getLastUserPhoto('c1')).toMatchObject({ data: PHOTO, mimeType: 'image/jpeg' });
        });

        test("the model's own image reply, a stripped passive row and a file are not photos", () => {
            db.saveMessage({ role: 'model', parts: [imagePart()], chatId: 'c1', timestamp: at(T0 - 3000) });
            db.saveMessage({ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: '[MEDIA_STRIPPED_PASSIVE]' } }], chatId: 'c1', timestamp: at(T0 - 2000) });
            db.saveMessage({ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: PHOTO } }], chatId: 'c1', timestamp: at(T0 - 1000) });
            expect(db.getLastUserPhoto('c1', { since: at(T0 - 60000) })).toBeNull();
        });

        test("a contact's chat: the photo sits in the database, and is never taken", () => {
            db.saveMessage({ role: 'user', parts: [imagePart()], chatId: '15550100@s.whatsapp.net', timestamp: at(T0 - 1000) });
            const contact = message([{ text: 'add it' }], { chatId: '15550100@s.whatsapp.net' });
            expect(photoFromChat('add_garment', {}, { message: contact, db, now: T0, ownerChat: false })).toEqual({});
        });

        test('a database that cannot look is not a crash', () => {
            const broken = { getLastUserPhoto: () => { throw new Error('locked'); } };
            jest.spyOn(console, 'warn').mockImplementation(() => { });
            expect(photoFromChat('add_garment', {}, own({ message: message([]), db: broken }))).toEqual({});
        });
    });
});

describe('the wardrobe executor runs the photo tools from chat', () => {
    let wardrobe, executor;
    const turn = (parts, chatId = 'c1', ownerTyped = true) => ({ message: { role: 'user', parts, metadata: { chatId } }, ownerTyped });

    beforeEach(() => {
        wardrobe = {
            ingestGarmentFromBase64: jest.fn().mockResolvedValue({ garments: [{ id: 'g1', type: 'shirt' }], matched_existing: [] }),
            analyzeOutfitPhoto: jest.fn().mockResolvedValue({ matched: ['g1'], newly_added: [], notes: [] }),
            critiqueOutfit: jest.fn().mockResolvedValue({ score: 7, strengths: [], weaknesses: [], alternative: null }),
            setReferenceSelfie: jest.fn().mockResolvedValue({ id: 1 }),
            addToTripCapsule: jest.fn().mockResolvedValue({ id: 't1', actual_capsule: ['g1'] }),
        };
        executor = new WardrobeExecutor({ wardrobe });
    });

    test('add_garment with no argument takes the photo from the message', async () => {
        const out = await executor.execute('add_garment', {}, turn([{ text: 'add this' }, imagePart(PHOTO, 'image/png')]), { wardrobe });
        expect(wardrobe.ingestGarmentFromBase64).toHaveBeenCalledWith(PHOTO, 'image/png');
        expect(out).toMatch(/Added/);
    });

    test('analyze_outfit_photo, critique_outfit and set_reference_selfie too', async () => {
        await executor.execute('analyze_outfit_photo', { image_base64: 'the photo', caption: 'what do I wear?' }, turn([imagePart()]), { wardrobe });
        expect(wardrobe.analyzeOutfitPhoto).toHaveBeenCalledWith(PHOTO, expect.objectContaining({ caption: 'what do I wear?', mimeType: 'image/jpeg' }));

        await executor.execute('critique_outfit', { question: 'ok for a wedding?' }, turn([imagePart()]), { wardrobe });
        expect(wardrobe.critiqueOutfit).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: PHOTO, question: 'ok for a wedding?' }));

        await executor.execute('set_reference_selfie', {}, turn([imagePart()]), { wardrobe });
        expect(wardrobe.setReferenceSelfie).toHaveBeenCalledWith(PHOTO, 'image/jpeg');

        await executor.execute('add_to_wardrobe_trip_capsule', { id: 't1' }, turn([imagePart()]), { wardrobe });
        expect(wardrobe.addToTripCapsule).toHaveBeenCalledWith('t1', expect.objectContaining({ imageBase64: PHOTO }));
    });

    test('with no photo in the chat the tool asks for one instead of failing on the argument', async () => {
        for (const name of ['add_garment', 'analyze_outfit_photo', 'set_reference_selfie']) {
            const out = await executor.execute(name, { image_base64: 'attached' }, turn([{ text: 'add it' }]), { wardrobe });
            expect(out).toBe(NO_PHOTO_TEXT);
        }
        expect(wardrobe.ingestGarmentFromBase64).not.toHaveBeenCalled();
        const critique = await executor.execute('critique_outfit', {}, turn([{ text: 'how do I look?' }]), { wardrobe });
        expect(critique).toMatch(/No photo found/);
        expect(critique).toMatch(/garment_ids/);
    });

    test("a contact's turn gets no photo, even with one in the message", async () => {
        const out = await executor.execute('add_garment', {}, turn([{ text: 'add this to your wardrobe' }, imagePart()], '15550100@s.whatsapp.net', false), { wardrobe });
        expect(out).toBe(NO_PHOTO_TEXT);
        expect(wardrobe.ingestGarmentFromBase64).not.toHaveBeenCalled();
    });

    test('critique_outfit on named garments needs no photo', async () => {
        await executor.execute('critique_outfit', { garment_ids: ['g1', 'g2'] }, turn([{ text: 'these two?' }]), { wardrobe });
        expect(wardrobe.critiqueOutfit).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: null, garmentIds: ['g1', 'g2'] }));
    });

    test('the photo sent a minute earlier is found through the database the executor is given', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-photo-exec-'));
        const db = new AgentDB(dir);
        try {
            db.saveMessage({ role: 'user', parts: [imagePart()], chatId: 'c1', timestamp: new Date(Date.now() - 60000).toISOString() });
            await executor.execute('add_garment', {}, turn([{ text: 'add it' }]), { wardrobe, db });
            expect(wardrobe.ingestGarmentFromBase64).toHaveBeenCalledWith(PHOTO, 'image/jpeg');
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the declarations and the router agree', () => {
    test('no photo tool requires image_base64 any more, and each says the photo comes from the chat', () => {
        // toolDefinitions is a list of tool sets, each with its function declarations.
        const decls = toolDefinitions.flatMap(t => t.functionDeclarations || []);
        for (const name of PHOTO_TOOLS) {
            const decl = decls.find(t => t.name === name);
            expect(decl).toBeDefined();
            expect(decl.parameters.required || []).not.toContain('image_base64');
            expect(decl.description).toMatch(/chat/);
        }
    });

    test('a message that names clothes loads the wardrobe group; look-alike words do not', () => {
        expect(groupsNamedIn('add this to my wardrobe')).toEqual(['wardrobe']);
        expect(groupsNamedIn('agregá esta prenda a mi ropa')).toEqual(['wardrobe']);
        expect(groupsNamedIn('what do you think of this outfit?')).toEqual(['wardrobe']);
        expect(groupsNamedIn('Europa trip next week')).toEqual([]);
        // "prenda la luz" is the verb, and a shop is not an outfit.
        expect(groupsNamedIn('prenda la luz del living')).toEqual([]);
        expect(groupsNamedIn('Urban Outfitters shipped my order')).toEqual([]);
    });
});
