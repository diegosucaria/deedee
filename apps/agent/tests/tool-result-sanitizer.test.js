const { sanitizeToolResult, MAX_TOOL_RESULT_CHARS, MAX_EMAIL_BODY_CHARS } = require('../src/utils/tool-result-sanitizer');

// --- Fixtures ---

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
            const huge = { output: 'X'.repeat(50000) };
            const cleaned = sanitizeToolResult('readSlackHistory', huge);

            const serialized = JSON.stringify(cleaned);
            expect(serialized.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 200); // some overhead for wrapper
            expect(cleaned._sanitizer).toBeDefined();
            expect(cleaned._sanitizer.truncated).toBe(true);
            expect(cleaned._sanitizer.originalChars).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
        });

        it('should log a warning when truncating', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const huge = { output: 'X'.repeat(50000) };

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
