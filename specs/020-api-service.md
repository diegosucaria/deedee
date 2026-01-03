# Spec 020: API Service (Microservice)

## 1. Objective
Create a dedicated API microservice (`apps/api`) to act as the secure entry point for external programmatic clients (iOS Shortcuts, Dashboards, Frontends). It will handle authentication and forward valid messages to the Agent.

## 2. Rationale
- **Security**: The `apps/agent` webhook is currently unauthenticated (internal only). We need a public-facing (or exposed) layer with strict Auth.
- **Decoupling**: Validates inputs and handles API keys separate from the core agent logic.
- **Future-Proofing**: Will serve as the backend for the future React/Web frontend.

## 3. Architecture
- **Port**: `3001` (to avoid collision with Agent:3000, Supervisor:4000, Interfaces:5000).
- **Stack**: Node.js + Express.
- **Auth**: `Authorization: Bearer <API_TOKEN>`
    - Token stored in `process.env.DEEDEE_API_TOKEN`.
- **Target**: Forwards requests to `AGENT_URL` (default: `http://localhost:3000`).

## 4. Endpoints

### `POST /v1/chat`
Accepts a JSON payload to send a message to the agent.

**Headers:**
- `Authorization: Bearer <TOKEN>`
- `Content-Type: application/json`

**Body:**
```json
{
  "message": "Hello from iOS",
  "source": "ios_shortcut", // optional, default: 'api'
  "chatId": "user_id_123" // required to maintain context
}
```

**Response:**
- `200 OK`: 
  ```json
  {
    "success": true,
    "agentResponse": {
      "replies": [
        { "content": "Thinking...", "type": "text" },
        { "content": "Hello!", "type": "text" }
      ]
    }
  }
  ```
- `401 Unauthorized`: Invalid Token.
- `400 Bad Request`: Missing fields.

## 5. Implementation Steps
1.  **Scaffold**: Create `apps/api` folder with `package.json`, `Dockerfile`.
2.  **Dependencies**: `express`, `axios`, `dotenv`, `cors`.
3.  **Code**:
    - `src/server.js`: Main entry point.
    - `src/middleware/auth.js`: Token validator.
    - `src/routes/chat.js`: Handler.
4.  **Integration**:
    - Update `docker-compose.yml` (if applicable) or Balena setup to include the new service.
    - **Note**: Since this is a monorepo, update root `package.json` workspaces if needed (or just ensure it builds).
5.  **Environment**: Add `DEEDEE_API_TOKEN` to env.

## 6. Verification
- `curl` request with and without token.
- Verify Agent receives the message via logs.
