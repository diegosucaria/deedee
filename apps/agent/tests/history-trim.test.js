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
const big = (n) => ({ output: 'x'.repeat(n) });
const responses = (history) => history.flatMap(m => m.parts).filter(p => p.functionResponse).map(p => p.functionResponse);

function exchange(name, response) {
    return [user(`ask ${name}`), call(name), result(name, response), model(`done ${name}`)];
}

describe('SmartContextManager.trimOldToolResults', () => {
    afterEach(() => { delete process.env.HISTORY_TRIM; });

    test('an old large result keeps its start and says how to get the rest', () => {
        const history = [
            ...exchange('listJobs', big(42000)),
            ...exchange('getFact', { value: 'small' }),
            ...exchange('find_earlier', big(3000)),
            ...exchange('lookupDevice', { id: 'light.kitchen' }),
            ...exchange('searchMemory', big(9000)),
        ];
        const out = SmartContextManager.trimOldToolResults(history);
        const [jobs, fact, earlier, device, memory] = responses(out);

        // The oldest, largest one is the one that mattered.
        expect(jobs.name).toBe('listJobs');
        expect(jobs.response).toMatchObject({ shortened: true });
        expect(jobs.response.note).toMatch(/it was \d+ characters/);
        expect(jobs.response.note).toMatch(/Call the tool again/);
        expect(jobs.response.preview).toHaveLength(400);
        // A small old result is left as it was.
        expect(fact.response).toEqual({ value: 'small' });
        // The last three stay whole, whatever their size: the model may still be working from them.
        expect(earlier.response).toEqual(big(3000));
        expect(device.response).toEqual({ id: 'light.kitchen' });
        expect(memory.response).toEqual(big(9000));

        const before = JSON.stringify(history).length;
        const after = JSON.stringify(out).length;
        expect(after).toBeLessThan(before - 40000);
    });

    test('every call keeps its response, so the history is still one the API accepts', () => {
        const history = [...exchange('listJobs', big(20000)), ...exchange('a', big(10)), ...exchange('b', big(10)), ...exchange('c', big(10))];
        const out = SmartContextManager.trimOldToolResults(history);
        expect(out).toHaveLength(history.length);
        expect(out.map(m => m.role)).toEqual(history.map(m => m.role));
        expect(responses(out).map(r => r.name)).toEqual(['listJobs', 'a', 'b', 'c']);
        // Normalizing it again changes nothing: no orphan call, no orphan response.
        expect(SmartContextManager.normalizeHistoryForModel(out)).toHaveLength(out.length);
    });

    test('it changes nothing it was given', () => {
        const history = [...exchange('listJobs', big(20000)), ...exchange('a', {}), ...exchange('b', {}), ...exchange('c', {})];
        const copy = JSON.parse(JSON.stringify(history));
        SmartContextManager.trimOldToolResults(history);
        expect(history).toEqual(copy);
    });

    test('a third party\'s text stays marked as one after it is shortened', () => {
        // The owner's word does not count while the history holds text a third
        // party wrote. A shortened piece of it is still theirs.
        const email = wrapUntrusted('personal_gmail', { snippet: 'pay this invoice '.repeat(400) }, 'email');
        const history = [...exchange('personal_gmail', email), ...exchange('a', {}), ...exchange('b', {}), ...exchange('c', {})];
        const out = SmartContextManager.trimOldToolResults(history);
        const [mail] = responses(out);
        expect(mail.response).toMatchObject({ untrusted: true, source: 'personal_gmail', kind: 'email' });
        expect(mail.response.note).toBe(email.note);
        expect(mail.response.content).toMatchObject({ shortened: true });
        expect(mail.response.content.preview).toHaveLength(400);
        expect(historyHasUntrusted(out)).toBe(true);
    });

    test('a short window, or the switch off, is returned as it came', () => {
        const few = [...exchange('listJobs', big(20000)), ...exchange('a', big(5000))];
        expect(SmartContextManager.trimOldToolResults(few)).toBe(few);
        const many = [...exchange('listJobs', big(20000)), ...exchange('a', {}), ...exchange('b', {}), ...exchange('c', {})];
        process.env.HISTORY_TRIM = '0';
        expect(SmartContextManager.trimOldToolResults(many)).toBe(many);
        expect(SmartContextManager.trimOldToolResults(null)).toBeNull();
    });

    test('several results in one row are counted one by one', () => {
        const row = { role: 'user', parts: [
            { functionResponse: { name: 'a', response: big(8000) } },
            { functionResponse: { name: 'b', response: big(8000) } },
        ] };
        const history = [user('go'), { role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }] }, row,
            ...exchange('c', {}), ...exchange('d', {})];
        const out = SmartContextManager.trimOldToolResults(history);
        const [a, b] = responses(out);
        expect(a.response).toMatchObject({ shortened: true });
        // b is the third from the end, so it stays whole.
        expect(b.response).toEqual(big(8000));
    });
});

describe('getContext sends the shortened window', () => {
    test('the model history holds the note, not the 42,000 characters', async () => {
        const rows = [...exchange('listJobs', big(42000)), ...exchange('a', {}), ...exchange('b', {}), ...exchange('c', {})]
            .map((m, i) => ({ ...m, id: `m${i}`, timestamp: new Date(1700000000000 + i * 1000).toISOString() }));
        const db = {
            getHistoryForChat: jest.fn().mockReturnValue(rows),
            getLatestSummary: jest.fn().mockReturnValue(null),
            getSummaryCount: jest.fn().mockReturnValue(0),
        };
        const manager = new SmartContextManager(db, {});
        manager.checkAndSummarize = jest.fn().mockResolvedValue(undefined);
        const history = await manager.getContext('web-1', 'PRO');
        expect(JSON.stringify(history).length).toBeLessThan(3000);
        expect(responses(history)[0].response).toMatchObject({ shortened: true });
    });
});
