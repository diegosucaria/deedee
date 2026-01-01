# Spec 004: Agent HTTP Server

## Objective
Expose the Agent via HTTP to receive messages from the Interface layer and Supervisor.

## Components

### 1. Agent Server (`apps/agent/src/server.js`)
- **Runtime**: Express
- **Port**: 3000
- **Dependencies**: `@deedee/shared`, `@deedee/agent` class.

**Endpoints:**
- `GET /health`: Status check.
- `POST /webhook`: 
    - Payload: `Message` object.
    - Logic: Pass to `agent.onMessage()`.
    - Response: `200 OK` (Async processing).

### 2. Interface Adapter (Real)
- Implement a `HttpInterface` class in the Agent that knows how to send replies back to `INTERFACES_URL`.

## Scenario: Receive Telegram Message

**Given** the Agent Server is running.
**When** `POST /webhook` is called with `{ content: "Hi", source: "telegram" ... }`.
**Then** the Agent should process the message.

## Scenario: Send Reply

**Given** the Agent wants to reply.
**When** `agent.interface.send(message)` is called.
**Then** it should `POST` to `http://interfaces:5000/send`.

## Implementation Plan
1. Create `apps/agent/src/http-interface.js`.
2. Create `apps/agent/src/server.js`.
3. Update `apps/agent/package.json` (add express, axios).
4. Update `apps/agent/src/index.js` (entry point).
