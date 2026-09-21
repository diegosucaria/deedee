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
| summary, start (flattened), end (flattened), id | etag, iCalUID, htmlLink, kind, sequence |
| location, description (500 chars) | creator, organizer metadata, reminders |
| attendees (name, email, responseStatus; max 10) | attachments, extendedProperties |
| meetingLink | Full conferenceData blob, recurringEventId |
| status (only if not "confirmed") | Calendar-level summary (email) |

The event `id` is kept since 2026-09-21: `events.get`, `patch` and `delete` ask for it, so without it a listed meeting could be read and never moved or cancelled. It adds about 8% to a week's list. `recurringEventId` stays out: one instance of a series carries the series id inside its own (`<series>_<time>`).

The list of calendars (`calendarList.list`) is cleaned on its own: each entry keeps `id`, `summary` (the owner's own name for it when he set one), `primary`, `accessRole`, `timeZone`, a short `description`, and `deleted` or `hidden` when set; colours, reminders and notification settings go. It used to pass through the events branch, which kept a calendar's name and dropped its `id`, so a shared calendar could not be read: its id is not its name.

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
| People tools (`listPeople`, `searchPeople`, `searchContacts`, `getPerson`) | 200,000 | Agent needs full contact list for consolidation jobs |
| `searchMemory` | 200,000 | Memory context is critical for agent behavior |

When truncation occurs:
1. A `[Sanitizer]` warning is logged
2. The result includes `_sanitizer: { truncated: true, originalChars, maxChars }`
3. A notification is created (visible in System Internals > Notifications)

## Integration Point

Called in `agent.js` after tool execution, before sending the result to Gemini. The calendar filter runs first:

```javascript
dbToolResult = filterCalendarResult(executionName, dbToolResult, this.settings, this.mcp?.toolMap);
dbToolResult = sanitizeToolResult(executionName, dbToolResult);
```

### Calendar Filter (Pre-Sanitizer)

**File:** `apps/agent/src/utils/calendar-filter.js`

Runs **before** the sanitizer to remove calendars the user has not configured as visible. This is a separate module because it performs access filtering (removing entire entries) rather than data cleaning (stripping fields).

| Behaviour | Detail |
|-----------|--------|
| Default (no config) | Only the primary calendar is visible |
| With config | Only calendars in the `calendarIds` allowlist are visible |
| `calendarList.list` | Filters the items array by calendar ID |
| Events responses | Goes by the calendar the call read (`params.calendarId`): a visible calendar keeps every event, another keeps none. `primary` is a nickname for the account's own address, so with a list it is visible only when that address is ticked. One event read with `events.get` follows the same list; the result of creating or changing an event is never touched, so a created meeting is never reported as an error. Free/busy is left as it comes: busy blocks only, and "when is this person free" is what it is for. An account the config does not name keeps `primary` hidden under a list. With no id to go by, an event is kept when the owner organised it, made it or is invited to it, or when it sits on an allowed shared calendar. `organizer.email` alone is not the calendar: for an invitation it is the person who sent it |

Configuration is stored per-GWS-account in `agent_settings` with key `gws_calendar_filter:{label}`. Managed via Settings > Interfaces > Google Workspace > Calendar Access.

The `sanitizeToolResult` function accepts an optional third parameter `maxChars` to override the default cap, but the high-cap tool logic is now built into the sanitizer itself via `HIGH_CAP_TOOLS`.

## Before the Call: `sanitizeToolArgs()`

Runs inside `_executeTool`, which chats, jobs, sub-agents and approved cards share, and in `POST /tools/execute`, which a voice call uses. It only touches a calendar `events.list` call.

The voice route also runs `sanitizeToolResult()` on **every** tool's result, as a chat does; until 2026-09-21 it ran neither, so a voice call got each tool's raw answer. Pictures come out first (`_images` is dropped and counted in `_imagesOmitted`, a long `image_base64` is blanked): a voice model cannot take a picture inside a tool result, and the size cap would cut the base64 in half. `LIVE_TOOL_CLEANING=0` turns the voice route's repairs and cleaning off; the calendar filter stays.

| Left out by the model | What the call gets | Why |
|---|---|---|
| `timeMax` | `timeMin` plus 7 days (`timeMin` is now when missing too) | An open range returns years of events |
| `singleEvents` (GWS shape only) | `true`, and `orderBy: 'startTime'` when no order was given | Google's default returns each recurring series once, dated at its first ever meeting, plus every cancelled one-off of it. The cleaning step drops the recurrence rule, so the model cannot tell which day a series meets. The old gsuite server set this itself; the GWS tool passes `params` through |

Measured on the device (2026-09-21), one work calendar, the past 7 days. Without `singleEvents`: 127 entries, 39 of them cancelled, 48 series dated before the window, 67,703 characters after cleaning, cut at 50,000. With it: 47 meetings, all inside the window, 29,399 characters. For the next 7 days the model saw 15 of the 45 real meetings. Over 30 days, 73% of list calls left `singleEvents` out.

A model that sets `singleEvents: false` keeps it, and gets no order (Google refuses `startTime` there). A call with a `syncToken` is left exactly as it came: Google refuses a range or an order next to one. `params` sent as a JSON string are read first; a string that will not parse leaves the call alone. A later page (`pageToken`) gets the same defaults as the first, so both pages ask the same question. `CALENDAR_SINGLE_EVENTS=0` turns the `singleEvents` default off.

## Adding a New Sanitizer

1. Add a detection function: `isMyTool(toolName)` matching on tool name patterns
2. Add a sanitization function: `sanitizeMyToolResult(result)` that handles both `{ output: "JSON" }` (MCP wrapper) and direct object formats
3. Wire it into `sanitizeToolResult()` as a new Layer 1 step
4. If the tool needs a higher cap, add it to `HIGH_CAP_TOOLS`
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
