// Display helpers for Autopilot → Errands. Made-up people and times.
const path = require('path');
const { spawnSync } = require('child_process');
const {
    stateLabel, stateTone, goalLabel, slotText, windowText, slotRows, countsText,
    isOpen, splitErrands, compactDetail, eventLine,
} = require('../src/lib/errands.js');

const ev = (kind, detail) => ({ id: 1, errand_id: 3, at: '2026-10-05T12:00:00.000Z', kind, detail });
const fixedTime = { time: (iso) => iso.slice(11, 16) };

describe('labels', () => {
    test('every state reads in plain English, and an unknown one shows as it is', () => {
        expect(['waiting_contact', 'waiting_owner', 'paused', 'done', 'cancelled', 'expired', 'failed'].map(stateLabel))
            .toEqual(['Waiting for them', 'Waiting for you', 'Paused', 'Done', 'Cancelled', 'Expired', 'Failed']);
        expect(stateLabel('snoozed')).toBe('snoozed');
        expect(stateLabel(undefined)).toBe('Unknown');
        expect(stateLabel('constructor')).toBe('constructor');
    });

    test('a state tone is a set of classes; unknown states get the plain one', () => {
        expect(stateTone('waiting_owner')).toMatch(/text-amber/);
        expect(stateTone('failed')).toMatch(/text-red/);
        expect(stateTone('toString')).toBe(stateTone('snoozed'));
        expect(stateTone('snoozed')).toMatch(/^bg-\S+ text-\S+ border-\S+$/);
    });

    test('goals', () => {
        expect([goalLabel('book'), goalLabel('ask'), goalLabel('tell')]).toEqual(['Book a slot', 'Ask', 'Pass on a message']);
        expect(goalLabel(null)).toBe('Errand');
    });
});

describe('slots', () => {
    test('a slot reads as weekday, day/month and time', () => {
        expect(slotText({ date: '2026-10-08', time: '10:00' })).toBe('Thu 08/10 10:00');
        expect(slotText({ date: '2026-10-08', time: '9:05' })).toBe('Thu 08/10 09:05');
        expect(slotText({ date: '2026-10-11', time: null })).toBe('Sun 11/10');
        expect(slotText(null)).toBe('');
        expect(slotText({})).toBe('');
    });

    test('the weekday does not move with the browser\'s time zone', () => {
        // Midnight UTC on 2026-10-08 is still Wednesday west of Greenwich, so
        // a date read in UTC but shown in local time lands on the wrong day.
        // Jest cannot switch its own time zone: run the helper in child
        // processes, west and east of UTC.
        const lib = path.join(__dirname, '../src/lib/errands.js');
        const code = 'import(process.argv[1]).then((m) => process.stdout.write(JSON.stringify(['
            + '["2026-10-08", "00:30"], ["2026-12-31", "23:59"], ["2027-01-01", "00:00"]'
            + '].map(([date, time]) => m.slotText({ date, time })))))';
        for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
            const out = spawnSync(process.execPath, ['--no-warnings', '-e', code, lib], { env: { PATH: process.env.PATH, TZ: tz }, encoding: 'utf8' });
            expect({ tz, err: out.stderr, lines: JSON.parse(out.stdout || 'null') })
                .toEqual({ tz, err: '', lines: ['Thu 08/10 00:30', 'Thu 31/12 23:59', 'Fri 01/01 00:00'] });
        }
    });

    test('a date that does not exist is shown as written, never as another day', () => {
        expect(slotText({ date: '2026-02-30', time: '10:00' })).toBe('2026-02-30 10:00');
        expect(slotText({ date: 'jueves', time: 'tarde' })).toBe('jueves tarde');
        expect(slotText({ date: '2026-10-08', time: '25:00' })).toBe('Thu 08/10 25:00');
    });

    test('a window on one day, and over two days', () => {
        expect(windowText('2026-10-08T09:00', '2026-10-08T12:00')).toBe('Thu 08/10 09:00-12:00');
        expect(windowText('2026-10-08T17:00', '2026-10-09T10:00')).toBe('Thu 08/10 17:00 to Fri 09/10 10:00');
    });

    test('a card shows what he asked for (or his window), their offer and what was booked', () => {
        const base = { id: 3, goal: 'book', slot: { date: '2026-10-08', time: '10:00' }, offer: null, agreed: null, windowStart: null, windowEnd: null };
        expect(slotRows(base)).toEqual([{ label: 'Asked for', text: 'Thu 08/10 10:00' }]);
        expect(slotRows({ ...base, offer: { date: '2026-10-08', time: '11:30' } })).toEqual([
            { label: 'Asked for', text: 'Thu 08/10 10:00' },
            { label: 'Their offer', text: 'Thu 08/10 11:30' },
        ]);
        expect(slotRows({ ...base, agreed: { date: '2026-10-08', time: '10:00' }, eventId: 'evt1' })[1]).toEqual({ label: 'Booked', text: 'Thu 08/10 10:00' });
        expect(slotRows({ ...base, agreed: { date: '2026-10-08', time: '10:00' }, eventId: null })[1].label).toBe('Agreed');
        expect(slotRows({ ...base, slot: { date: '2026-10-08', time: null }, windowStart: '2026-10-08T09:00', windowEnd: '2026-10-08T12:00' }))
            .toEqual([{ label: 'Window', text: 'Thu 08/10 09:00-12:00' }]);
        expect(slotRows({ id: 4, goal: 'ask', slot: null })).toEqual([]);
    });

    test('counts', () => {
        expect(countsText({ sentCount: 3, autoCount: 1 })).toBe('3 messages sent, 1 on its own');
        expect(countsText({ sentCount: 1, autoCount: 0 })).toBe('1 message sent, 0 on its own');
        expect(countsText({ sentCount: 0, autoCount: 0 })).toBe('No messages sent');
    });
});

