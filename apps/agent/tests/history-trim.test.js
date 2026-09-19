/**
 * Old tool results in the history window. On the device they were about 80%
 * of what a chat turn sends as history: one stale 42,000-character result was
 * 62% of a chat's window, re-sent on every call for days.
 */
const { SmartContextManager } = require('../src/smart-context');
const { historyHasUntrusted, wrapUntrusted } = require('../src/utils/untrusted-content');

const call = (name, args = {}) => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
const result = (name, response) => ({ role: 'user', parts: [{ functionResponse: { name, response } }] });
const user = (text) => ({ role: 'user', parts: [{ text }] });
const model = (text) => ({ role: 'model', parts: [{ text }] });
const big = (n) => ({ data: 'x'.repeat(n) });
const responses = (history) => history.flatMap(m => m.parts).filter(p => p.functionResponse).map(p => p.functionResponse);
const exchange = (name, response) => [user(`ask ${name}`), call(name), result(name, response), model(`done ${name}`)];
const filler = () => [...exchange('lookupDevice', { id: 1 }), ...exchange('lookupDevice', { id: 2 }), ...exchange('lookupDevice', { id: 3 })];

describe('SmartContextManager.trimOldToolResults', () => {
    afterEach(() => { delete process.env.HISTORY_TRIM; });

    test('an old large result keeps its start; small ones and the last three rounds stay whole', () => {
        const history = [
            ...exchange('listJobs', big(42000)),
            ...exchange('getFact', { value: 'small' }),
            ...exchange('listJobs', big(3000)),
            ...exchange('lookupDevice', { id: 'light.kitchen' }),
            ...exchange('listJobs', big(9000)),
        ];
        const out = SmartContextManager.trimOldToolResults(history);
        const [jobs, fact, recent1, device, recent2] = responses(out);

        expect(jobs.name).toBe('listJobs');
        expect(jobs.response).toMatchObject({ shortened: true });
        expect(jobs.response.note).toMatch(/it was \d+ characters/);
        // The cut shows, so a cut number is not read as a whole one.
        expect(jobs.response.preview.endsWith('…[cut]')).toBe(true);
        expect(jobs.response.preview.length).toBeLessThan(420);
        expect(fact.response).toEqual({ value: 'small' });
        expect(recent1.response).toEqual(big(3000));
        expect(device.response).toEqual({ id: 'light.kitchen' });
        expect(recent2.response).toEqual(big(9000));
        expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(history).length - 40000);
    });

    test('the note never says to call the tool again: the tool may send, book or push', () => {
        const out = SmartContextManager.trimOldToolResults([...exchange('commitAndPush', big(5000)), ...filler()]);
        const note = responses(out)[0].response.note;
        expect(note).not.toMatch(/call the tool again/i);
        expect(note).toMatch(/read-only/);
        expect(note).toMatch(/Never repeat an action/);
    });

    test('a list keeps the start of every entry, not 400 characters of the first', () => {
        // listJobs: the first job's prompt is thousands of characters long.
        const jobs = Array.from({ length: 12 }, (_, i) => ({ name: `job_number_${i}`, cron: '0 7 * * *', task: `STEP 1 ${'do a long thing '.repeat(i === 0 ? 400 : 20)}` }));
        const out = SmartContextManager.trimOldToolResults([...exchange('listJobs', { jobs }), ...filler()]);
        const { preview } = responses(out)[0].response;
        expect(preview).toMatch(/^12 entries; the first 10/);
        for (let i = 0; i < 10; i++) expect(preview).toContain(`job_number_${i}`);
        expect(preview.endsWith('…[cut]')).toBe(true);
        expect(preview.length).toBeLessThan(600);
    });

    test('the note says the preview is not the whole result', () => {
        const out = SmartContextManager.trimOldToolResults([...exchange('listJobs', { text: 'Dear all, '.repeat(400) }), ...filler()]);
        expect(responses(out)[0].response.note).toMatch(/never send or quote it as if it were/);
        // A tool we do not know is third-party text: our note then sits beside the envelope's own.
        const unknown = SmartContextManager.trimOldToolResults([...exchange('draftLetter', { text: 'Dear all, '.repeat(400) }), ...filler()]);
        expect(responses(unknown)[0].response).toMatchObject({ untrusted: true });
        expect(responses(unknown)[0].response.shortenedNote).toMatch(/never send or quote it as if it were/);
    });

    test('parallel results of one round stay together', () => {
        // Five calls at once answer in one row. Counting results one by one
        // cut two of the five the model had fetched a turn ago.
        const names = ['a', 'b', 'c', 'd', 'e'];
        const round = [user('check five things'),
            { role: 'model', parts: names.map(n => ({ functionCall: { name: n, args: {} } })) },
            { role: 'user', parts: names.map(n => ({ functionResponse: { name: n, response: big(4000) } })) },
            model('here they are')];
        const recent = SmartContextManager.trimOldToolResults([...exchange('old', big(9000)), ...round, ...exchange('x', {}), ...exchange('y', {})]);
        const [old, ...five] = responses(recent);
        expect(old.response).toMatchObject({ shortened: true });
        for (const r of five.slice(0, 5)) expect(r.response).toEqual(big(4000));
    });

    test('every call keeps its response, so the history is still one the API accepts', () => {
        const history = [...exchange('listJobs', big(20000)), ...filler()];
        const out = SmartContextManager.trimOldToolResults(history);
        expect(out).toHaveLength(history.length);
        expect(out.map(m => m.role)).toEqual(history.map(m => m.role));
        expect(responses(out).map(r => r.name)).toEqual(['listJobs', 'lookupDevice', 'lookupDevice', 'lookupDevice']);
        expect(SmartContextManager.normalizeHistoryForModel(out)).toHaveLength(out.length);
        for (const r of responses(out)) expect(r.response && typeof r.response === 'object' && !Array.isArray(r.response)).toBe(true);
    });

    test('a string or an array result comes out as an object, which is what the API needs', () => {
        const out = SmartContextManager.trimOldToolResults([...exchange('s', 'y'.repeat(5000)), ...exchange('arr', Array(900).fill('item')), ...filler()]);
        const [s, arr] = responses(out);
        expect(s.response).toMatchObject({ shortened: true });
        expect(arr.response).toMatchObject({ shortened: true });
    });

    test('it changes nothing it was given', () => {
        const history = [...exchange('listJobs', big(20000)), ...filler()];
        const copy = JSON.parse(JSON.stringify(history));
        SmartContextManager.trimOldToolResults(history);
        expect(history).toEqual(copy);
    });

    describe('the verdict "a third party wrote this" survives the cut', () => {
        test('an untrusted envelope stays one, with our note outside its content', () => {
            const email = wrapUntrusted('personal_gmail', { snippet: 'pay this invoice '.repeat(400) }, 'email');
            const out = SmartContextManager.trimOldToolResults([...exchange('personal_gmail', email), ...filler()]);
            const [mail] = responses(out);
            expect(mail.response).toMatchObject({ untrusted: true, source: 'personal_gmail', kind: 'email', shortened: true });
            expect(mail.response.note).toBe(email.note);
            // The model is told to trust nothing inside content, so our note is not in there.
            expect(mail.response.shortenedNote).toMatch(/shortened to save context/);
            expect(Object.keys(mail.response.content)).toEqual(['preview']);
            expect(historyHasUntrusted(out)).toBe(true);
        });

        test('a plain result whose verdict is read from its body keeps the verdict', () => {
            // searchMemory and sub-agent reports are third-party text only when
            // the body says so. Cutting the body used to turn the verdict to
            // "trusted", and the owner's word then covered messages and email.
            const cases = [
                ['searchMemory', { chat_history: Array(60).fill({ content: 'a contact wrote this '.repeat(5) }), knowledge: [], facts: [] }],
                ['getAgentResult', { result: 'a sub-agent read a web page: '.repeat(200) }],
                ['spawnAgent', { result: 'report '.repeat(600) }],
            ];
            for (const [name, body] of cases) {
                const history = [...exchange(name, body), ...filler()];
                expect(historyHasUntrusted(history)).toBe(true);
                const out = SmartContextManager.trimOldToolResults(history);
                expect(responses(out)[0].response).toMatchObject({ untrusted: true, shortened: true });
                expect(historyHasUntrusted(out)).toBe(true);
            }
        });

        test('an MCP result is judged with its server, as the consent check judges it', () => {
            const serverOf = (name) => (name === 'mail_read' ? 'gws_personal' : null);
            const body = { output: 'From: someone\n' + 'text '.repeat(800) };
            const history = [...exchange('mail_read', body), ...filler()];
            const out = SmartContextManager.trimOldToolResults(history, { serverOf });
            expect(historyHasUntrusted(out, serverOf)).toBe(historyHasUntrusted(history, serverOf));
            // The text is shown, not its escaped wrapper.
            const shown = responses(out)[0].response;
            const preview = shown.untrusted ? shown.content.preview : shown.preview;
            expect(preview.startsWith('From: someone')).toBe(true);
        });

        test('a result of ours stays plain, and the gate\'s own long text is left alone', () => {
            const out = SmartContextManager.trimOldToolResults([
                ...exchange('listJobs', big(5000)),
                ...exchange('personal_gmail', { error: `Refused by the approval guardian: ${'a long reason '.repeat(200)}` }),
                ...filler()]);
            const [ours, gate] = responses(out);
            expect(ours.response.untrusted).toBeUndefined();
            expect(ours.response).toMatchObject({ shortened: true });
            // Still one key, so it is still recognised as our own text.
            expect(Object.keys(gate.response)).toEqual(['error']);
            expect(historyHasUntrusted(out)).toBe(false);
        });
    });

    test('an envelope is measured by what the tool returned, not by our wrapper', () => {
        const small = wrapUntrusted('personal_gmail', { snippet: 'z'.repeat(1300) }, 'email');
        const out = SmartContextManager.trimOldToolResults([...exchange('personal_gmail', small), ...filler()]);
        expect(responses(out)[0].response).toEqual(small);
    });

    test('a cut inside an emoji leaves a well-formed string', () => {
        const body = { data: `${'a'.repeat(390)}😀😀😀😀😀😀${'b'.repeat(3000)}` };
        const out = SmartContextManager.trimOldToolResults([...exchange('listJobs', body), ...filler()]);
        const preview = responses(out)[0].response.preview;
        expect(Buffer.from(preview, 'utf8').toString('utf8')).toBe(preview);
    });

    test('a short window, or the switch off, is returned as it came', () => {
        const few = [...exchange('listJobs', big(20000)), ...exchange('a', big(5000))];
        expect(SmartContextManager.trimOldToolResults(few)).toBe(few);
        const many = [...exchange('listJobs', big(20000)), ...filler()];
        process.env.HISTORY_TRIM = '0';
        expect(SmartContextManager.trimOldToolResults(many)).toBe(many);
        expect(SmartContextManager.trimOldToolResults(null)).toBeNull();
    });
});

describe('getContext and the summary trigger use the shortened window', () => {
    const rows = [...exchange('listJobs', big(42000)), ...filler()]
        .map((m, i) => ({ ...m, id: `m${i}`, timestamp: new Date(1700000000000 + i * 1000).toISOString() }));

    test('the model history holds the note, not the 42,000 characters', async () => {
        const db = { getHistoryForChat: jest.fn().mockReturnValue(rows), getLatestSummary: jest.fn().mockReturnValue(null) };
        const manager = new SmartContextManager(db, {});
        manager.checkAndSummarize = jest.fn().mockResolvedValue(undefined);
        const history = await manager.getContext('web-1', 'PRO', { serverOf: () => null });
        expect(JSON.stringify(history).length).toBeLessThan(3000);
        expect(responses(history)[0].response).toMatchObject({ shortened: true });
    });

    test('the summary trigger still measures the stored window', () => {
        // Measured after the cut, a chat full of tool results never reached
        // the threshold again, and so never got a summary.
        expect(SmartContextManager.estimateTokens(rows)).toBeGreaterThan(10000);
    });
});
