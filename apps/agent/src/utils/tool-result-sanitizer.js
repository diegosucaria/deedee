/**
 * Tool Result Sanitizer
 *
 * Two-layer defense against oversized tool results that bloat the Gemini context window:
 *   Layer 1a: Gmail-specific deep cleaning (decode base64, strip HTML/headers)
 *   Layer 1b: Calendar-specific cleaning (strip attendees, etags, attachments)
 *   Layer 1c: People-specific cleaning (strip nulls, truncate notes)
 *   Layer 1d: Google Docs cleaning (extract text from styling-heavy JSON tree)
 *   Layer 2: Generic size cap for ALL tool results
 */

const MAX_TOOL_RESULT_CHARS = 50_000;
const MAX_EMAIL_BODY_CHARS = 4_000;
const MAX_EVENT_DESCRIPTION_CHARS = 500;
const MAX_EVENT_ATTENDEES = 10;
const MAX_PERSON_NOTES_CHARS = 300;

// Tools that need higher caps because the model needs complete data
// Matches both internal names (listPeople) and MCP namespaced names (personal_people_connections_list)
const HIGH_CAP_TOOLS = new Set(['listPeople', 'searchPeople', 'searchContacts', 'getPerson', 'searchMemory', 'readAllMonitoredSlackHistory']);
const HIGH_CAP_MAX_CHARS = 200_000;

/**
 * Check if a tool should use the higher character cap.
 * Supports both exact names (internal tools) and pattern matching (MCP namespaced tools).
 */
