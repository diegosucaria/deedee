# Tool Result Sanitizer

**File:** `apps/agent/src/utils/tool-result-sanitizer.js`
**Tests:** `apps/agent/tests/tool-result-sanitizer.test.js`

## Purpose

Prevents oversized tool results from bloating the Gemini context window. Every tool result passes through `sanitizeToolResult()` before being sent to the model.

## Architecture

Two-layer defense pipeline. Layer 1 applies domain-specific cleaning, Layer 2 enforces a hard size cap.

```
Tool Result
    |
    v
Layer 1a: Gmail       (if toolName includes 'gmail')
Layer 1b: Calendar    (if toolName includes 'calendar')
Layer 1c: People      (if toolName includes 'people', 'getperson', 'searchcontacts')
    |
    v
Layer 2: Generic Cap  (50K default, 200K for high-cap tools)
    |
    v
Gemini Context
```

## Layer 1: Domain-Specific Sanitizers

### 1a. Gmail (`isGmailTool`)

Handles raw Gmail API responses from the GWS MCP server.

| Action | Detail |
|--------|--------|
| Decode body | Base64url -> UTF-8, prefer text/plain over text/html |
| Strip headers | Keep only: from, to, subject, date, cc, reply-to |
| Truncate body | Max 4,000 chars per email |
| Strip HTML | Remove tags, decode entities, collapse whitespace |

### 1b. Calendar (`isCalendarTool`)

Strips verbose Google Calendar API metadata.

| Kept | Stripped |
|------|---------|
| summary, start (flattened), end (flattened) | id, etag, iCalUID, htmlLink, kind, sequence |
| location, description (500 chars) | creator, organizer metadata, reminders |
| attendees (name, email, responseStatus; max 10) | attachments, extendedProperties |
| meetingLink | Full conferenceData blob, recurringEventId |
| status (only if not "confirmed") | Calendar-level summary (email) |

### 1c. People (`isPeopleTool`)

Compacts contact data by removing sparse fields common in WhatsApp/Slack synced contacts.

| Kept | Stripped |
|------|---------|
| id, name | null/empty fields |
| phone (if present) | metadata (JSON blob) |
| relationship (if present) | identifiers (JSON blob) |
| notes (truncated to 300 chars) | timestamps |
| source (if not 'manual') | |

## Layer 2: Generic Size Cap

After domain-specific cleaning, a hard character cap is applied to the serialized JSON.

| Tool Category | Max Chars | Rationale |
|--------------|-----------|-----------|
| Default | 50,000 | Safe limit for most tools |
| People tools (names ending in `listPeople`, `searchPeople`, `searchContacts`, `getPerson`) | 200,000 | Agent needs full contact list for consolidation jobs |
| `searchMemory` | 200,000 | Memory context is critical for agent behavior |

When truncation occurs:
1. A `[Sanitizer]` warning is logged
2. The result includes `_sanitizer: { truncated: true, originalChars, maxChars }`
3. A notification is created (visible in System Internals > Notifications)

## Integration Point

Called in `agent.js` after tool execution, before sending the result to Gemini:

```javascript
dbToolResult = sanitizeToolResult(executionName, dbToolResult);
```

The `sanitizeToolResult` function accepts an optional third parameter `maxChars` to override the default cap, but the high-cap tool logic is now built into the sanitizer itself via `HIGH_CAP_SUFFIXES`.

## Adding a New Sanitizer

1. Add a detection function: `isMyTool(toolName)` matching on tool name patterns
2. Add a sanitization function: `sanitizeMyToolResult(result)` that handles both `{ output: "JSON" }` (MCP wrapper) and direct object formats
3. Wire it into `sanitizeToolResult()` as a new Layer 1 step
4. If the tool needs a higher cap, add its suffix to `HIGH_CAP_SUFFIXES`
5. Add tests in `tool-result-sanitizer.test.js`

## Constants

| Constant | Value | Used By |
|----------|-------|---------|
| `MAX_TOOL_RESULT_CHARS` | 50,000 | Default generic cap |
| `HIGH_CAP_MAX_CHARS` | 200,000 | People + memory tools |
| `MAX_EMAIL_BODY_CHARS` | 4,000 | Gmail sanitizer |
| `MAX_EVENT_DESCRIPTION_CHARS` | 500 | Calendar sanitizer |
| `MAX_EVENT_ATTENDEES` | 10 | Calendar sanitizer |
| `MAX_PERSON_NOTES_CHARS` | 300 | People sanitizer |
