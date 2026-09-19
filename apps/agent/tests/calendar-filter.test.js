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

    describe('the calendar that was read decides, not who organised the event', () => {
        // Google puts the INVITER in organizer.email, not the calendar's id.
        // Going by it dropped every meeting someone else organised from the
        // owner's own calendar, so the briefing never listed them.
        const invited = (summary, from) => ({ ...makeEvent(summary, from, false), attendees: [{ email: 'user@gmail.com', self: true }, { email: from }] });
        const settings = { 'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com', 'trips@group.calendar.google.com'] } };
        const list = (calendarId) => ({ resource: 'events', method: 'list', params: { calendarId, timeMin: 'a', timeMax: 'b' } });
        // Every real config names the account; its address is the id of `primary`.
        const mcpConfig = { gws_personal: { env: { GOOGLE_WORKSPACE_CLI_ACCOUNT: 'user@gmail.com' } } };

        test('a meeting a client organised stays on his own calendar', () => {
            const events = [makeEvent('Mine', 'user@gmail.com', true), invited('Client review', 'someone@client.example'), invited('Dinner', 'friend@example.com')];
            const result = makeEventResponse(events);
            for (const id of ['user@gmail.com', 'primary', 'USER@gmail.com']) {
                expect(filterCalendarResult('personal_calendar', result, settings, toolMap, list(id), mcpConfig)).toBe(result);
            }
            // params may arrive as a JSON string.
            expect(filterCalendarResult('personal_calendar', result, settings, toolMap, { resource: 'events', method: 'list', params: JSON.stringify({ calendarId: 'primary' }) }, mcpConfig)).toBe(result);
        });

        test('a calendar that is not on the list shows nothing, whoever organised', () => {
            const events = [invited('Their 1:1', 'user@gmail.com'), makeEvent('Their lunch', 'colleague@work.example')];
            const out = JSON.parse(filterCalendarResult('personal_calendar', makeEventResponse(events), settings, toolMap, list('colleague@work.example'), mcpConfig).output);
            expect(out.items).toEqual([]);
        });

        test('with no calendar to go by, an event he is invited to is his', () => {
            const events = [invited('Client review', 'someone@client.example'), makeEvent('A stranger\'s event', 'other@example.com'), makeEvent('Flight', 'trips@group.calendar.google.com')];
            const out = JSON.parse(filterCalendarResult('personal_calendar', makeEventResponse(events), settings, toolMap, undefined, mcpConfig).output);
            expect(out.items.map(e => e.summary)).toEqual(['Client review', 'Flight']);
        });

        test('primary-only mode keeps what he is invited to, and still hides the rest', () => {
            const events = [makeEvent('Mine', 'user@gmail.com', true), invited('Client review', 'someone@client.example'), makeEvent('Not his', 'family@group.calendar.google.com')];
            const out = JSON.parse(filterCalendarResult('personal_calendar', makeEventResponse(events), {}, toolMap, list('someone-else@example.com'), mcpConfig).output);
            expect(out.items.map(e => e.summary)).toEqual(['Mine', 'Client review']);
            expect(filterCalendarResult('personal_calendar', makeEventResponse(events), {}, toolMap, list('primary'), mcpConfig).output).toContain('Not his');
        });
    });

    describe('`primary` is a nickname, not a way round the list', () => {
        // Review finding: with only a shared calendar ticked, a call that said
        // calendarId 'primary' (the briefing's prompt does) showed his whole
        // own calendar again. The account's address is that calendar's id.
        const mcpConfig = { gws_personal: { env: { GOOGLE_WORKSPACE_CLI_ACCOUNT: 'User@gmail.com' } } };
        const onlyTrips = { 'gws_calendar_filter:personal': { calendarIds: ['trips@group.calendar.google.com'] } };
        const withPrimary = { 'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com', 'trips@group.calendar.google.com'] } };
        const list = (calendarId) => ({ resource: 'events', method: 'list', params: { calendarId } });
        const invited = (summary, from) => ({ ...makeEvent(summary, from, false), attendees: [{ email: 'user@gmail.com', self: true }] });
        const events = [makeEvent('Private appointment', 'user@gmail.com', true), invited('Review', 'boss@work.example'), makeEvent('Flight', 'trips@group.calendar.google.com')];
        const kept = (settings, args, config = mcpConfig) => JSON.parse(filterCalendarResult('personal_calendar', makeEventResponse(events), settings, toolMap, args, config).output).items.map(e => e.summary);

        test('an unticked primary calendar stays hidden, by nickname and by address', () => {
            expect(kept(onlyTrips, list('primary'))).toEqual([]);
            expect(kept(onlyTrips, list('user@gmail.com'))).toEqual([]);
            // With no calendar named, his own events follow primary; the ticked shared calendar shows.
            expect(kept(onlyTrips, undefined)).toEqual(['Flight']);
        });

        test('a ticked primary calendar shows everything on it, invitations too', () => {
            const result = makeEventResponse(events);
            expect(filterCalendarResult('personal_calendar', result, withPrimary, toolMap, list('primary'), mcpConfig)).toBe(result);
            expect(filterCalendarResult('personal_calendar', result, withPrimary, toolMap, list('user@gmail.com'), mcpConfig)).toBe(result);
        });

        test('an account we cannot name keeps primary hidden under a list: no guessing', () => {
            // A guess from the list let a ticked colleague's address open his whole calendar.
            expect(kept(withPrimary, list('primary'), null)).toEqual([]);
            expect(kept({ 'gws_calendar_filter:personal': { calendarIds: ['colleague@work.example'] } }, list('primary'), null)).toEqual([]);
            // Read by its address, a ticked calendar still shows.
            expect(kept(withPrimary, list('user@gmail.com'), null)).toEqual(['Private appointment', 'Review', 'Flight']);
        });

        test('an event he made on a ticked shared calendar shows, even when primary is unticked', () => {
            const onShared = { ...makeEvent('Packing list', 'trips@group.calendar.google.com'), creator: { email: 'user@gmail.com', self: true } };
            const out = JSON.parse(filterCalendarResult('personal_calendar', makeEventResponse([onShared, events[0]]), onlyTrips, toolMap, undefined, mcpConfig).output);
            expect(out.items.map(e => e.summary)).toEqual(['Packing list']);
        });

        test('with no list at all, primary is his, as before', () => {
            const result = makeEventResponse(events);
            expect(filterCalendarResult('personal_calendar', result, {}, toolMap, list('primary'), mcpConfig)).toBe(result);
            expect(filterCalendarResult('personal_calendar', result, {}, toolMap, list('user@gmail.com'), mcpConfig)).toBe(result);
        });
    });

    describe('one event, and free/busy, follow the same list', () => {
        const settings = { 'gws_calendar_filter:personal': { calendarIds: ['user@gmail.com'] } };
        const mcpConfig = { gws_personal: { env: { GOOGLE_WORKSPACE_CLI_ACCOUNT: 'user@gmail.com' } } };

        test('events.get on a hidden calendar returns no event', () => {
            const event = { kind: 'calendar#event', ...makeEvent('Their 1:1', 'colleague@work.example') };
            const out = JSON.parse(filterCalendarResult('personal_calendar', { output: JSON.stringify(event) }, settings, toolMap,
                { resource: 'events', method: 'get', params: { calendarId: 'colleague@work.example', eventId: 'e1' } }, mcpConfig).output);
            expect(out).toEqual({ error: 'That event is on a calendar the owner has not made visible.' });
            const own = { output: JSON.stringify(event) };
            expect(filterCalendarResult('personal_calendar', own, settings, toolMap, { resource: 'events', method: 'get', params: { calendarId: 'primary', eventId: 'e1' } }, mcpConfig)).toBe(own);
        });

        test('the result of creating or changing an event is never turned into an error', () => {
            // A hidden calendar, or primary-only mode with another id: Google
            // DID create the event. An error here made the model create it again.
            const created = { output: JSON.stringify({ kind: 'calendar#event', ...makeEvent('Planning', 'colleague@work.example') }) };
            for (const method of ['insert', 'patch', 'update', 'quickAdd', 'move', 'import']) {
                expect(filterCalendarResult('personal_calendar', created, settings, toolMap, { resource: 'events', method, params: { calendarId: 'colleague@work.example' } }, mcpConfig)).toBe(created);
                expect(filterCalendarResult('personal_calendar', created, {}, toolMap, { resource: 'events', method, params: { calendarId: 'colleague@work.example' } }, mcpConfig)).toBe(created);
            }
        });

        test('free/busy is left as it comes: busy blocks only, and the question it exists for', () => {
            const body = { output: JSON.stringify({ kind: 'calendar#freeBusy', calendars: { 'user@gmail.com': { busy: [{ start: 'a', end: 'b' }] }, 'colleague@work.example': { busy: [{ start: 'c', end: 'd' }] } } }) };
            expect(filterCalendarResult('personal_calendar', body, settings, toolMap, { resource: 'freebusy', method: 'query' }, mcpConfig)).toBe(body);
            expect(filterCalendarResult('personal_calendar', body, {}, toolMap, { resource: 'freebusy', method: 'query' }, mcpConfig)).toBe(body);
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
