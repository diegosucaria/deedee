const { sanitizeToolResult, sanitizeToolArgs, isHighCapTool, MAX_TOOL_RESULT_CHARS, MAX_EMAIL_BODY_CHARS, MAX_EVENT_DESCRIPTION_CHARS, MAX_DOC_TEXT_CHARS, DEFAULT_CALENDAR_WINDOW_DAYS } = require('../src/utils/tool-result-sanitizer');
const fs = require('fs');
const path = require('path');

// --- Fixtures ---

// Simulates a raw Google Calendar events list response (like the work_calendar from production logs)
const makeCalendarEvent = ({
    id = '7s8309nv',
    summary = 'Tech Q&A weekly',
    location,
    description,
    numAttendees = 15,
    hasAttachments = false,
    hasConference = false,
} = {}) => {
    const event = {
        attachments: hasAttachments ? [
            { fileUrl: 'https://mail.google.com/?view=att&th=18ad29c7ab1391ed&attid=0.1', iconLink: '', title: 'image005.png' },
            { fileUrl: 'https://mail.google.com/?view=att&th=18ad29c7ab1391ed&attid=0.2', iconLink: '', title: 'image006.png' },
        ] : undefined,
        attendees: Array.from({ length: numAttendees }, (_, i) => ({
            displayName: `Person ${i}`,
            email: `person${i}@company.com`,
            responseStatus: 'needsAction',
            ...(i === 0 ? { organizer: true } : {}),
            ...(i === 1 ? { self: true, optional: true } : {}),
        })),
        created: '2026-01-15T10:00:00.000Z',
        creator: { email: 'organizer@company.com', displayName: 'Organizer' },
        description: description || 'Weekly sync meeting for the team',
        end: { dateTime: '2026-03-11T08:00:00-03:00', timeZone: 'America/Argentina/Cordoba' },
        etag: '"p32vpvanfiac960o"',
        eventType: 'default',
        guestsCanInviteOthers: true,
        htmlLink: 'https://www.google.com/calendar/event?eid=dTVyczkxYXQ1Mmd1MTB2MWt1MjhwZGJyMHMgZGllZ29zdWNhcmlhQG0',
        iCalUID: '7s8309nvstrp060hqvddnmts1a@google.com',
        id,
        kind: 'calendar#event',
        organizer: { email: 'organizer@company.com' },
        reminders: { useDefault: true },
        sequence: 0,
        start: { dateTime: '2026-03-11T07:00:00-03:00', timeZone: 'America/Argentina/Cordoba' },
        status: 'confirmed',
        summary,
        updated: '2026-03-11T15:12:49.122Z',
        visibility: 'default',
        transparency: 'opaque',
    };
    if (location) event.location = location;
    if (hasConference) {
        event.conferenceData = {
            entryPoints: [
                { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
                { entryPointType: 'phone', uri: 'tel:+1234567890' },
            ]
        };
    }
    return event;
};

const makeCalendarResponse = (events = []) => ({
    accessRole: 'owner',
    defaultReminders: [{ method: 'popup', minutes: 10 }],
    description: '',
    etag: '"p32vpvanfiac960o"',
    items: events,
    kind: 'calendar#events',
    nextSyncToken: 'CL-fqu-SmJMDEL-fqu-SmJMDGAUgkty-owMokty-owM=',
    summary: 'user@company.com',
    timeZone: 'America/Argentina/Cordoba',
    updated: '2026-03-11T15:20:43.009Z',
});

// Simulates a raw Gmail API message (like the Booking.com email from production logs)
const makeGmailMessage = ({ id = '19cda31b', subject = 'Rate Awwa Suites', from = 'noreply@booking.com', bodyHtml, bodyPlain, snippet = 'How was your stay?' } = {}) => ({
    id,
    threadId: id,
    labelIds: ['UNREAD', 'INBOX'],
    snippet,
    payload: {
        headers: [
            { name: 'From', value: `"Booking.com" <${from}>` },
            { name: 'To', value: 'user@gmail.com' },
            { name: 'Subject', value: subject },
            { name: 'Date', value: 'Wed, 11 Mar 2026 00:00:00 +0000' },
            { name: 'Reply-To', value: from },
            // These should be stripped:
            { name: 'DKIM-Signature', value: 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=booking.com; s=s1; bh=B/pJp+ZTT4L1rJJkRtsRATqbXYdHorlU5kKWKfDoEck=; b=FJfHyEe4UF748kpRaaxABGigTM9mihynt5SrgMn16fQ...' },
            { name: 'ARC-Seal', value: 'i=1; a=rsa-sha256; t=1773187216; cv=none; d=google.com; s=arc-20240605; b=jnzkAqh+8ZsZSZ9+oWs1FRXniqeEyJaT...' },
            { name: 'ARC-Message-Signature', value: 'i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605;...' },
            { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; dkim=pass header.i=@booking.com...' },
            { name: 'Received-SPF', value: 'pass (google.com: domain of bounces+847312...' },
            { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@booking.com...' },
            { name: 'Return-Path', value: '<bounces+847312@sg.booking.com>' },
            { name: 'X-SG-EID', value: 'u001.bvUsTs6oSq3fe2HVoV7d...' },
            { name: 'X-SG-ID', value: 'u001.SdBcvi+Evd/bQef8eZF3Bp...' },
            { name: 'X-Entity-ID', value: 'u001.7BCpTv/gMtSKQvAXQs+e6g==' },
        ],
        mimeType: bodyPlain && bodyHtml ? 'multipart/alternative' : 'text/html',
        ...(bodyPlain && bodyHtml ? {
            parts: [
                { mimeType: 'text/plain', body: { data: Buffer.from(bodyPlain).toString('base64') } },
                { mimeType: 'text/html', body: { data: Buffer.from(bodyHtml).toString('base64') } },
            ]
        } : {
            body: { data: Buffer.from(bodyHtml || bodyPlain || '').toString('base64') }
        }),
    },
    sizeEstimate: 45000,
});

// --- Tests ---

describe('Tool Result Sanitizer', () => {
    describe('Gmail-specific sanitization (Layer 1)', () => {
        it('should strip DKIM/ARC/SPF headers and keep only useful ones', () => {
            const message = makeGmailMessage({ bodyPlain: 'Hello!', bodyHtml: '<p>Hello!</p>' });
            const result = { output: JSON.stringify(message) };

            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.from).toBe('"Booking.com" <noreply@booking.com>');
            expect(parsed.to).toBe('user@gmail.com');
            expect(parsed.subject).toBe('Rate Awwa Suites');
            expect(parsed.date).toBe('Wed, 11 Mar 2026 00:00:00 +0000');

            // Raw payload should be gone
            expect(parsed.payload).toBeUndefined();
            // DKIM etc should be gone
            expect(JSON.stringify(parsed)).not.toContain('DKIM');
            expect(JSON.stringify(parsed)).not.toContain('ARC-Seal');
            expect(JSON.stringify(parsed)).not.toContain('X-SG-EID');
        });

        it('should decode base64url body and prefer text/plain', () => {
            const result = { output: JSON.stringify(makeGmailMessage({
                bodyPlain: 'Hola suca, como estas? Ttenemos que hacer una infra independiente.',
                bodyHtml: '<div style="font-family:tahoma"><b>Hola</b> suca, como estas?</div>',
            })) };

            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.body).toContain('Hola suca, como estas?');
            expect(parsed.body).toContain('infra independiente');
            // Should NOT contain HTML tags (it used text/plain)
            expect(parsed.body).not.toContain('<div');
        });

        it('should fall back to stripped HTML when no text/plain part', () => {
            const htmlOnly = makeGmailMessage({
                bodyHtml: '<html><head><style>body { color: red; }</style></head><body><p>Hello Diego!</p><br><p>Your booking is confirmed.</p></body></html>',
            });
            // Force single-part HTML
            htmlOnly.payload.mimeType = 'text/html';
            delete htmlOnly.payload.parts;
            htmlOnly.payload.body = { data: Buffer.from('<html><head><style>body { color: red; }</style></head><body><p>Hello Diego!</p><br><p>Your booking is confirmed.</p></body></html>').toString('base64') };

            const result = { output: JSON.stringify(htmlOnly) };
            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.body).toContain('Hello Diego!');
            expect(parsed.body).toContain('booking is confirmed');
            expect(parsed.body).not.toContain('<style');
            expect(parsed.body).not.toContain('<p>');
            expect(parsed.body).not.toContain('color: red');
        });

        it('should truncate very long email bodies', () => {
            const longBody = 'A'.repeat(10000);
            const result = { output: JSON.stringify(makeGmailMessage({ bodyPlain: longBody, bodyHtml: `<p>${longBody}</p>` })) };

            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.body.length).toBeLessThanOrEqual(MAX_EMAIL_BODY_CHARS + 20); // +20 for truncation marker
            expect(parsed.body).toContain('[truncated]');
        });

        it('should preserve id, threadId, labelIds, and snippet', () => {
            const result = { output: JSON.stringify(makeGmailMessage({ id: 'abc123', snippet: 'test snippet' })) };
            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.id).toBe('abc123');
            expect(parsed.threadId).toBe('abc123');
            expect(parsed.labelIds).toEqual(['UNREAD', 'INBOX']);
            expect(parsed.snippet).toBe('test snippet');
        });

        it('should handle work_gmail tool names', () => {
            const result = { output: JSON.stringify(makeGmailMessage({ subject: 'Work email' })) };
            const cleaned = sanitizeToolResult('work_gmail_messages_get', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.subject).toBe('Work email');
            expect(parsed.payload).toBeUndefined();
        });

        it('should handle malformed/missing body data gracefully', () => {
            const noBody = { id: 'x', payload: { headers: [{ name: 'Subject', value: 'Empty' }], body: {} } };
            const result = { output: JSON.stringify(noBody) };

            const cleaned = sanitizeToolResult('personal_gmail', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.subject).toBe('Empty');
            expect(parsed.body).toBe('');
        });
    });

    describe('Generic size cap (Layer 2)', () => {
        it('should pass through small results unchanged', () => {
            const small = { output: 'hello world' };
            const cleaned = sanitizeToolResult('readSlackHistory', small);
            expect(cleaned).toEqual(small);
        });

        it('should truncate results exceeding the cap', () => {
            const huge = { output: 'X'.repeat(80000) };
            const cleaned = sanitizeToolResult('readSlackHistory', huge);

            const serialized = JSON.stringify(cleaned);
            expect(serialized.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 300); // some overhead for wrapper + hint
            expect(cleaned._sanitizer).toBeDefined();
            expect(cleaned._sanitizer.truncated).toBe(true);
            expect(cleaned._sanitizer.originalChars).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
        });

        it('should log a warning when truncating', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const huge = { output: 'X'.repeat(80000) };

            sanitizeToolResult('someHugeTool', huge);

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[Sanitizer] ⚠️ Tool "someHugeTool" result TRUNCATED')
            );
            warnSpy.mockRestore();
        });

        it('should not truncate results under the cap', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const ok = { output: 'X'.repeat(1000) };

            const cleaned = sanitizeToolResult('readSlackHistory', ok);
            expect(cleaned).toEqual(ok);
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('should apply high cap for people tools', () => {
            // A result between 50K and 200K should NOT be truncated for people tools
            const big = { output: 'X'.repeat(100_000) };

            const cleaned1 = sanitizeToolResult('listPeople', big);
            expect(cleaned1._sanitizer).toBeUndefined();

            const cleaned2 = sanitizeToolResult('getPerson', big);
            expect(cleaned2._sanitizer).toBeUndefined();

            // Non-people tool SHOULD be truncated at 50K
            const cleaned3 = sanitizeToolResult('readSlackHistory', big);
            expect(cleaned3._sanitizer).toBeDefined();
            expect(cleaned3._sanitizer.truncated).toBe(true);
        });
    });

    describe('Non-Gmail tools', () => {
        it('should pass through non-Gmail results without modification (under cap)', () => {
            const slackResult = { messages: [{ text: 'hello', user: 'U123' }] };
            const cleaned = sanitizeToolResult('readSlackHistory', slackResult);
            expect(cleaned).toEqual(slackResult);
        });

        it('should handle null/undefined results', () => {
            expect(sanitizeToolResult('any_tool', null)).toBeNull();
            expect(sanitizeToolResult('any_tool', undefined)).toBeUndefined();
        });

        it('should handle string results', () => {
            const cleaned = sanitizeToolResult('some_tool', 'just a string');
            expect(cleaned).toBe('just a string');
        });
    });

    describe('Calendar-specific sanitization (Layer 1b)', () => {
        it('should strip etag, iCalUID, htmlLink, creator, kind, sequence, updated, reminders', () => {
            const response = makeCalendarResponse([makeCalendarEvent()]);
            const result = { output: JSON.stringify(response) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.items).toHaveLength(1);
            const event = parsed.items[0];
            expect(event.summary).toBe('Tech Q&A weekly');
            expect(event.start).toBe('2026-03-11T07:00:00-03:00');
            expect(event.end).toBe('2026-03-11T08:00:00-03:00');
            // 'confirmed' status is omitted (default)
            expect(event.status).toBeUndefined();

            // Bloat should be gone
            const str = JSON.stringify(parsed);
            expect(str).not.toContain('etag');
            expect(str).not.toContain('iCalUID');
            expect(str).not.toContain('htmlLink');
            expect(str).not.toContain('creator');
            expect(str).not.toContain('sequence');
            expect(str).not.toContain('reminders');
            expect(str).not.toContain('guestsCanInviteOthers');
            expect(str).not.toContain('eventType');
            expect(str).not.toContain('nextSyncToken');
            expect(str).not.toContain('accessRole');
        });

        it('should keep attendees with name, email, responseStatus, and flags', () => {
            const event = makeCalendarEvent({ numAttendees: 3 });
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('personal_calendar', result);
            const parsed = JSON.parse(cleaned.output);
            const attendees = parsed.items[0].attendees;

            expect(attendees).toHaveLength(3);
            expect(attendees[0]).toEqual({ name: 'Person 0', email: 'person0@company.com', organizer: true, responseStatus: 'needsAction' });
            expect(attendees[1]).toEqual({ name: 'Person 1', email: 'person1@company.com', self: true, optional: true, responseStatus: 'needsAction' });
            expect(attendees[2]).toEqual({ name: 'Person 2', email: 'person2@company.com', responseStatus: 'needsAction' });
        });

        it('should cap attendees when exceeding MAX_EVENT_ATTENDEES', () => {
            const event = makeCalendarEvent({ numAttendees: 15 });
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);
            const item = parsed.items[0];

            expect(item.attendees).toHaveLength(10);
            expect(item.attendeesOmitted).toBe(5);
        });

        it('should flatten start/end to dateTime strings', () => {
            const event = makeCalendarEvent();
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);
            const item = parsed.items[0];

            expect(item.start).toBe('2026-03-11T07:00:00-03:00');
            expect(item.end).toBe('2026-03-11T08:00:00-03:00');
        });

        it('should omit confirmed status and strip id/recurringEventId', () => {
            const event = makeCalendarEvent();
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);
            const item = parsed.items[0];

            expect(item.status).toBeUndefined();
            expect(item.id).toBeUndefined();
        });

        it('should strip attachments', () => {
            const event = makeCalendarEvent({ hasAttachments: true });
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(JSON.stringify(parsed)).not.toContain('attachments');
            expect(JSON.stringify(parsed)).not.toContain('image005.png');
        });

        it('should preserve location and meeting link', () => {
            const event = makeCalendarEvent({ location: 'Conference Room A', hasConference: true });
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);
            const item = parsed.items[0];

            expect(item.location).toBe('Conference Room A');
            expect(item.meetingLink).toBe('https://meet.google.com/abc-defg-hij');
        });

        it('should truncate long descriptions', () => {
            const longDesc = 'Meeting notes: '.repeat(200);
            const event = makeCalendarEvent({ description: longDesc });
            const result = { output: JSON.stringify(makeCalendarResponse([event])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.items[0].description.length).toBeLessThanOrEqual(MAX_EVENT_DESCRIPTION_CHARS + 20);
            expect(parsed.items[0].description).toContain('[truncated]');
        });

        it('should preserve calendar-level timeZone (but not summary/email)', () => {
            const result = { output: JSON.stringify(makeCalendarResponse([makeCalendarEvent()])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.summary).toBeUndefined();
            expect(parsed.timeZone).toBe('America/Argentina/Cordoba');
        });

        it('should handle empty events list', () => {
            const result = { output: JSON.stringify(makeCalendarResponse([])) };
            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.items).toEqual([]);
        });
    });

    describe('Real-world scenario: massive calendar reduction', () => {
        it('should massively reduce a calendar with many attendees and attachments', () => {
            const events = Array.from({ length: 10 }, (_, i) =>
                makeCalendarEvent({
                    id: `event-${i}`,
                    summary: `Meeting ${i}`,
                    numAttendees: 20,
                    hasAttachments: true,
                    description: 'Agenda:\n' + 'Item '.repeat(50),
                })
            );
            const rawResult = { output: JSON.stringify(makeCalendarResponse(events)) };
            const rawSize = JSON.stringify(rawResult).length;

            const cleaned = sanitizeToolResult('work_calendar', rawResult);
            const cleanedSize = JSON.stringify(cleaned).length;

            // Should be meaningfully smaller (real-world data has much more bloat;
            // test fixtures are minimal, so the ratio is higher than production)
            expect(cleanedSize).toBeLessThan(rawSize * 0.75);

            const parsed = JSON.parse(cleaned.output);
            expect(parsed.items).toHaveLength(10);
            expect(parsed.items[0].summary).toBe('Meeting 0');
            // Attendees capped at 10 (from 20)
            expect(parsed.items[0].attendees).toHaveLength(10);
            expect(parsed.items[0].attendeesOmitted).toBe(10);
            // id and recurringEventId are stripped
            expect(parsed.items[0].id).toBeUndefined();
        });
    });

    describe('Google People API sanitization (MCP tools)', () => {
        const makeGooglePerson = (name, phone, email) => ({
            etag: '%EgkBAgkLLjc9Pj8aBAECBQciDGpmNDZVMVlVZXBnPQ==',
            names: [{
                displayName: name,
                displayNameLastFirst: name.split(' ').reverse().join(', '),
                familyName: name.split(' ')[1],
                givenName: name.split(' ')[0],
                metadata: { primary: true, source: { id: 'abc123', type: 'CONTACT' }, sourcePrimary: true },
                unstructuredName: name,
            }],
            phoneNumbers: phone ? [{
                canonicalForm: phone,
                formattedType: 'Mobile',
                metadata: { primary: true, source: { id: 'abc123', type: 'CONTACT' } },
                type: 'mobile',
                value: phone,
            }] : undefined,
            emailAddresses: email ? [{
                metadata: { primary: true, source: { id: 'abc123', type: 'CONTACT' } },
                value: email,
            }] : undefined,
            organizations: [{
                metadata: { source: { id: 'abc123', type: 'CONTACT' } },
                name: 'Acme Corp',
                title: 'Engineer',
            }],
            birthdays: [{
                date: { year: 1990, month: 3, day: 15 },
                metadata: { source: { id: 'abc123', type: 'CONTACT' } },
            }],
            resourceName: 'people/c123456789',
            photos: [{ url: 'https://lh3.googleusercontent.com/photo.jpg', metadata: {} }],
            memberships: [{ contactGroupMembership: { contactGroupId: 'myContacts' } }],
        });

        it('should compact Google People API connections format', () => {
            const apiResponse = {
                connections: [
                    makeGooglePerson('Alice Example', '+15555550123', 'alice@test.com'),
                    makeGooglePerson('Bob Example', '+15555550124', null),
                ],
                totalPeople: 2,
                totalItems: 2,
            };
            // MCP wraps as { output: "{ output: \"...\" }" }
            const result = { output: JSON.stringify({ output: JSON.stringify(apiResponse) }) };

            const cleaned = sanitizeToolResult('personal_people', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.connections).toHaveLength(2);

            // First person: should have compacted fields
            const person1 = parsed.connections[0];
            expect(person1.name).toBe('Alice Example');
            expect(person1.phones).toEqual([{ number: '+15555550123', type: 'Mobile' }]);
            expect(person1.emails).toEqual(['alice@test.com']);
            expect(person1.organization).toBe('Acme Corp');
            expect(person1.jobTitle).toBe('Engineer');
            expect(person1.birthday).toBe('1990-03-15');

            // Verbose metadata should be stripped
            const str = JSON.stringify(parsed);
            expect(str).not.toContain('etag');
            expect(str).not.toContain('metadata');
            expect(str).not.toContain('resourceName');
            expect(str).not.toContain('photos');
            expect(str).not.toContain('memberships');
            expect(str).not.toContain('sourcePrimary');
        });

        it('should handle person without optional fields', () => {
            const apiResponse = {
                connections: [makeGooglePerson('Simple Person', null, null)],
            };
            const result = { output: JSON.stringify({ output: JSON.stringify(apiResponse) }) };

            const cleaned = sanitizeToolResult('personal_people', result);
            const parsed = JSON.parse(cleaned.output);

            const person = parsed.connections[0];
            expect(person.name).toBe('Simple Person');
            expect(person.phones).toBeUndefined();
            expect(person.emails).toBeUndefined();
        });
    });

    describe('isHighCapTool - MCP namespaced tool name matching', () => {
        it('should match internal tool names', () => {
            expect(isHighCapTool('listPeople')).toBe(true);
            expect(isHighCapTool('searchPeople')).toBe(true);
            expect(isHighCapTool('getPerson')).toBe(true);
            expect(isHighCapTool('searchContacts')).toBe(true);
            expect(isHighCapTool('searchMemory')).toBe(true);
        });

        it('should match MCP namespaced tool names', () => {
            expect(isHighCapTool('personal_people')).toBe(true);
            expect(isHighCapTool('personal_people_connections_list')).toBe(true);
            expect(isHighCapTool('work_people_searchContacts')).toBe(true);
        });

        it('should NOT match unrelated tools', () => {
            expect(isHighCapTool('readSlackHistory')).toBe(false);
            expect(isHighCapTool('work_calendar')).toBe(false);
            expect(isHighCapTool('personal_gmail')).toBe(false);
        });

        it('should apply high cap for MCP people tools', () => {
            const big = { output: 'X'.repeat(100_000) };

            // MCP namespaced tool should get high cap
            const cleaned = sanitizeToolResult('personal_people', big);
            expect(cleaned._sanitizer).toBeUndefined(); // Not truncated at 50K

            // Non-people tool should be truncated
            const cleaned2 = sanitizeToolResult('readSlackHistory', big);
            expect(cleaned2._sanitizer?.truncated).toBe(true);
        });
    });

    describe('Truncation hints', () => {
        it('should include a hint when people tool results are truncated', () => {
            const huge = { output: 'X'.repeat(250_000) };
            const cleaned = sanitizeToolResult('personal_people', huge);
            expect(cleaned._sanitizer?.hint).toContain('searchPeople');
            expect(cleaned._sanitizer?.hint).toContain('Do NOT retry');
        });

        it('should include a hint when calendar tool results are truncated', () => {
            const huge = { output: 'X'.repeat(80_000) };
            const cleaned = sanitizeToolResult('work_calendar', huge);
            expect(cleaned._sanitizer?.hint).toContain('narrower date range');
            expect(cleaned._sanitizer?.hint).toContain('Do NOT retry');
        });

        it('should include a hint when gmail tool results are truncated', () => {
            const huge = { output: 'X'.repeat(80_000) };
            const cleaned = sanitizeToolResult('personal_gmail', huge);
            expect(cleaned._sanitizer?.hint).toContain('search query');
        });

        it('should include a generic hint for other tools', () => {
            const huge = { output: 'X'.repeat(80_000) };
            const cleaned = sanitizeToolResult('someRandomTool', huge);
            expect(cleaned._sanitizer?.hint).toContain('more specific query');
        });
    });

    describe('Real-world scenario: massive email reduction', () => {
        it('should massively reduce a marketing email (Booking.com style)', () => {
            // Simulate a 37KB HTML marketing email
            const hugeHtml = '<html><head><style>' + 'div{color:red}'.repeat(500) + '</style></head><body><p>Rate Awwa Suites & Spa</p><p>2 nights in Buenos Aires</p></body></html>';
            const message = makeGmailMessage({
                bodyHtml: hugeHtml,
                subject: 'Rate Awwa Suites & Spa',
                snippet: 'How was your stay at Awwa?',
            });
            // Single-part HTML (no text/plain)
            message.payload.mimeType = 'text/html';
            delete message.payload.parts;
            message.payload.body = { data: Buffer.from(hugeHtml).toString('base64') };

            const rawResult = { output: JSON.stringify(message) };
            const rawSize = JSON.stringify(rawResult).length;

            const cleaned = sanitizeToolResult('personal_gmail', rawResult);
            const cleanedSize = JSON.stringify(cleaned).length;

            // Should be dramatically smaller
            expect(cleanedSize).toBeLessThan(rawSize / 5);

            const parsed = JSON.parse(cleaned.output);
            expect(parsed.body).toContain('Rate Awwa Suites');
            expect(parsed.body).not.toContain('<style');
            expect(parsed.body).not.toContain('color:red');
        });
    });

    // ─── Layer 1d: Google Docs ────────────────────────────────────────────

    describe('Docs sanitization (Layer 1d)', () => {
        const syntheticDoc = JSON.parse(
            fs.readFileSync(path.join(__dirname, 'fixtures/work_docs_get_synthetic.json'), 'utf8')
        );

        function unwrap(result) {
            if (result && typeof result.output === 'string') return JSON.parse(result.output);
            return result;
        }

        test('extracts plain text from a synthetic Docs API response', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);

            expect(parsed.documentId).toBe(syntheticDoc.documentId);
            expect(parsed.title).toBe(syntheticDoc.title);
            expect(parsed.text).toBeDefined();
            // Real text content survives.
            expect(parsed.text).toContain('Person One');
            expect(parsed.text).toContain('Person Two');
            expect(parsed.text).toContain('Alpha');
            expect(parsed.text).toContain('Beta');
        });

        test('strips styling metadata (textStyle, paragraphStyle, rgbColor, magnitude/unit)', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const cleanedStr = JSON.stringify(cleaned);

            // None of the noise fields survive.
            expect(cleanedStr).not.toContain('textStyle');
            expect(cleanedStr).not.toContain('paragraphStyle');
            expect(cleanedStr).not.toContain('rgbColor');
            expect(cleanedStr).not.toContain('weightedFontFamily');
            expect(cleanedStr).not.toContain('namedStyleType');
            expect(cleanedStr).not.toContain('"magnitude"');
            expect(cleanedStr).not.toContain('"unit":"PT"');
            expect(cleanedStr).not.toContain('endIndex');
            expect(cleanedStr).not.toContain('startIndex');
        });

        test('renders headings as markdown', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);

            // TITLE → "# ", HEADING_2 → "## "
            expect(parsed.text).toMatch(/# Team Sync/);
            expect(parsed.text).toMatch(/## Person One/);
            expect(parsed.text).toMatch(/## Person Two/);
        });

        test('renders bullet lists with "- " prefix', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);

            expect(parsed.text).toMatch(/- Confirm Gamma role for Person One/);
            expect(parsed.text).toMatch(/- Get vacation calendar for May/);
        });

        test('renders person mentions inline as @name', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed.text).toContain('@Person Two');
        });

        test('renders rich links as markdown links', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed.text).toContain('[Master Staffing Sheet](https://docs.google.com/spreadsheets/d/abc)');
        });

        test('renders tables as markdown rows', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed.text).toContain('| Person | Project |');
            expect(parsed.text).toContain('| Person One | Alpha |');
        });

        test('massive size reduction — synthetic doc shrinks at least 4×', () => {
            const raw = { output: JSON.stringify(syntheticDoc) };
            const rawSize = JSON.stringify(raw).length;
            const cleaned = sanitizeToolResult('work_docs', raw);
            const cleanedSize = JSON.stringify(cleaned).length;
            expect(cleanedSize).toBeLessThan(rawSize / 4);
        });

        test('handles double-wrapped output (GWS MCP compact mode)', () => {
            // GWS MCP --tool-mode compact wraps as { output: "{\"output\": \"...\"}" }
            const inner = { output: JSON.stringify(syntheticDoc) };
            const doubleWrapped = { output: JSON.stringify(inner) };
            const cleaned = sanitizeToolResult('work_docs', doubleWrapped);
            const parsed = unwrap(cleaned);
            expect(parsed.text).toContain('Person One');
        });

        test('handles documents.list response by keeping only id and title', () => {
            const raw = {
                output: JSON.stringify({
                    documents: [
                        { documentId: 'd1', title: 'Doc A', revisionId: 'rev1', body: { content: [] } },
                        { documentId: 'd2', title: 'Doc B', revisionId: 'rev2', body: { content: [] } },
                    ],
                })
            };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed.documents).toHaveLength(2);
            expect(parsed.documents[0]).toEqual({ documentId: 'd1', title: 'Doc A' });
            expect(parsed.documents[1]).toEqual({ documentId: 'd2', title: 'Doc B' });
        });

        test('passes through non-doc payloads unchanged', () => {
            const raw = { output: JSON.stringify({ random: 'payload', other: [1, 2, 3] }) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed).toEqual({ random: 'payload', other: [1, 2, 3] });
        });

        test('truncates extracted text at MAX_DOC_TEXT_CHARS', () => {
            const longContent = 'A'.repeat(MAX_DOC_TEXT_CHARS + 5000);
            const longDoc = {
                documentId: 'long',
                title: 'Long Doc',
                body: { content: [{ paragraph: { elements: [{ textRun: { content: longContent } }] } }] }
            };
            const raw = { output: JSON.stringify(longDoc) };
            const cleaned = sanitizeToolResult('work_docs', raw);
            const parsed = unwrap(cleaned);
            expect(parsed.text.length).toBeLessThanOrEqual(MAX_DOC_TEXT_CHARS + 20); // +20 for "... [truncated]"
            expect(parsed.text.endsWith('[truncated]')).toBe(true);
        });

        test('isDocsTool matches namespaced tool names but not generic words', () => {
            // These should be sanitized
            const docPayload = { output: JSON.stringify(syntheticDoc) };
            for (const name of ['work_docs', 'personal_docs', 'work_docs_documents_get']) {
                const cleaned = sanitizeToolResult(name, docPayload);
                expect(unwrap(cleaned).text).toBeDefined();
            }
            // These should NOT be sanitized as docs
            for (const name of ['readSlackHistory', 'work_calendar', 'work_gmail']) {
                const cleaned = sanitizeToolResult(name, docPayload);
                // unwrap returns the raw doc (no .text field added)
                const parsed = unwrap(cleaned);
                expect(parsed.text).toBeUndefined();
            }
        });

        test('handles a mid-string-truncated double-wrapped payload without throwing', () => {
            // Simulates what the existing Layer 2 generic cap produces when a doc
            // response exceeds MAX_TOOL_RESULT_CHARS — the inner JSON string is
            // sliced mid-token, so JSON.parse on the inner field will throw.
            // The sanitizer should fall through to the original result.
            const truncatedPayload = {
                output: '{"output":"{\\n  \\"body\\": {\\n    \\"content\\": [\\n      {\\n        \\"endIndex\\": 1,\\n        \\"sectionBreak\\":'
            };
            expect(() => sanitizeToolResult('work_docs', truncatedPayload)).not.toThrow();
        });
    });

    // ─── Pre-call argument sanitization ──────────────────────────────────

    describe('sanitizeToolArgs — events.list timeMax defaulting', () => {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        test('injects timeMax when only timeMin is provided (GWS shape)', () => {
            const args = {
                resource: 'events',
                method: 'list',
                params: { calendarId: 'primary', timeMin: '2026-04-29T00:00:00Z' }
            };
            const out = sanitizeToolArgs('work_calendar', args);
            expect(out.params.timeMax).toBeDefined();
            const min = new Date(out.params.timeMin).getTime();
            const max = new Date(out.params.timeMax).getTime();
            expect(max - min).toBe(DEFAULT_CALENDAR_WINDOW_DAYS * ONE_DAY_MS);
        });

        test('does NOT touch args when timeMax is already provided', () => {
            const args = {
                resource: 'events',
                method: 'list',
                params: { calendarId: 'primary', timeMin: '2026-04-29T00:00:00Z', timeMax: '2026-04-30T00:00:00Z' }
            };
            const out = sanitizeToolArgs('work_calendar', args);
            expect(out.params.timeMax).toBe('2026-04-30T00:00:00Z');
        });

        test('does not touch the original args object (no mutation)', () => {
            const args = {
                resource: 'events',
                method: 'list',
                params: { calendarId: 'primary', timeMin: '2026-04-29T00:00:00Z' }
            };
            const before = JSON.parse(JSON.stringify(args));
            sanitizeToolArgs('work_calendar', args);
            expect(args).toEqual(before);
        });

        test('defaults both timeMin (now) and timeMax (now+7d) when neither is provided', () => {
            const args = { resource: 'events', method: 'list', params: { calendarId: 'primary' } };
            const out = sanitizeToolArgs('work_calendar', args);
            expect(out.params.timeMin).toBeDefined();
            expect(out.params.timeMax).toBeDefined();
            const min = new Date(out.params.timeMin).getTime();
            const max = new Date(out.params.timeMax).getTime();
            expect(max - min).toBe(DEFAULT_CALENDAR_WINDOW_DAYS * ONE_DAY_MS);
        });

        test('handles top-level shape (no nested params)', () => {
            const args = { timeMin: '2026-04-29T00:00:00Z' };
            const out = sanitizeToolArgs('listEvents', args);
            expect(out.timeMax).toBeDefined();
        });

        test('does not touch non-events.list calendar calls', () => {
            const args = { resource: 'calendars', method: 'get', params: { calendarId: 'primary' } };
            const out = sanitizeToolArgs('work_calendar', args);
            expect(out).toEqual(args);
        });

        test('does not touch non-calendar tools', () => {
            const args = { params: { timeMin: '2026-04-29T00:00:00Z' } };
            const out = sanitizeToolArgs('work_gmail', args);
            expect(out).toEqual(args);
        });

        test('passes through invalid timeMin without throwing', () => {
            const args = { resource: 'events', method: 'list', params: { timeMin: 'not-a-date' } };
            expect(() => sanitizeToolArgs('work_calendar', args)).not.toThrow();
        });

        test('passes through null/undefined args', () => {
            expect(sanitizeToolArgs('work_calendar', null)).toBeNull();
            expect(sanitizeToolArgs('work_calendar', undefined)).toBeUndefined();
        });
    });
});