describe('open and closed', () => {
    test('open until the agent closes it; a closed state counts as closed', () => {
        expect(isOpen({ state: 'waiting_contact', closedAt: null })).toBe(true);
        expect(isOpen({ state: 'waiting_owner' })).toBe(true);
        expect(isOpen({ state: 'paused', closedAt: null })).toBe(true);
        expect(isOpen({ state: 'done', closedAt: '2026-10-05T12:00:00.000Z' })).toBe(false);
        expect(isOpen({ state: 'cancelled', closedAt: null })).toBe(false);
        expect(isOpen({ state: 'waiting_contact', closedAt: '2026-10-05T12:00:00.000Z' })).toBe(false);
        expect(isOpen(null)).toBe(false);
    });

    test('open ones come first, those waiting for him at the top; newest first otherwise', () => {
        const list = [
            { id: 9, state: 'done', closedAt: 'x' },
            { id: 8, state: 'waiting_contact' },
            { id: 7, state: 'cancelled', closedAt: 'x' },
            { id: 6, state: 'waiting_owner' },
            { id: 5, state: 'paused' },
            null,
        ];
        const { open, closed } = splitErrands(list);
        expect(open.map((e) => e.id)).toEqual([6, 8, 5]);
        expect(closed.map((e) => e.id)).toEqual([9, 7]);
        expect(splitErrands(undefined)).toEqual({ open: [], closed: [] });
    });
});

