# Smart Home Intelligence Features

## 1. Entity Resolution Memory
**Problem**: The agent repeatedly searches for "hallway light" every time, which is slow and inefficient.
**Solution**: Cache user-defined aliases to entity IDs in a dedicated database table.

### Database Schema
New table `entity_aliases` in `agent.db`:
- `alias` (TEXT PRIMARY KEY): Normalized lowercase name (e.g., "hallway light").
- `entity_id` (TEXT): The HA entity ID (e.g., "light.hallway_main").
- `created_at` (DATETIME).

### New Tools
1.  **`lookupDevice(name)`**:
    -   Input: "hallway light"
    -   Output: `light.hallway_main` (or null).
    -   Usage: Agent calls this FIRST.
2.  **`learnDevice(name, entity_id)`**:
    -   Input: "hallway light", "light.hallway_main"
    -   Usage: Agent calls this AFTER successfully searching and identifying a device for the first time.

### Workflow
1.  User: "Turn on hallway light".
2.  Agent: `lookupDevice("hallway light")` -> null.
3.  Agent: `ha_search_entities("hallway")` -> Found `light.hallway_main`.
4.  Agent: `learnDevice("hallway light", "light.hallway_main")`.
5.  Agent: `ha_call_service(...)`.

*Next time:*
1.  User: "Turn on hallway light".
2.  Agent: `lookupDevice("hallway light")` -> `light.hallway_main`.
3.  Agent: `ha_call_service(...)`.

## 2. 100% Brightness Rule
**Problem**: "Turn on" often triggers a toggle or resumes previous dim state (e.g., 10%).
**Solution**: Enforce explicit brightness setting.

### Implementation
-   **System Prompt Rule**:
    > "SMART HOME RULES:
    > 1. When turning on a light, ALWAYS set `brightness_pct: 100` (or `brightness: 255`) unless the user asks for a specific level. Never use `toggle` for 'turn on'."
    > 2. Use `lookupDevice` before searching."

## 3. Verification
-   Test DB creation.
-   Test `learnDevice` / `lookupDevice`.
-   Verify agent prompt behavior via unit test / mock.
