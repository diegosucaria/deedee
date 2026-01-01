# Spec 005: MCP GSuite Server

## Objective
Implement a Model Context Protocol (MCP) Server for Google Workspace (GSuite) to allow the Agent to access Calendar and Drive.

## Components

### 1. MCP Server (`packages/mcp-servers/src/gsuite.js`)
- **Library**: `mcp-sdk` (We will mock/stub this as there isn't an official Node SDK yet, or we build a simple JSON-RPC wrapper).
- **Google APIs**: `googleapis`
- **Auth**: Service Account or User Credentials (via `GOOGLE_APPLICATION_CREDENTIALS`).

**Tools Exposed:**
1.  `calendar_list_events(timeMin, timeMax)`
2.  `calendar_create_event(summary, start, end)`
3.  `gmail_send_email(to, subject, body)`

## Scenario: "What's on my calendar?"

**Given** the Agent receives "What do I have today?".
**When** the Agent invokes `mcp_gsuite.calendar_list_events(today_start, today_end)`.
**Then** the MCP server should call Google Calendar API and return the events.

## Implementation Plan
1. Update `packages/mcp-servers/package.json` (add `googleapis`).
2. Create `packages/mcp-servers/src/gsuite/index.js`.
3. Create `packages/mcp-servers/src/gsuite/auth.js`.
4. Create test `packages/mcp-servers/tests/gsuite.test.js`.

*Note: For Phase 1, we will run this code **inside the Agent process** (as a module) rather than a separate HTTP server, to save RAM as discussed.*