describe('step lines', () => {
    test('the examples', () => {
        expect(eventLine(ev('sent', { parts: [{ text: 'Hola!', id: 'm1', at: 'x' }, { text: 'Tenés turno el jueves a las 10?', id: 'm2', at: 'x' }], auto: false })))
            .toBe('Sent: "Hola! / Tenés turno el jueves a las 10?"');
        expect(eventLine(ev('received', { ts: 1, text: 'Dale, a las 11 puedo', excerpt: 'Dale, a las 11 puedo' })))
            .toBe('They wrote: "Dale, a las 11 puedo"');
        expect(eventLine(ev('read', { kind: 'offer', slots: [{ date: '2026-10-08', time: '10:00' }], summary: 'Alice offers 10:00.' })))
            .toBe('Read as: offer, Thu 08/10 10:00');
        expect(eventLine(ev('booked', { slot: { date: '2026-10-08', time: '10:00' }, title: 'Turno - Alice' })))
            .toBe('Added to the calendar: Thu 08/10 10:00');
        expect(eventLine(ev('closed', { state: 'done' }))).toBe('Closed: done');
    });

    test('a step sent on its own says so', () => {
        expect(eventLine(ev('sent', { parts: [{ text: 'Perfecto, nos vemos' }], auto: true }))).toBe('Sent: "Perfecto, nos vemos" (on its own)');
    });

    test('start, decisions and questions to him', () => {
        expect(eventLine(ev('started', { goal: 'book', mode: 'ask', slot: { date: '2026-10-08', time: '10:00' }, window: null })))
            .toBe('Started: Book a slot, Thu 08/10 10:00');
        expect(eventLine(ev('started', { goal: 'book', mode: 'window', slot: { date: '2026-10-08', time: null }, window: ['2026-10-08T09:00', '2026-10-08T12:00'] })))
            .toBe('Started: Book a slot, any time Thu 08/10 09:00-12:00');
        expect(eventLine(ev('started', { goal: 'tell', mode: 'ask', slot: null, window: null }))).toBe('Started: Pass on a message');
        expect(eventLine(ev('decided', { action: 'accept', step: 'accept', slot: { date: '2026-10-08', time: '10:00' }, auto: true })))
            .toBe('Decided: accept Thu 08/10 10:00 (on its own)');
        expect(eventLine(ev('decided', { action: 'accept', step: 'accept', slot: { date: '2026-10-08', time: '10:00' }, waitsUntil: '2026-10-08T08:00:00.000Z' }), fixedTime))
            .toBe('Decided: accept Thu 08/10 10:00, sends after 08:00');
        expect(eventLine(ev('decided', { action: 'say', step: 'say', slot: {} }))).toBe('Decided: say');
        expect(eventLine(ev('asked', { card: 'c1', slots: [{ date: '2026-10-08', time: '11:00' }, { date: '2026-10-09', time: '10:00' }], offer: { date: '2026-10-08', time: '11:00' } })))
            .toBe('Asked you about Thu 08/10 11:00 (they offered Thu 08/10 11:00, Fri 09/10 10:00)');
        expect(eventLine(ev('asked', { card: 'c1', slots: [{ date: '2026-10-08', time: '11:00' }], offer: { date: '2026-10-08', time: '11:00' } })))
            .toBe('Asked you about Thu 08/10 11:00');
        expect(eventLine(ev('asked', { note: true }))).toBe('Asked you in your chat');
        expect(eventLine(ev('asked', { card: null, why: 'his approval rules ask for it' }))).toBe('Asked you with a card: his approval rules ask for it');
    });

    test('the other known steps', () => {
        expect(eventLine(ev('received', { ts: 1, text: '', excerpt: '', unreadable: true }))).toBe('They sent a voice note Deedee could not read');
        expect(eventLine(ev('read', { failed: true }))).toBe('Could not read their reply');
        expect(eventLine(ev('booked', { slot: { date: '2026-10-08', time: '10:00' }, existing: true }))).toBe('Already on the calendar: Thu 08/10 10:00');
        expect(eventLine(ev('closed', { state: 'cancelled', why: 'owner' }))).toBe('Closed: cancelled (by you)');
        expect(eventLine(ev('closed', { state: 'cancelled', why: 'declined' }))).toBe('Closed: cancelled (declined)');
        expect(eventLine(ev('paused', { why: 'it used its 20 model calls' }))).toBe('Paused: it used its 20 model calls');
        expect(eventLine(ev('refused', { step: 'accept', problems: ['it had a link', 'it asked a new question'] })))
            .toBe('Held back a message: it had a link; it asked a new question');
        expect(eventLine(ev('refused', { step: 'say', dryRun: true, text: 'Nos vemos el jueves' }))).toBe('Dry run, not sent: "Nos vemos el jueves"');
        expect(eventLine(ev('error', { step: 'book', error: 'calendar unavailable' }))).toBe('Error (book): calendar unavailable');
        expect(eventLine(ev('error', { step: 'send', sent: 1, of: 2 }))).toBe('Error (send): WhatsApp took 1 of 2 parts');
        expect(eventLine(ev('note', { noReply: true }))).toBe('Told you they have not answered yet');
        expect(eventLine(ev('owner', { card: 'c1', status: 'denied' }))).toBe('You said no on the card');
        expect(eventLine(ev('owner', { card: 'c1', status: 'expired' }))).toBe('The card expired with no answer');
    });

    test('a paused errand he answers, news while it is paused, and a step a note dropped', () => {
        expect(eventLine(ev('resumed', { by: 'owner' }))).toBe('You answered, so it goes on');
        expect(eventLine(ev('note', { pausedNews: true }))).toBe('Told you they wrote while it was paused');
        expect(eventLine(ev('asked', { note: true, dropped: 'accept' }))).toBe('Asked you in your chat; accept did not go out');
    });

    test('an unknown step, or a known step with an odd detail, is one short key: value line', () => {
        expect(eventLine(ev('rescheduled', { from: { date: '2026-10-08', time: '10:00' }, to: { date: '2026-10-09', time: '10:00' }, tries: 2, ok: true })))
            .toBe('rescheduled: from: Thu 08/10 10:00, to: Fri 09/10 10:00, tries: 2, ok: true');
        expect(eventLine(ev('note', { text: 'checked the chat' }))).toBe('note: text: checked the chat');
        expect(eventLine(ev('sent', { count: 2 }))).toBe('sent: count: 2');
        expect(eventLine(ev('mystery', null))).toBe('mystery');
        expect(eventLine(ev('mystery', 'a plain string'))).toBe('mystery: a plain string');
        expect(eventLine({})).toBe('note');
    });

    test('a huge detail never comes out whole', () => {
        const nested = { deep: { deeper: { deepest: 'x'.repeat(5000) } } };
        const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'y'.repeat(500)]));
        const one = eventLine(ev('mystery', nested));
        expect(one).toBe('mystery: deep: …');
        const line = eventLine(ev('mystery', big));
        expect(line.length).toBeLessThanOrEqual(180);
        expect(line.endsWith('…')).toBe(true);
        expect(compactDetail({ truncated: 'z'.repeat(3900) }).length).toBeLessThanOrEqual(160);
        expect(compactDetail({ list: [1, 2, 3], none: [], objs: [{ a: 1 }, { b: 2 }] })).toBe('list: 1, 2, 3, none: none, objs: 2 items');
        expect(eventLine(ev('received', { excerpt: 'z'.repeat(1000) })).length).toBeLessThanOrEqual(320);
    });
});

