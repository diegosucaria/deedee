/**
 * Tool Result Sanitizer
 *
 * Two-layer defense against oversized tool results that bloat the Gemini context window:
 *   Layer 1a: Gmail-specific deep cleaning (decode base64, strip HTML/headers)
 *   Layer 1b: Calendar-specific cleaning (strip attendees, etags, attachments)
 *   Layer 2: Generic size cap for ALL tool results
 */

const MAX_TOOL_RESULT_CHARS = 50_000;
const MAX_EMAIL_BODY_CHARS = 4_000;
const MAX_EVENT_DESCRIPTION_CHARS = 500;

const ALLOWED_EMAIL_HEADERS = new Set([
    'from', 'to', 'subject', 'date', 'cc', 'reply-to',
]);

// --- Public API ---

/**
 * Sanitize a tool result before it enters the Gemini context.
 * @param {string} toolName - The tool name (e.g. 'personal_gmail', 'work_gmail_messages_list')
 * @param {*} result - The raw tool result
 * @param {number} [maxChars] - Generic size cap (default 50K)
 * @returns {*} Cleaned result
 */
function sanitizeToolResult(toolName, result, maxChars = MAX_TOOL_RESULT_CHARS) {
    if (result == null) return result;

    let cleaned = result;

    // Layer 1a: Gmail-specific deep cleaning
    if (isGmailTool(toolName)) {
        try {
            cleaned = sanitizeGmailResult(cleaned);
        } catch (e) {
            console.error(`[Sanitizer] Gmail sanitization failed for ${toolName}:`, e.message);
            // Fall through to generic cap
        }
    }

    // Layer 1b: Calendar-specific cleaning
    if (isCalendarTool(toolName)) {
        try {
            cleaned = sanitizeCalendarResult(cleaned);
        } catch (e) {
            console.error(`[Sanitizer] Calendar sanitization failed for ${toolName}:`, e.message);
        }
    }

    // Layer 2: Generic size cap
    cleaned = applyGenericCap(toolName, cleaned, maxChars);

    return cleaned;
}

// --- Layer 1: Gmail-specific ---

function isGmailTool(toolName) {
    return toolName && toolName.toLowerCase().includes('gmail');
}

/**
 * Sanitize a Gmail tool result. The GWS MCP returns raw Gmail API responses
 * with base64-encoded bodies, full SMTP headers, and duplicate MIME parts.
 */
function sanitizeGmailResult(result) {
    // GWS MCP wraps results as { output: "JSON string" }
    if (result && typeof result.output === 'string') {
        try {
            const parsed = JSON.parse(result.output);
            const cleaned = sanitizeGmailParsed(parsed);
            return { output: JSON.stringify(cleaned) };
        } catch {
            // Not valid JSON — apply generic cap only
            return result;
        }
    }

    // Direct object (not string-wrapped)
    if (result && typeof result === 'object') {
        return sanitizeGmailParsed(result);
    }

    return result;
}

/**
 * Process a parsed Gmail API response object.
 * Handles both single messages and arrays/lists.
 */
function sanitizeGmailParsed(obj) {
    // Single message (has payload.headers or payload.parts)
    if (obj.payload && (obj.payload.headers || obj.payload.parts || obj.payload.body)) {
        return extractCleanEmail(obj);
    }

    // Array of messages
    if (Array.isArray(obj)) {
        return obj.map(item => {
            if (item.payload) return extractCleanEmail(item);
            return item;
        });
    }

    // Messages list response { messages: [...] }
    if (obj.messages && Array.isArray(obj.messages)) {
        return {
            ...obj,
            messages: obj.messages.map(msg => {
                if (msg.payload) return extractCleanEmail(msg);
                return msg;
            })
        };
    }

    return obj;
}

/**
 * Extract a clean, compact email from a raw Gmail API message object.
 * Replaces the bloated payload with just the useful fields.
 */
function extractCleanEmail(message) {
    const headers = message.payload?.headers || [];
    const filtered = filterHeaders(headers);

    const from = getHeader(filtered, 'from');
    const to = getHeader(filtered, 'to');
    const cc = getHeader(filtered, 'cc');
    const subject = getHeader(filtered, 'subject');
    const date = getHeader(filtered, 'date');
    const replyTo = getHeader(filtered, 'reply-to');

    // Extract readable body
    const body = decodeEmailBody(message.payload);

    const clean = {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds,
        from,
        to,
        subject,
        date,
        snippet: message.snippet || '',
        body: truncate(body, MAX_EMAIL_BODY_CHARS),
    };

    if (cc) clean.cc = cc;
    if (replyTo) clean.replyTo = replyTo;

    return clean;
}

// --- Email helpers ---

function filterHeaders(headers) {
    return headers.filter(h => ALLOWED_EMAIL_HEADERS.has(h.name.toLowerCase()));
}

function getHeader(headers, name) {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : null;
}

/**
 * Decode the email body from a Gmail payload.
 * Prefers text/plain over text/html. Decodes base64url.
 */
