const { sanitizeToolResult, MAX_TOOL_RESULT_CHARS, MAX_EMAIL_BODY_CHARS, MAX_EVENT_DESCRIPTION_CHARS } = require('../src/utils/tool-result-sanitizer');

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
            expect(serialized.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 200); // some overhead for wrapper
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
            expect(event.start).toBeDefined();
            expect(event.end).toBeDefined();
            expect(event.status).toBe('confirmed');

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

        it('should preserve calendar-level summary and timeZone', () => {
            const result = { output: JSON.stringify(makeCalendarResponse([makeCalendarEvent()])) };

            const cleaned = sanitizeToolResult('work_calendar', result);
            const parsed = JSON.parse(cleaned.output);

            expect(parsed.summary).toBe('user@company.com');
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
            expect(parsed.items[0].attendees).toHaveLength(20);
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
});
