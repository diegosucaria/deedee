# Spec 001: Core Agent Hello World

## Objective
Establish the foundational loop of the Agent: Receive Message -> Process (LLM) -> Send Response.

## Components

### 1. Agent Class (`@deedee/agent`)
The core class that initializes the LLM client and manages the conversation loop.

**Interface:**
```javascript
class Agent {
  constructor(config);
  async start();
  async onMessage(message); // Message { content: string, source: string, userId: string }
}
```

### 2. Mock Interface (`@deedee/interfaces`)
A simple in-memory interface for testing.

**Interface:**
```javascript
class MockInterface extends EventEmitter {
  send(content); // Emits 'message' event
  receive(response); // Stores response for assertion
}
```

## Scenario 1: Basic Greeting

**Given** a configured Agent connected to a Mock Interface.
**When** the Mock Interface receives "Hello, who are you?".
**Then** the Agent should use Gemini to generate a response.
**And** the response should contain "Deedee".

## Implementation Plan
1. Create `packages/shared/src/types.js` (Message definition).
2. Create `packages/interfaces/src/mock.js`.
3. Create `apps/agent/src/agent.js`.
4. Create test `apps/agent/tests/smoke.test.js`.