function decodeEmailBody(payload) {
    if (!payload) return '';

    // Check for multipart — look through parts for text/plain first
    if (payload.parts && payload.parts.length > 0) {
        // Prefer text/plain
        const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body?.data) {
            return decodeBase64Url(textPart.body.data);
        }

        // Fallback to text/html, strip tags
        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
        if (htmlPart && htmlPart.body?.data) {
            return stripHtml(decodeBase64Url(htmlPart.body.data));
        }

        // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
        for (const part of payload.parts) {
            if (part.parts) {
                const nested = decodeEmailBody(part);
                if (nested) return nested;
            }
        }
    }

    // Single-part body
    if (payload.body?.data) {
        const decoded = decodeBase64Url(payload.body.data);
        if (payload.mimeType === 'text/html') {
            return stripHtml(decoded);
        }
        return decoded;
    }

    return '';
}

/**
 * Decode base64url-encoded string (Gmail uses URL-safe base64).
 */
function decodeBase64Url(data) {
    if (!data) return '';
    try {
        // Gmail uses URL-safe base64: replace - with + and _ with /
        const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').toString('utf-8');
    } catch {
        return '[base64 decode failed]';
    }
}

/**
 * Strip HTML tags and decode common entities. Simple and fast.
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        // Remove style/script blocks entirely
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        // Replace block-level tags with newlines
        .replace(/<\/(p|div|tr|li|h[1-6]|br\s*\/?)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        // Strip remaining tags
        .replace(/<[^>]+>/g, '')
        // Decode common entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // Collapse whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// --- Layer 1b: Calendar-specific ---

function isCalendarTool(toolName) {
    return toolName && toolName.toLowerCase().includes('calendar');
}

/**
 * Sanitize a Google Calendar tool result.
 * Strips attendee metadata, etags, iCalUIDs, htmlLinks, attachments, etc.
 * Keeps: summary, start, end, location, attendees (name+email), description (truncated), status.
 */
function sanitizeCalendarResult(result) {
    // GWS MCP wraps results as { output: "JSON string" }
    if (result && typeof result.output === 'string') {
        try {
            const parsed = JSON.parse(result.output);
            const cleaned = sanitizeCalendarParsed(parsed);
            return { output: JSON.stringify(cleaned) };
        } catch {
            return result;
        }
    }

    if (result && typeof result === 'object') {
        return sanitizeCalendarParsed(result);
    }

    return result;
}

function sanitizeCalendarParsed(obj) {
    // Calendar events list response { items: [...], kind: "calendar#events", ... }
    if (obj.items && Array.isArray(obj.items)) {
        return {
            summary: obj.summary,
            timeZone: obj.timeZone,
            items: obj.items.map(extractCleanEvent),
        };
    }

    // Single event
    if (obj.kind === 'calendar#event' || obj.start) {
        return extractCleanEvent(obj);
    }

    // Array of events
    if (Array.isArray(obj)) {
        return obj.map(item => item.start ? extractCleanEvent(item) : item);
    }

    return obj;
}

function extractCleanEvent(event) {
    const clean = {
        id: event.id,
        summary: event.summary || '(no title)',
        start: event.start,
        end: event.end,
        status: event.status,
    };

    if (event.location) clean.location = event.location;

    if (event.description) {
        clean.description = truncate(event.description, MAX_EVENT_DESCRIPTION_CHARS);
    }

    // Keep attendees: name, email, responseStatus, and flags (strip other metadata)
    if (event.attendees && event.attendees.length > 0) {
        clean.attendees = event.attendees.map(a => {
            const att = {};
            if (a.displayName) att.name = a.displayName;
            if (a.email) att.email = a.email;
            if (a.self) att.self = true;
            if (a.organizer) att.organizer = true;
            if (a.optional) att.optional = true;
            if (a.responseStatus) att.responseStatus = a.responseStatus;
            return att;
        });
    }

    if (event.recurringEventId) clean.recurringEventId = event.recurringEventId;
    if (event.hangoutLink) clean.hangoutLink = event.hangoutLink;
    if (event.conferenceData?.entryPoints) {
        clean.meetingLink = event.conferenceData.entryPoints
            .find(e => e.entryPointType === 'video')?.uri;
    }

    return clean;
}

// --- Layer 2: Generic size cap ---

function applyGenericCap(toolName, result, maxChars) {
    let serialized;
    try {
        serialized = typeof result === 'string' ? result : JSON.stringify(result);
    } catch {
        return result; // Can't serialize, pass through
    }

    if (serialized.length <= maxChars) return result;

    const originalLen = serialized.length;
    console.warn(`[Sanitizer] ⚠️ Tool "${toolName}" result TRUNCATED: ${originalLen} chars → ${maxChars} chars`);

    const truncated = serialized.substring(0, maxChars);
    return {
        output: truncated,
        _sanitizer: {
            truncated: true,
            originalChars: originalLen,
            maxChars,
        }
    };
}

// --- Shared helpers ---

function truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '... [truncated]';
}

module.exports = { sanitizeToolResult, MAX_TOOL_RESULT_CHARS, MAX_EMAIL_BODY_CHARS, MAX_EVENT_DESCRIPTION_CHARS };