function isHighCapTool(toolName) {
    if (!toolName) return false;
    if (HIGH_CAP_TOOLS.has(toolName)) return true;
    // MCP tools are namespaced: personal_people_connections_list, etc.
    // Match if the tool is a people or memory tool (these need complete data for matching)
    const lower = toolName.toLowerCase();
    if (lower.includes('people') || lower.includes('contacts') || lower.includes('searchmemory') || lower.includes('readallmonitoredslackhistory')) return true;
    return false;
}

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

    // Layer 1c: People-specific cleaning (strip nulls, truncate notes)
    if (isPeopleTool(toolName)) {
        try {
            cleaned = sanitizePeopleResult(cleaned);
        } catch (e) {
            console.error(`[Sanitizer] People sanitization failed for ${toolName}:`, e.message);
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

    // Layer 1d: Google Docs cleaning
    if (isDocsTool(toolName)) {
        try {
            cleaned = sanitizeDocsResult(cleaned);
        } catch (e) {
            console.error(`[Sanitizer] Docs sanitization failed for ${toolName}:`, e.message);
        }
    }

    // Layer 2: Generic size cap (use higher cap for critical tools)
    const effectiveMaxChars = isHighCapTool(toolName) ? Math.max(maxChars, HIGH_CAP_MAX_CHARS) : maxChars;
    cleaned = applyGenericCap(toolName, cleaned, effectiveMaxChars);

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

function flattenDateTime(dt) {
    if (!dt) return dt;
    // All-day events use { date: "2026-03-13" }
    if (dt.date) return dt.date;
    // Timed events: dateTime already contains the offset, so timeZone is redundant
    if (dt.dateTime) return dt.dateTime;
    return dt;
}

function extractCleanEvent(event) {
    const clean = {
        summary: event.summary || '(no title)',
        start: flattenDateTime(event.start),
        end: flattenDateTime(event.end),
    };

    // Only include status if it's NOT confirmed (the default)
    if (event.status && event.status !== 'confirmed') {
        clean.status = event.status;
    }

    if (event.location) clean.location = event.location;

    if (event.description) {
        clean.description = truncate(event.description, MAX_EVENT_DESCRIPTION_CHARS);
    }

    // Keep attendees: name, email, responseStatus, and flags (strip other metadata)
    if (event.attendees && event.attendees.length > 0) {
        const mapped = event.attendees.map(a => {
            const att = {};
            if (a.displayName) att.name = a.displayName;
            if (a.email) att.email = a.email;
            if (a.self) att.self = true;
            if (a.organizer) att.organizer = true;
            if (a.optional) att.optional = true;
            if (a.responseStatus) att.responseStatus = a.responseStatus;
            return att;
        });
        if (mapped.length > MAX_EVENT_ATTENDEES) {
            clean.attendees = mapped.slice(0, MAX_EVENT_ATTENDEES);
            clean.attendeesOmitted = mapped.length - MAX_EVENT_ATTENDEES;
        } else {
            clean.attendees = mapped;
        }
    }

    if (event.hangoutLink) clean.meetingLink = event.hangoutLink;
    else if (event.conferenceData?.entryPoints) {
        clean.meetingLink = event.conferenceData.entryPoints
            .find(e => e.entryPointType === 'video')?.uri;
    }

    return clean;
}

// --- Layer 1d: Google Docs ---

const MAX_DOC_TEXT_CHARS = 40_000;

function isDocsTool(toolName) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();
    // Match work_docs, personal_docs, work_docs_documents_get, etc.
    // Exclude generic "doc" matches (e.g. nothing else uses "_docs" suffix today).
    return /(^|_)docs(_|$)/.test(lower);
}

/**
 * Sanitize a Google Docs documents.get response.
 * The Docs API returns a massive JSON tree dominated by styling metadata
 * (textStyle, paragraphStyle, rgbColor, magnitude/unit, namedStyleType...).
 * Actual content lives in body.content[*].paragraph.elements[*].textRun.content
 * Person mentions live in .person.personProperties (email/name).
 * Rich links live in .richLink.richLinkProperties (uri/title).
 */
function sanitizeDocsResult(result) {
    // GWS MCP wraps results as { output: "JSON string" }, sometimes double-wrapped.
    if (result && typeof result.output === 'string') {
        try {
            let parsed = JSON.parse(result.output);
            if (parsed && typeof parsed.output === 'string') {
                try { parsed = JSON.parse(parsed.output); } catch {}
            }
            const cleaned = sanitizeDocsParsed(parsed);
            // If the parsed object wasn't a doc, return original (don't lose data).
            if (cleaned === parsed) return result;
            return { output: JSON.stringify(cleaned) };
        } catch {
            return result;
        }
    }

    if (result && typeof result === 'object') {
        return sanitizeDocsParsed(result);
    }

    return result;
}

function sanitizeDocsParsed(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // documents.get with includeTabsContent=true returns ALL content under
    // tabs[*].documentTab. The top-level `body` field is also populated for
    // backwards compatibility but only contains the FIRST tab — checking
    // tabs first ensures we don't lose content from other tabs.
    // https://developers.google.com/workspace/docs/api/how-tos/tabs
    if (Array.isArray(obj.tabs)) {
        return extractCleanTabbedDoc(obj);
    }

    // documents.get without tabs: content lives at body.content.
    if (obj.body && Array.isArray(obj.body.content)) {
        return extractCleanDoc(obj);
    }

    // documents.list response: { documents: [...] } — keep only id/title
    if (Array.isArray(obj.documents)) {
        return {
            ...obj,
            documents: obj.documents.map(d => ({
                documentId: d.documentId,
                title: d.title,
            })),
        };
    }

    return obj;
}

function extractCleanDoc(doc) {
    const text = renderDocBody(doc.body);
    return {
        documentId: doc.documentId,
        title: doc.title,
        revisionId: doc.revisionId,
        text: truncate(text, MAX_DOC_TEXT_CHARS),
    };
}

function extractCleanTabbedDoc(doc) {
    const sections = [];
    walkTabs(doc.tabs, sections, 0);
    const text = sections.join('\n\n').trim();
    return {
        documentId: doc.documentId,
        title: doc.title,
        revisionId: doc.revisionId,
        text: truncate(text, MAX_DOC_TEXT_CHARS),
    };
}

function walkTabs(tabs, out, depth) {
    if (!Array.isArray(tabs)) return;
    for (const tab of tabs) {
        const tabTitle = tab?.tabProperties?.title;
        const body = tab?.documentTab?.body;
        if (tabTitle) {
            const prefix = '#'.repeat(Math.min(depth + 1, 6));
            out.push(`${prefix} [Tab] ${tabTitle}`);
        }
        if (body) {
            const rendered = renderDocBody(body);
            if (rendered) out.push(rendered);
        }
        if (Array.isArray(tab?.childTabs) && tab.childTabs.length) {
            walkTabs(tab.childTabs, out, depth + 1);
        }
    }
}

function renderDocBody(body) {
    if (!body || !Array.isArray(body.content)) return '';
    const lines = [];
    for (const block of body.content) {
        const rendered = renderStructuralElement(block);
        if (rendered) lines.push(rendered);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderStructuralElement(block) {
    if (!block || typeof block !== 'object') return '';

    if (block.paragraph) return renderParagraph(block.paragraph);

    if (block.table) return renderTable(block.table);

    if (block.tableOfContents) {
        // ToC is a nested doc body.
        return renderDocBody(block.tableOfContents);
    }

    // sectionBreak / pageBreak / etc. — drop.
    return '';
}

function renderParagraph(paragraph) {
    const elements = paragraph.elements || [];
    let text = '';
    for (const el of elements) {
        if (el.textRun?.content) {
            text += el.textRun.content;
        } else if (el.person) {
            const name = el.person.personProperties?.name;
            const email = el.person.personProperties?.email;
            text += name ? `@${name}` : (email ? `@${email}` : '@person');
        } else if (el.richLink) {
            const title = el.richLink.richLinkProperties?.title;
            const uri = el.richLink.richLinkProperties?.uri;
            text += title ? `[${title}](${uri || ''})` : (uri || '');
        }
        // Drop: pageBreak, equation, columnBreak, footnoteReference, autoText, horizontalRule.
    }

    text = text.replace(/\n+$/, '');
    if (!text.trim() && !paragraph.bullet) return '';

    // Heading prefix from namedStyleType: HEADING_1 → "# ", HEADING_2 → "## ", etc.
    const styleType = paragraph.paragraphStyle?.namedStyleType || '';
    const headingMatch = /^HEADING_(\d)$/.exec(styleType);
    if (headingMatch) {
        const level = Math.min(parseInt(headingMatch[1], 10), 6);
        return '#'.repeat(level) + ' ' + text.trim();
    }
    if (styleType === 'TITLE') return '# ' + text.trim();
    if (styleType === 'SUBTITLE') return '## ' + text.trim();

    // Bullet/numbered list.
    if (paragraph.bullet) {
        const indent = paragraph.bullet.nestingLevel || 0;
        return '  '.repeat(indent) + '- ' + text.trim();
    }

    return text;
}

function renderTable(table) {
    if (!table || !Array.isArray(table.tableRows)) return '';
    const rows = [];
    for (const row of table.tableRows) {
        const cells = (row.tableCells || []).map(c => {
            const cellText = (c.content || []).map(renderStructuralElement).join(' ').trim();
            return cellText.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        });
        rows.push('| ' + cells.join(' | ') + ' |');
    }
    return rows.join('\n');
}

// --- Layer 1c: People-specific ---

function isPeopleTool(toolName) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();
    return lower.includes('people') || lower === 'listpeople' || lower === 'getperson' || lower === 'searchcontacts';
}

/**
 * Sanitize people tool results by stripping null/empty fields and truncating notes.
 * Reduces payload size significantly since most synced contacts have sparse data.
 * Handles both internal DB format and Google People API format (MCP).
 */
function sanitizePeopleResult(result) {
    if (!result || typeof result !== 'object') return result;

    // GWS MCP wraps results as { output: "JSON string" } (possibly nested)
    if (typeof result.output === 'string') {
        try {
            let parsed = JSON.parse(result.output);
            // Handle double-wrapped: { output: "{ output: \"...\" }" }
            if (parsed && typeof parsed.output === 'string') {
                try { parsed = JSON.parse(parsed.output); } catch {}
            }
            const cleaned = sanitizePeopleParsed(parsed);
            return { output: JSON.stringify(cleaned) };
        } catch {
            return result;
        }
    }

    return sanitizePeopleParsed(result);
}

function sanitizePeopleParsed(result) {
    if (!result || typeof result !== 'object') return result;

    // Handle { people: [...] } format (internal listPeople)
    if (Array.isArray(result.people)) {
        return { ...result, people: result.people.map(compactPerson) };
    }

    // Handle { matches: [...] } format (searchPeople/searchContacts)
    if (Array.isArray(result.matches)) {
        return { ...result, matches: result.matches.map(compactPerson) };
    }

    // Handle { person: {...} } format (getPerson)
    if (result.person && typeof result.person === 'object') {
        return { ...result, person: compactPerson(result.person) };
    }

    // Handle Google People API format: { connections: [...] }
    if (Array.isArray(result.connections)) {
        return {
            totalPeople: result.totalPeople || result.connections.length,
            connections: result.connections.map(compactGooglePerson),
        };
    }

    return result;
}

/**
 * Compact a Google People API person object.
 * Extracts only the useful fields from the verbose API response.
 */
function compactGooglePerson(person) {
    if (!person || typeof person !== 'object') return person;
    const clean = {};

    // Name
    const name = person.names?.[0];
    if (name) clean.name = name.displayName || name.unstructuredName;

    // Phone numbers
    if (person.phoneNumbers?.length) {
        clean.phones = person.phoneNumbers.map(p => ({
            number: p.canonicalForm || p.value,
            type: p.formattedType,
        }));
    }

    // Email addresses
    if (person.emailAddresses?.length) {
        clean.emails = person.emailAddresses.map(e => e.value);
    }

    // Organizations
    if (person.organizations?.length) {
        const org = person.organizations[0];
        if (org.name) clean.organization = org.name;
        if (org.title) clean.jobTitle = org.title;
    }

    // Birthdays
    if (person.birthdays?.length) {
        const bday = person.birthdays[0]?.date;
        if (bday) clean.birthday = `${bday.year || '????'}-${String(bday.month).padStart(2, '0')}-${String(bday.day).padStart(2, '0')}`;
    }

    // Addresses
    if (person.addresses?.length) {
        clean.addresses = person.addresses.map(a => a.formattedValue || a.streetAddress).filter(Boolean);
    }

    return clean;
}

/**
 * Compact a person object: strip null/empty fields, truncate notes,
 * remove verbose metadata/identifiers.
 */
function compactPerson(p) {
    if (!p || typeof p !== 'object') return p;
    const clean = { id: p.id, name: p.name };
    if (p.phone) clean.phone = p.phone;
    if (p.relationship) clean.relationship = p.relationship;
    if (p.notes) clean.notes = truncate(p.notes, MAX_PERSON_NOTES_CHARS);
    if (p.source && p.source !== 'manual') clean.source = p.source;
    // Strip metadata and identifiers (verbose JSON blobs)
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
            hint: getTruncationHint(toolName),
        }
    };
}

