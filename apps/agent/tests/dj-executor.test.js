/**
 * The DJ tools the model calls from chat. add_vinyl could not see a photo
 * sent in chat (it only took a file path), so a background step wrote the
 * crate instead, ask or no ask. search_vinyls checked one record per call,
 * and a twelve-record list tripped the tool-loop warning. And a record added
 * seconds ago read like one the owner had kept for years.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { DJExecutor, addedLabel, imagePathInData, MAX_SEARCH_QUERIES, MAX_HITS_PER_QUERY, MAX_RESULT_CHARS, MAX_PHOTOS_PER_CALL } = require('../src/executors/dj');
const { TIER1_LIMIT_OVERRIDES } = require('../src/utils/tool-loop-limits');

// Real-looking photo bytes: a stripped row holds a short marker instead.
const AAAA = 'A'.repeat(300);
const CCCC = 'C'.repeat(300);
const photo = (mimeType = 'image/png', data = AAAA) => ({ inlineData: { mimeType, data } });
// A turn in the owner's own chat.
const own = (message) => ({ message, ownerTyped: true });
// The first bytes of a PNG and of a JPEG file, then padding.
const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(32)]);
const JPEG_BYTES = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(32)]);
const record = (over = {}) => ({
    artist: 'Alice', title: 'Sample Record', label: 'Sample Label', catalogNumber: 'CAT-1',
    coverImageUrl: '/vinyl_covers/default.png', bpm: 0, key: '', tracks: [], meta: {}, ...over,
});

describe('DJ tools from chat', () => {
    let dir, db, ingestVinyl, ingestVinylFromBase64, exec;
    const savedDataDir = process.env.DATA_DIR;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-exec-'));
        process.env.DATA_DIR = dir;
        db = new AgentDB(dir);
        ingestVinyl = jest.fn().mockResolvedValue([{ id: 'v-path', artist: 'Alice', title: 'Sample Record', label: 'Sample Label' }]);
        ingestVinylFromBase64 = jest.fn().mockResolvedValue([{ id: 'v-photo', artist: 'Alice', title: 'Sample Record', label: 'Sample Label' }]);
        exec = new DJExecutor({ dj: { db, ingestVinyl, ingestVinylFromBase64 } });
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        if (savedDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDataDir;
    });

    describe('add_vinyl', () => {
        test('with no path it reads the photo on the owner\'s current message, and only the photo', async () => {
            const message = { parts: [{ text: 'add these' }, photo(), photo('audio/ogg', 'B'.repeat(300))] };
            const out = await exec.execute('add_vinyl', {}, own(message));
            expect(ingestVinylFromBase64).toHaveBeenCalledTimes(1);
            expect(ingestVinylFromBase64).toHaveBeenCalledWith(AAAA, 'image/png');
            expect(ingestVinyl).not.toHaveBeenCalled();
            expect(out).toMatch(/^Added 1 vinyls to your crate \(details still loading\)/);
            expect(out).toContain('Alice');
        });

        test('a photo on a message that is not the owner\'s own chat is never read', async () => {
            // A contact's chat on the assistant's number, a group, a watcher run: ownerTyped is false or missing.
            for (const context of [{ message: { parts: [photo()] }, ownerTyped: false }, { message: { parts: [photo()] } }, { message: { parts: [photo()] }, ownerTyped: 'yes' }]) {
                const out = await exec.execute('add_vinyl', {}, context);
                expect(out).toMatch(/nothing was added/);
            }
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(ingestVinyl).not.toHaveBeenCalled();
        });

        test('a stripped marker in place of the bytes is not a photo', async () => {
            const out = await exec.execute('add_vinyl', {}, own({ parts: [photo('image/jpeg', '[MEDIA_STRIPPED_PASSIVE]')] }));
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(out).toMatch(/nothing was added/);
        });

        test('with no path and no photo it adds nothing and says what to send', async () => {
            const out = await exec.execute('add_vinyl', {}, own({ parts: [{ text: 'add it' }], metadata: { chatId: 'c1' } }));
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(ingestVinyl).not.toHaveBeenCalled();
            expect(out).toMatch(/nothing was added/);
            expect(out).toMatch(/sends the photo/);
        });

        test('with no context at all it still adds nothing', async () => {
            const out = await exec.execute('add_vinyl', {});
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(out).toMatch(/nothing was added/);
        });

        test('the photo the owner sent a moment earlier in the same chat is used, and the reply says so', async () => {
            db.saveMessage({ role: 'user', content: '', parts: [photo('image/jpeg', CCCC)], metadata: { chatId: 'c1' }, source: 'web' });
            const out = await exec.execute('add_vinyl', {}, own({ parts: [{ text: 'add it' }], metadata: { chatId: 'c1' } }));
            expect(ingestVinylFromBase64).toHaveBeenCalledWith(CCCC, 'image/jpeg');
            expect(out).toMatch(/^Added 1 vinyls to your crate from the photo sent earlier in this chat/);
        });

        test('a photo from another chat, from more than 30 minutes ago, or not from the owner, is not used', async () => {
            db.saveMessage({ role: 'user', content: '', parts: [photo('image/jpeg', CCCC)], metadata: { chatId: 'c2' }, source: 'web' });
            db.saveMessage({ role: 'model', content: '', parts: [photo('image/jpeg', CCCC)], metadata: { chatId: 'c1' }, source: 'web' });
            db.saveMessage({ role: 'user', content: '', parts: [photo('image/jpeg', CCCC)], metadata: { chatId: 'c1' }, source: 'web' });
            db.db.prepare("UPDATE messages SET timestamp = ? WHERE chat_id = 'c1' AND role = 'user'").run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
            let out = await exec.execute('add_vinyl', {}, own({ parts: [{ text: 'add it' }], metadata: { chatId: 'c1' } }));
            expect(out).toMatch(/nothing was added/);
            out = await exec.execute('add_vinyl', {}, { message: { parts: [{ text: 'add it' }], metadata: { chatId: 'c2' } }, ownerTyped: false });
            expect(out).toMatch(/nothing was added/);
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
        });

        test('with image_path it reads an image file under the data folder, by its real path', async () => {
            fs.mkdirSync(path.join(dir, 'vinyl_covers'), { recursive: true });
            const file = path.join(dir, 'vinyl_covers', 'cover.jpg');
            fs.writeFileSync(file, JPEG_BYTES);
            fs.writeFileSync(path.join(dir, 'vinyl_covers', 'cover.png'), PNG_BYTES);
            const out = await exec.execute('add_vinyl', { image_path: file }, own({ parts: [photo()] }));
            expect(ingestVinyl).toHaveBeenCalledWith(fs.realpathSync(file), 'auto');
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
            expect(imagePathInData(path.join(dir, 'vinyl_covers', 'cover.png'), dir)).toBe(fs.realpathSync(path.join(dir, 'vinyl_covers', 'cover.png')));
            // A link inside the folder to an image inside the folder is fine.
            fs.symlinkSync(file, path.join(dir, 'vinyl_covers', 'same.jpg'));
            expect(imagePathInData(path.join(dir, 'vinyl_covers', 'same.jpg'), dir)).toBe(fs.realpathSync(file));
        });

        test('image_path outside the data folder, not an image by name or by bytes, a folder, or a link that leaves the folder, is refused', async () => {
            fs.mkdirSync(path.join(dir, 'vinyl_covers', 'folder.jpg'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'auth.json'), '{"token":"x"}');
            fs.writeFileSync(path.join(dir, 'vinyl_covers', 'fake.jpg'), '{"token":"x"}');
            fs.symlinkSync('/etc/hostname', path.join(dir, 'vinyl_covers', 'link.jpg'));
            // A link named x.jpg to the credentials file, inside the folder: the bytes give it away.
            fs.symlinkSync(path.join(dir, 'auth.json'), path.join(dir, 'vinyl_covers', 'creds.jpg'));
            fs.linkSync(path.join(dir, 'auth.json'), path.join(dir, 'vinyl_covers', 'hard.jpg'));
            const refused = ['/etc/hostname', path.join(dir, 'auth.json'), path.join(dir, 'vinyl_covers', 'fake.jpg'), path.join(dir, 'vinyl_covers', 'link.jpg'),
                path.join(dir, 'vinyl_covers', 'creds.jpg'), path.join(dir, 'vinyl_covers', 'hard.jpg'), path.join(dir, 'vinyl_covers', 'folder.jpg'),
                path.join(dir, 'vinyl_covers', 'missing.jpg'), path.join(dir, '..', path.basename(dir), 'auth.json'), 42];
            for (const image_path of refused) {
                const out = await exec.execute('add_vinyl', { image_path }, own({ parts: [] }));
                expect(out).toMatch(/nothing was added/);
                if (typeof image_path === 'string') expect(imagePathInData(image_path, dir)).toBeNull();
            }
            expect(ingestVinyl).not.toHaveBeenCalled();
        });

        test('a job or a watcher run in his chat never picks up a photo, even one he sent a moment before', async () => {
            db.saveMessage({ role: 'user', content: '', parts: [photo('image/jpeg', CCCC)], metadata: { chatId: 'c1' }, source: 'web' });
            const job = own({ parts: [{ text: 'STEP 1 add the records' }, photo()], metadata: { chatId: 'c1', jobName: 'nightly' } });
            const watcher = own({ content: 'SYSTEM_WATCHER_ALERT: A message from a contact matched', parts: [photo()], metadata: { chatId: 'c1' } });
            for (const context of [job, watcher]) {
                expect(await exec.execute('add_vinyl', {}, context)).toMatch(/nothing was added/);
            }
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
        });

        test('whitespace inside the photo bytes is dropped before the vision call', async () => {
            const spaced = `${AAAA.slice(0, 100)}\n${AAAA.slice(100)}`;
            await exec.execute('add_vinyl', {}, own({ parts: [photo('image/JPEG', spaced)] }));
            expect(ingestVinylFromBase64).toHaveBeenCalledWith(AAAA, 'image/jpeg');
        });

        test('null arguments add nothing and search nothing, without throwing', async () => {
            expect(await exec.execute('add_vinyl', null, null)).toMatch(/nothing was added/);
            expect(await exec.execute('search_vinyls', null, null)).toMatch(/^Give a query/);
        });

        test('two photos on one message are both read, and past five the rest are left', async () => {
            await exec.execute('add_vinyl', {}, own({ parts: [photo('image/jpeg', AAAA), photo('image/jpeg', CCCC)] }));
            expect(ingestVinylFromBase64.mock.calls.map(c => c[0])).toEqual([AAAA, CCCC]);
            ingestVinylFromBase64.mockClear();
            const many = Array.from({ length: MAX_PHOTOS_PER_CALL + 2 }, (_, i) => photo('image/jpeg', String.fromCharCode(65 + i).repeat(300)));
            await exec.execute('add_vinyl', {}, own({ parts: many }));
            expect(ingestVinylFromBase64).toHaveBeenCalledTimes(MAX_PHOTOS_PER_CALL);
        });

        test('one unreadable photo does not lose the other, and alone it is reported', async () => {
            ingestVinylFromBase64
                .mockRejectedValueOnce(new Error('Failed to parse vinyl information from image.'))
                .mockResolvedValueOnce([{ id: 'v2', artist: 'Bob', title: 'Second Record', label: 'L' }]);
            let out = await exec.execute('add_vinyl', {}, own({ parts: [photo('image/jpeg', AAAA), photo('image/jpeg', CCCC)] }));
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
            expect(out).toContain('Bob');
            ingestVinylFromBase64.mockRejectedValueOnce(new Error('Failed to parse vinyl information from image.'));
            out = await exec.execute('add_vinyl', {}, own({ parts: [photo()] }));
            expect(out).toBe('Failed to ingest vinyl: Failed to parse vinyl information from image.');
        });

        test('it tells a record already in the crate from a new one', async () => {
            ingestVinylFromBase64.mockResolvedValue([
                { id: 'old', artist: 'Alice', title: 'Sample Record', label: 'L', _preExisting: true },
                { id: 'new', artist: 'Bob', title: 'Second Record', label: 'L' },
            ]);
            const out = await exec.execute('add_vinyl', {}, own({ parts: [photo('image/jpeg')] }));
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
            expect(out).toMatch(/Already in the crate/);
            expect(out.indexOf('Bob')).toBeLessThan(out.indexOf('Already in the crate'));
            expect(out.indexOf('Alice')).toBeGreaterThan(out.indexOf('Already in the crate'));
        });
    });

    describe('search_vinyls', () => {
        test('takes a list and answers per record, in one call', async () => {
            db.addVinyl(record());
            db.addVinyl(record({ artist: 'Bob', title: 'Second Record', label: 'Other Label', catalogNumber: 'CAT-2' }));
            const out = await exec.execute('search_vinyls', { queries: ['Alice Sample Record', 'Nobody Nothing', 'Bob'] }, {});
            expect(out).toMatch(/^3 searches, 2 with a match, 1 with none\./);
            expect(out).toContain('"Alice Sample Record": 1 match\n- **Alice**');
            expect(out).toContain('"Nobody Nothing": no match');
            expect(out).toContain('"Bob": 1 match\n- **Bob**');
        });

        test('one query still works, and a hit says when the record was added', async () => {
            const id = db.addVinyl(record());
            let out = await exec.execute('search_vinyls', { query: 'Alice' }, {});
            expect(out).not.toMatch(/searches,/);
            expect(out).toMatch(/^"Alice": 1 match\n- \*\*Alice\*\* — Sample Record \(Sample Label\) \[0 tracks\] \(id: [^,]+, added just now\)$/);
            db.db.prepare("UPDATE dj_vinyls SET created_at = '2026-01-05 10:00:00' WHERE id = ?").run(id);
            out = await exec.execute('search_vinyls', { query: 'Alice' }, {});
            expect(out).toContain('added 2026-01-05)');
        });

        test('a list pasted as one string, or one record per line, reads as a list', async () => {
            db.addVinyl(record());
            let out = await exec.execute('search_vinyls', { queries: 'Alice' }, {});
            expect(out).toMatch(/^"Alice": 1 match/);
            out = await exec.execute('search_vinyls', { query: 'Alice\nNobody Nothing\n\nBob' }, {});
            expect(out).toMatch(/^3 searches, 1 with a match, 2 with none\./);
            expect(out).toContain('"Nobody Nothing": no match');
        });

        test('query and queries both count: a model that fills both used to lose the first record', async () => {
            db.addVinyl(record());
            db.addVinyl(record({ artist: 'Bob', title: 'Second Record', label: 'Other Label', catalogNumber: 'CAT-2' }));
            const out = await exec.execute('search_vinyls', { query: 'Alice', queries: ['Bob', 'Nobody'] }, {});
            expect(out).toMatch(/^3 searches, 2 with a match, 1 with none\./);
            expect(out).toContain('"Alice": 1 match');
            expect(out).toContain('"Bob": 1 match');
        });

        test('a list sent as a JSON array in a string, or with entries that are not text, still reads as a list', async () => {
            db.addVinyl(record());
            let out = await exec.execute('search_vinyls', { queries: '["Alice", "Nobody"]' }, {});
            expect(out).toMatch(/^2 searches, 1 with a match, 1 with none\./);
            expect(out).not.toContain('"[');
            out = await exec.execute('search_vinyls', { queries: [{ artist: 'Alice' }, null, 'Alice', 7] }, {});
            expect(out).not.toContain('[object Object]');
            expect(out).toContain('"Alice": 1 match');
            expect(out).toContain('"7": no match');
        });

        test('a cart line with a price, a size and a year still finds the record, marked as a near match', async () => {
            db.addVinyl(record());
            const out = await exec.execute('search_vinyls', { query: 'Alice - Sample Record (12", Sample Label, 2021) 24.99' }, {});
            expect(out).toMatch(/: 1 near match with the numbers left out; compare the titles\n- \*\*Alice\*\*/);
            // A line whose words are all in the crate stays an exact match.
            expect(await exec.execute('search_vinyls', { query: 'Alice Sample Record' }, {})).toMatch(/: 1 match\n/);
            // Words that no field holds still miss: the near match only drops numbers.
            expect(await exec.execute('search_vinyls', { query: 'Alice Sample Record 2021 EUR' }, {})).toContain(': no match');
        });

        test('a band whose name is only punctuation is searched as typed', async () => {
            db.addVinyl(record({ artist: '!!!', title: 'Louden Up Now', catalogNumber: 'CAT-9' }));
            expect(await exec.execute('search_vinyls', { query: '!!!' }, {})).toMatch(/^"!!!": 1 match/);
            expect(db.searchVinyls('!!! Louden')).toHaveLength(1);
        });

        test('past ten hits for one search the rest are counted, not listed', async () => {
            for (let i = 0; i < MAX_HITS_PER_QUERY + 3; i++) db.addVinyl(record({ title: `Record ${i}`, catalogNumber: `CAT-${i}` }));
            const out = await exec.execute('search_vinyls', { query: 'Sample Label' }, {});
            expect(out).toMatch(new RegExp(`^"Sample Label": ${MAX_HITS_PER_QUERY + 3} matches\n`));
            expect(out.match(/^- \*\*Alice\*\*/gm)).toHaveLength(MAX_HITS_PER_QUERY);
            expect(out).toContain('(3 more not shown; search with more words)');
        });

        test('fifty searches with many long hits each stay under the result cap', async () => {
            for (let i = 0; i < 12; i++) {
                db.addVinyl(record({ artist: 'A Rather Long Artist Name Here', title: `An Even Longer Record Title Number ${i}`, label: 'Some Long Label Name Records', catalogNumber: `CAT-${i}`, meta: { genre: 'Electronic' } }));
            }
            const out = await exec.execute('search_vinyls', { queries: Array(MAX_SEARCH_QUERIES).fill('Some Long Label') }, {});
            expect(out.length).toBeLessThan(50000);
            expect(out.length).toBeLessThan(MAX_RESULT_CHARS + 6000);
            expect(out).toMatch(/^50 searches, 50 with a match, 0 with none\./);
            // Every search still says how many it found, even the ones with no room for lines.
            expect(out.match(/": 12 matches/g)).toHaveLength(MAX_SEARCH_QUERIES);
            expect(out).toContain('(12 more not shown; search with more words)');
        });

        test('a single punctuation character is not searched as typed', async () => {
            db.addVinyl(record());
            expect(await exec.execute('search_vinyls', { query: '-' }, {})).toBe('"-": no match');
            expect(db.searchVinyls('-')).toEqual([]);
            expect(db.searchVinyls('!!')).toEqual([]);
        });

        test('a pasted line with punctuation still finds the record', async () => {
            db.addVinyl(record());
            const out = await exec.execute('search_vinyls', { query: 'Alice — Sample Record (Sample Label / CAT-1)' }, {});
            expect(out).toContain('": 1 match');
        });

        test('nothing to search for says so instead of matching everything', async () => {
            db.addVinyl(record());
            expect(await exec.execute('search_vinyls', {}, {})).toMatch(/^Give a query/);
            expect(await exec.execute('search_vinyls', { queries: ['', '  ', '—'] }, {})).toMatch(/"—": no match/);
            expect(db.searchVinyls('— / ()')).toEqual([]);
        });

        test('past the cap the rest are dropped and the reply says so', async () => {
            const out = await exec.execute('search_vinyls', { queries: Array.from({ length: MAX_SEARCH_QUERIES + 2 }, (_, i) => `q${i}`) }, {});
            expect(out).toMatch(new RegExp(`^${MAX_SEARCH_QUERIES} searches, 0 with a match`));
            expect(out).toContain(`2 more queries were dropped: at most ${MAX_SEARCH_QUERIES} per call.`);
        });

        test('a twelve-record pass, one call per record, stays under the loop ceiling', () => {
            expect(TIER1_LIMIT_OVERRIDES.search_vinyls).toBeGreaterThanOrEqual(12);
            expect(TIER1_LIMIT_OVERRIDES.get_vinyl).toBeGreaterThanOrEqual(12);
        });
    });

    test('list_vinyls says when each record was added', async () => {
        db.addVinyl(record());
        const out = await exec.execute('list_vinyls', {}, {});
        expect(out).toMatch(/^Found 1 vinyls in your crate:\n- \*\*Alice\*\*.*, added just now\)$/);
    });

    test('addedLabel: just now, minutes, hours, then the date', () => {
        const now = Date.parse('2026-09-22T02:10:00Z');
        expect(addedLabel('2026-09-22 02:09:40', now)).toBe('added just now');
        expect(addedLabel('2026-09-22 02:05:08', now)).toBe('added 5 min ago');
        expect(addedLabel('2026-09-21 20:10:00', now)).toBe('added 6 h ago');
        expect(addedLabel('2026-06-26T21:41:05.000Z', now)).toBe('added 2026-06-26');
        // An ISO string with no zone mark is UTC, whatever the container's clock says.
        expect(addedLabel('2026-09-22T02:05:08', now)).toBe('added 5 min ago');
        expect(addedLabel('2026-09-22T02:05:08+00:00', now)).toBe('added 5 min ago');
        expect(addedLabel(null, now)).toBe('');
        expect(addedLabel('garbage', now)).toBe('');
    });
});
