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
const { DJExecutor, addedLabel, MAX_SEARCH_QUERIES } = require('../src/executors/dj');
const { TIER1_LIMIT_OVERRIDES } = require('../src/utils/tool-loop-limits');

const photo = (mimeType = 'image/png', data = 'AAAA') => ({ inlineData: { mimeType, data } });
const record = (over = {}) => ({
    artist: 'Alice', title: 'Sample Record', label: 'Sample Label', catalogNumber: 'CAT-1',
    coverImageUrl: '/vinyl_covers/default.png', bpm: 0, key: '', tracks: [], meta: {}, ...over,
});

describe('DJ tools from chat', () => {
    let dir, db, ingestVinyl, ingestVinylFromBase64, exec;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-exec-'));
        db = new AgentDB(dir);
        ingestVinyl = jest.fn().mockResolvedValue([{ id: 'v-path', artist: 'Alice', title: 'Sample Record', label: 'Sample Label' }]);
        ingestVinylFromBase64 = jest.fn().mockResolvedValue([{ id: 'v-photo', artist: 'Alice', title: 'Sample Record', label: 'Sample Label' }]);
        exec = new DJExecutor({ dj: { db, ingestVinyl, ingestVinylFromBase64 } });
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('add_vinyl', () => {
        test('with no path it reads the photo attached to the current message, and only the photo', async () => {
            const message = { parts: [{ text: 'add these' }, photo(), photo('audio/ogg', 'BBBB')] };
            const out = await exec.execute('add_vinyl', {}, { message });
            expect(ingestVinylFromBase64).toHaveBeenCalledTimes(1);
            expect(ingestVinylFromBase64).toHaveBeenCalledWith('AAAA', 'image/png');
            expect(ingestVinyl).not.toHaveBeenCalled();
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
            expect(out).toContain('Alice');
        });

        test('with no path and no photo it adds nothing and says what to attach', async () => {
            const out = await exec.execute('add_vinyl', {}, { message: { parts: [{ text: 'add it' }] } });
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(ingestVinyl).not.toHaveBeenCalled();
            expect(out).toMatch(/nothing was added/);
            expect(out).toMatch(/attaches the photo/);
        });

        test('with no context at all it still adds nothing', async () => {
            const out = await exec.execute('add_vinyl', {});
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(out).toMatch(/nothing was added/);
        });

        test('with image_path it still reads the file', async () => {
            const out = await exec.execute('add_vinyl', { image_path: '/tmp/cover.jpg' }, { message: { parts: [photo()] } });
            expect(ingestVinyl).toHaveBeenCalledWith('/tmp/cover.jpg', 'auto');
            expect(ingestVinylFromBase64).not.toHaveBeenCalled();
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
        });

        test('two photos on one message are both read', async () => {
            await exec.execute('add_vinyl', {}, { message: { parts: [photo('image/jpeg', 'AAAA'), photo('image/jpeg', 'CCCC')] } });
            expect(ingestVinylFromBase64.mock.calls.map(c => c[0])).toEqual(['AAAA', 'CCCC']);
        });

        test('one unreadable photo does not lose the other, and alone it is reported', async () => {
            ingestVinylFromBase64
                .mockRejectedValueOnce(new Error('Failed to parse vinyl information from image.'))
                .mockResolvedValueOnce([{ id: 'v2', artist: 'Bob', title: 'Second Record', label: 'L' }]);
            let out = await exec.execute('add_vinyl', {}, { message: { parts: [photo('image/jpeg', 'AAAA'), photo('image/jpeg', 'CCCC')] } });
            expect(out).toMatch(/^Added 1 vinyls to your crate/);
            expect(out).toContain('Bob');
            ingestVinylFromBase64.mockRejectedValueOnce(new Error('Failed to parse vinyl information from image.'));
            out = await exec.execute('add_vinyl', {}, { message: { parts: [photo()] } });
            expect(out).toBe('Failed to ingest vinyl: Failed to parse vinyl information from image.');
        });

        test('it tells a record already in the crate from a new one', async () => {
            ingestVinylFromBase64.mockResolvedValue([
                { id: 'old', artist: 'Alice', title: 'Sample Record', label: 'L', _preExisting: true },
                { id: 'new', artist: 'Bob', title: 'Second Record', label: 'L' },
            ]);
            const out = await exec.execute('add_vinyl', {}, { message: { parts: [photo('image/jpeg')] } });
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
        expect(addedLabel(null, now)).toBe('');
        expect(addedLabel('garbage', now)).toBe('');
    });
});