// --- Truncation hints ---

/**
 * Provide actionable guidance when tool results are truncated.
 * Prevents the model from looping by retrying the same broad query.
 */
function getTruncationHint(toolName) {
    if (!toolName) return 'Result was truncated. Try a more specific query to reduce the result size.';
    const lower = toolName.toLowerCase();
    if (lower.includes('people') || lower.includes('contacts')) {
        return 'Contact list was truncated. Do NOT retry listing all contacts. Use searchPeople or searchContacts with a specific name query instead.';
    }
    if (lower.includes('calendar')) {
        return 'Calendar data was truncated. Use a narrower date range (e.g. 1-3 days) to reduce the result size. Do NOT retry with the same parameters.';
    }
    if (lower.includes('gmail')) {
        return 'Email results were truncated. Use a more specific search query or reduce maxResults. Do NOT retry with the same parameters.';
    }
    if (lower.includes('slack')) {
        return 'Slack history was truncated. Try reducing the number of monitored channels or the time range. Do NOT retry with the same parameters.';
    }
    return 'Result was truncated due to size. Try a more specific query or use filters to reduce the result size. Do NOT retry the same call.';
}

// --- Pre-call argument sanitization ---

const DEFAULT_CALENDAR_WINDOW_DAYS = 7;

/**
 * Mutate-safe pre-processor for tool arguments. Catches common LLM mistakes
 * that lead to oversized responses BEFORE the tool is called.
 *
 * Currently handles:
 *  - calendar events.list called with timeMin but no timeMax → default to timeMin + 7d
 *  - calendar events.list called with neither → default to now + 7d
 *
 * Returns a new args object; the input is never mutated.
 */
