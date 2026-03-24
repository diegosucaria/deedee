const { filterCalendarResult } = require('../src/utils/calendar-filter');

// --- Fixtures ---

const makeCalendarListResponse = (calendars) => ({
    output: JSON.stringify({
        kind: 'calendar#calendarList',
        items: calendars,
    })
});

const makeCalendar = (id, summary, primary = false) => ({
    id,
    summary,
    primary,
    accessRole: 'owner',
    backgroundColor: '#4285f4',
    selected: true,
});

const makeEventResponse = (events) => ({
    output: JSON.stringify({
        kind: 'calendar#events',
        timeZone: 'America/Argentina/Cordoba',
        items: events,
    })
});

const makeEvent = (summary, organizerEmail, self = false) => ({
    summary,
    start: { dateTime: '2026-03-24T10:00:00-03:00' },
    end: { dateTime: '2026-03-24T11:00:00-03:00' },
    organizer: { email: organizerEmail, self },
    status: 'confirmed',
});

const buildToolMap = (toolName, serverName) => {
    const map = new Map();
    map.set(toolName, { name: serverName, client: {}, originalName: 'calendar' });
    return map;
};

// --- Tests ---

describe('filterCalendarResult', () => {
    const toolMap = buildToolMap('personal_calendar', 'gws_personal');

    describe('quick exits', () => {
        test('returns result unchanged for non-calendar tools', () => {
            const result = { output: '{"items":[]}' };
            expect(filterCalendarResult('personal_gmail', result, {}, toolMap)).toBe(result);
        });

        test('returns result unchanged if toolName is null', () => {
            const result = { output: '{}' };
            expect(filterCalendarResult(null, result, {}, toolMap)).toBe(result);
        });

        test('returns result unchanged if result is null', () => {
            expect(filterCalendarResult('personal_calendar', null, {}, toolMap)).toBeNull();
        });

        test('returns result unchanged for non-GWS calendar tools', () => {
            const nonGwsMap = buildToolMap('local_calendar', 'local_server');
            const result = makeCalendarListResponse([makeCalendar('a', 'A')]);
            expect(filterCalendarResult('local_calendar', result, {}, nonGwsMap)).toBe(result);
        });

        test('returns result unchanged if output is not a string', () => {
            const result = { data: 'not-json-output' };
            expect(filterCalendarResult('personal_calendar', result, {}, toolMap)).toBe(result);
        });
    });

    describe('calendarList.list filtering', () => {
        const allCalendars = [
            makeCalendar('user@gmail.com', 'Primary Calendar', true),
            makeCalendar('family@group.calendar.google.com', 'Family'),
            makeCalendar('dj@group.calendar.google.com', 'DJ Sets'),
            makeCalendar('holidays@google.com', 'Holidays'),
            makeCalendar('work@group.calendar.google.com', 'Work Projects'),
        ];

        test('defaults to primary-only when no filter configured', () => {
            const result = makeCalendarListResponse(allCalendars);
            const filtered = filterCalendarResult('personal_calendar', result, {}, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].id).toBe('user@gmail.com');
            expect(parsed.items[0].primary).toBe(true);
        });

        test('defaults to primary-only when filter has empty calendarIds', () => {
            const settings = { 'gws_calendar_filter:personal': { calendarIds: [] } };
            const result = makeCalendarListResponse(allCalendars);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(1);
            expect(parsed.items[0].primary).toBe(true);
        });

        test('filters to configured calendar IDs', () => {
            const settings = {
                'gws_calendar_filter:personal': {
                    calendarIds: ['user@gmail.com', 'work@group.calendar.google.com']
                }
            };
            const result = makeCalendarListResponse(allCalendars);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(2);
            expect(parsed.items.map(c => c.id)).toEqual([
                'user@gmail.com',
                'work@group.calendar.google.com'
            ]);
        });

        test('preserves kind field in response', () => {
            const settings = {
                'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com'] }
            };
            const result = makeCalendarListResponse(allCalendars);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.kind).toBe('calendar#calendarList');
        });

        test('returns original result when all calendars match filter', () => {
            const twoCalendars = [
                makeCalendar('a@gmail.com', 'A', true),
                makeCalendar('b@gmail.com', 'B'),
            ];
            const settings = {
                'gws_calendar_filter:personal': { calendarIds: ['a@gmail.com', 'b@gmail.com'] }
            };
            const result = makeCalendarListResponse(twoCalendars);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            // Should return the same object reference (no filtering needed)
            expect(filtered).toBe(result);
        });
    });

    describe('events filtering with allowlist', () => {
        test('filters events by organizer email', () => {
            const settings = {
                'gws_calendar_filter:personal': {
                    calendarIds: ['user@gmail.com', 'work@group.calendar.google.com']
                }
            };
            const events = [
                makeEvent('Meeting', 'user@gmail.com', true),
                makeEvent('Family Dinner', 'family@group.calendar.google.com'),
                makeEvent('Sprint Planning', 'work@group.calendar.google.com'),
                makeEvent('DJ Gig', 'dj@group.calendar.google.com'),
            ];
            const result = makeEventResponse(events);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(2);
            expect(parsed.items.map(e => e.summary)).toEqual(['Meeting', 'Sprint Planning']);
        });

        test('keeps events with no organizer email (safety fallback)', () => {
            const settings = {
                'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com'] }
            };
            const events = [
                makeEvent('Known Event', 'user@gmail.com'),
                { summary: 'Mystery Event', start: { dateTime: '2026-03-24T10:00:00-03:00' }, end: { dateTime: '2026-03-24T11:00:00-03:00' } },
            ];
            const result = makeEventResponse(events);
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(2); // both kept
        });
    });

    describe('primary-only mode for events', () => {
        test('keeps only events where organizer.self is true', () => {
            const events = [
                makeEvent('My Event', 'user@gmail.com', true),
                makeEvent('Other Event', 'family@group.calendar.google.com', false),
                makeEvent('Another Mine', 'user@gmail.com', true),
            ];
            const result = makeEventResponse(events);
            const filtered = filterCalendarResult('personal_calendar', result, {}, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(2);
            expect(parsed.items.map(e => e.summary)).toEqual(['My Event', 'Another Mine']);
        });
    });

    describe('multi-account support', () => {
        test('applies correct filter per GWS account', () => {
            const workMap = buildToolMap('work_calendar', 'gws_work');
            const settings = {
                'gws_calendar_filter:personal': { calendarIds: ['personal@gmail.com'] },
                'gws_calendar_filter:work': { calendarIds: ['work@company.com', 'team@company.com'] },
            };

            const calendars = [
                makeCalendar('work@company.com', 'Work', true),
                makeCalendar('team@company.com', 'Team'),
                makeCalendar('social@company.com', 'Social'),
            ];
            const result = makeCalendarListResponse(calendars);
            const filtered = filterCalendarResult('work_calendar', result, settings, workMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed.items).toHaveLength(2);
            expect(parsed.items.map(c => c.id)).toEqual(['work@company.com', 'team@company.com']);
        });
    });

    describe('invalid/malformed data', () => {
        test('returns original result for unparseable JSON', () => {
            const result = { output: 'not-json' };
            const returned = filterCalendarResult('personal_calendar', result, {}, toolMap);
            expect(returned).toBe(result);
        });

        test('returns original result for response without items', () => {
            const result = { output: JSON.stringify({ kind: 'calendar#calendarList' }) };
            const returned = filterCalendarResult('personal_calendar', result, {}, toolMap);
            // No items array → filterParsed returns obj unchanged → same reference
            expect(returned).toBe(result);
        });

        test('handles top-level array of events', () => {
            const settings = {
                'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com'] }
            };
            const events = [
                makeEvent('Keep', 'user@gmail.com'),
                makeEvent('Drop', 'other@gmail.com'),
            ];
            const result = { output: JSON.stringify(events) };
            const filtered = filterCalendarResult('personal_calendar', result, settings, toolMap);

            const parsed = JSON.parse(filtered.output);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].summary).toBe('Keep');
        });
    });
});
