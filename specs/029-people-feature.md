# 029 - People Feature

## Goal
Enable Deedee to maintain a persistent registry of "People" (Contacts) with whom the user interacts. This includes their contact details, relationship key, connection source (e.g., WhatsApp), and arbitrary metadata. Data should be editable via UI and accessible to the Agent.

## Features
1.  **People Registry**: A database table/collection storing people.
2.  **Smart Learn**: A mechanism to scan recent WhatsApp chats, identify potential contacts, and use an LLM to infer the relationship and suggest adding them.
3.  **UI Management**: A web interface (`/people`) to view, add, edit, and delete people.
4.  **Agent Integration**: Tools for the agent to `get_person`, `search_people`, `save_person`.

## Architecture
-   **Database**: Add `Person` model (SQLite/Sequelize or Mongoose depending on current stack). *Note based on existing files: The project seems to use SQLite via `better-sqlite3` or similar in `apps/agent` based on `memory.md`, but `apps/api` might use Mongoose if it's separate? Let's assume shared DB or API specific. Need to confirm DB stack.* 
    -   *Correction*: `apps/agent` has `persistence.js`. `apps/api` usually proxies or accesses same DB.
-   **API**: REST endpoints in `apps/api` for UI CRUD.
-   **Tools**: `apps/agent/src/tools/people.js` exposing functions to the LLM.

## Data Model (Person)
```json
{
  "id": "uuid",
  "name": "Diego Sucaria",
  "phone": "+549351...", // Normalized E.164
  "handle": "diego", // Optional nickname
  "relationship": "self", // e.g. "friend", "mother", "doctor", "colleague"
  "source": "whatsapp",
  "notes": "User himself",
  "computed": {
    "last_contact": "2024-01-01T12:00:00Z",
    "interaction_count": 120
  },
  "metadata": {}
}
```

## Smart Learn Workflow (Expanded)
1.  **Trigger**: User clicks "Smart Learn" in the People view.
2.  **Analysis Phase**:
    -   System fetches the top N most active chats from `AgentDB.messages` (grouped by phone/chatId) that are *not* already in the People registry.
    -   For each candidate, the system retrieves the last 50 messages.
    -   **LLM Processing**: The Agent analyzes the conversation to answer:
        -   *Implementation Note*: Uses `@google/genai` SDK (`client.models.generateContent`) with `process.env.WORKER_FLASH`.
        -   "What is the likely name of this person?"
        -   "What is the relationship to the user?" (e.g., Mom, Boss, Plumber)
        -   "Is this a contact worth saving?" (Confidence score)
3.  **Review Phase (UI)**:
    -   User sees a list of "Suggested Contacts" with inferred Name, Relationship, and a "Why?" summary (e.g. "Frequent chats about family dinner").
    -   User can edit fields before accepting.
    -   User selects contacts to import.
4.  **Execution**:
    -   System saves confirmed contacts to DB.
    -   System attempts to fetch and cache profile thumbnails from WhatsApp.

## Tools (Agent)
-   `list_people`: Get all known people.
-   `get_person`: Get details by ID or strict phone match.
-   `search_people`: Fuzzy search by name, relationship, or notes (e.g. "Find the plumber").
-   `save_person`: Create or update.
-   `delete_person`: Remove.

## Profile Pictures
-   **Strategy**: Cache thumbnails locally to ensure UI responsiveness and privacy.
-   **Implementation**:
    -   On import/create, fetch `profilePictureUrl` from WhatsApp.
    -   Download and save to `data/avatars/[id].jpg`.
    -   Serve via `/api/people/[id]/avatar`.
    -   Background job to refresh occasionally? (Optional, V2).