function sanitizeToolArgs(toolName, args) {
    if (!args || typeof args !== 'object') return args;
    const cleaned = { ...args };

    if (isCalendarEventsListCall(toolName, cleaned)) {
        // GWS-shape calls put query args under `params`; everything else uses
        // a flat top-level shape. Either way, ensure timeMax lands where the
        // downstream tool actually reads it from — which for GWS is `params`,
        // even when the model omitted that field entirely.
        // Mirror the exact GWS-branch conditions in isCalendarEventsListCall
        // so a non-calendar tool that happened to match via the name-based
        // branch (e.g. internal listEvents) doesn't get its args nested.
        const isGwsShape = !!(
            toolName.toLowerCase().includes('calendar') &&
            cleaned.resource && cleaned.method
        );
        let target;
        if (isGwsShape) {
            cleaned.params = cleaned.params && typeof cleaned.params === 'object'
                ? { ...cleaned.params }
                : {};
            target = cleaned.params;
        } else {
            target = cleaned;
        }

        if (!target.timeMax) {
            const min = target.timeMin ? new Date(target.timeMin) : new Date();
            if (!isNaN(min.getTime())) {
                const max = new Date(min.getTime() + DEFAULT_CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
                target.timeMax = max.toISOString();
                if (!target.timeMin) target.timeMin = min.toISOString();
                console.log(`[Sanitizer] events.list missing timeMax — defaulted to ${target.timeMin} → ${target.timeMax} (${DEFAULT_CALENDAR_WINDOW_DAYS}d window)`);
            }
        }
    }

    return cleaned;
}

function isCalendarEventsListCall(toolName, args) {
    if (!toolName) return false;
    const lower = toolName.toLowerCase();

    // GWS MCP shape: { resource: "events", method: "list", params: {...} }
    // Only valid on calendar-namespaced tools.
    if (lower.includes('calendar') && args.resource && args.method) {
        const r = String(args.resource).toLowerCase();
        const m = String(args.method).toLowerCase();
        return r.endsWith('events') && m === 'list';
    }

    // Internal tool name whose contract IS events.list at top level.
    if (lower.includes('listevents') || lower.endsWith('events_list')) return true;

    return false;
}

// --- Shared helpers ---

function truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '... [truncated]';
}

module.exports = { sanitizeToolResult, sanitizeToolArgs, isHighCapTool, MAX_TOOL_RESULT_CHARS, MAX_EMAIL_BODY_CHARS, MAX_EVENT_DESCRIPTION_CHARS, MAX_PERSON_NOTES_CHARS, MAX_DOC_TEXT_CHARS, HIGH_CAP_TOOLS, HIGH_CAP_MAX_CHARS, DEFAULT_CALENDAR_WINDOW_DAYS };