describe('eventLine: steps added in review', () => {
    test('a step that waited for new words, a message after the booking, and a note of news read as plain lines', () => {
        expect(eventLine({ kind: 'decided', detail: { action: 'accept', deferred: true } })).toBe('Waited: they wrote again before accept went out');
        expect(eventLine({ kind: 'after', detail: { kind: 'offer', slots: [{ date: '2026-10-08', time: '11:00' }] } })).toBe('After the booking: offer, Thu 08/10 11:00');
        expect(eventLine({ kind: 'after', detail: { failed: true } })).toBe('After the booking: could not read their message');
        expect(eventLine({ kind: 'note', detail: { told: true } })).toBe('Told you what else they wrote');
    });
});

describe('eventLine: the message check', () => {
    test('a check that passed, one that held the words, and one that could not run read as plain lines', () => {
        expect(eventLine(ev('checked', { ok: true, reason: 'fine', failed: false, step: 'thanks' }))).toBe('Checked the message (thanks): fine');
        expect(eventLine(ev('checked', { ok: false, reason: 'It also cancels the slot.', failed: false, step: 'accept' })))
            .toBe('The check held the message (accept), so it asked you first: It also cancels the slot.');
        expect(eventLine(ev('checked', { ok: false, reason: '', failed: true, step: 'request' }))).toBe('Could not check the message (request), so it asked you first');
        expect(eventLine(ev('checked', { ok: false }))).toBe('The check held the message, so it asked you first');
    });

    test('a held reason from the model is cut short, never shown whole', () => {
        const line = eventLine(ev('checked', { ok: false, reason: 'r'.repeat(2000), failed: false, step: 'say' }));
        expect(line.length).toBeLessThanOrEqual(240);
        expect(line.endsWith('…')).toBe(true);
    });
});
