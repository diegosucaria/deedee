// Job History links a run to its messages.
const { jobHistoryHref } = require('../src/lib/job-history.js');

describe('jobHistoryHref', () => {
    test('a run with its own chat opens that chat, oldest message first', () => {
        expect(jobHistoryHref({ chatId: 'scheduled_morning_briefing_1750000000000' }))
            .toBe('/system/history?chatId=scheduled_morning_briefing_1750000000000&order=asc');
    });

    test('a job that reports into a chat opens it from the moment the run began', () => {
        const href = jobHistoryHref({ chatId: '100000000000001@g.us', since: '2026-09-21T10:00:00.000Z' });
        const url = new URL(href, 'http://x');
        expect(url.pathname).toBe('/system/history');
        expect(url.searchParams.get('chatId')).toBe('100000000000001@g.us');
        expect(url.searchParams.get('since')).toBe('2026-09-21T10:00:00.000Z');
        expect(url.searchParams.get('order')).toBe('asc');
    });

    test('a chat id with odd characters is escaped, never pasted', () => {
        const href = jobHistoryHref({ chatId: 'a&view=summaries#x' });
        expect(new URL(href, 'http://x').searchParams.get('chatId')).toBe('a&view=summaries#x');
        expect(new URL(href, 'http://x').searchParams.get('view')).toBeNull();
    });

    test('no history, no link', () => {
        for (const none of [null, undefined, {}, { chatId: '' }, { chatId: '   ' }, { chatId: 42 }]) expect(jobHistoryHref(none)).toBeNull();
    });

    test('a since that is not a date is left out', () => {
        expect(jobHistoryHref({ chatId: 'c1', since: 'yesterday-ish' })).toBe('/system/history?chatId=c1&order=asc');
    });
});
