# Tools Master Plan

This document tracks the status of all tools available to the Deedee agent, their implementation details, and planned future additions.

## 🛠 Existing Tools

| Tool Name | Category | Description | Implementation | Status |
|-----------|----------|-------------|----------------|--------|
| `rememberFact` | Memory | Save a fact/preference to long-term memory | `executors/memory.js` | ✅ |
| `saveJobState` | Memory | Save persistent state for a scheduled job | `executors/memory.js` | ✅ |
| `getJobState` | Memory | Retrieve persistent state for a scheduled job | `executors/memory.js` | ✅ |
| `getFact` | Memory | Retrieve a fact from memory | `executors/memory.js` | ✅ |
| `searchMemory` | Memory | Search past conversation history (regex/SQL) | `executors/memory.js` | ✅ |
| `searchHistory` | Memory | Search specific details in chat history | `executors/memory.js` | ✅ |
| `consolidateMemory` | Memory | Summarize day's logs into journal | `executors/memory.js` | ✅ |
| `addGoal` | Memory | Register a new high-level goal | `executors/memory.js` | ✅ |
| `completeGoal` | Memory | Mark a goal as completed | `executors/memory.js` | ✅ |
| `listEvents` | GSuite | List calendar events | `executors/gsuite.js` | ✅ |
| `sendEmail` | GSuite | Send an email | `executors/gsuite.js` | ✅ |
| `readFile` | System | Read a local file | `executors/filesystem.js` | ✅ |
| `writeFile` | System | Write to a local file | `executors/filesystem.js` | ✅ |
| `listDirectory` | System | List files in a directory | `executors/filesystem.js` | ✅ |
| `runShellCommand` | System | Run a shell command (YOLO mode) | `executors/filesystem.js` | ✅ |
| `rollbackLastChange` | System | Git revert last change | `executors/filesystem.js` | ✅ |
| `pullLatestChanges` | System | Git pull from remote | `executors/filesystem.js` | ✅ |
| `commitAndPush` | System | Commit and push changes | `executors/filesystem.js` | ✅ |
| `logJournal` | Productivity | Log a note to daily journal | `executors/productivity.js` | ✅ |
| `scheduleJob` | Scheduler | Schedule recurring cron task | `executors/scheduler.js` | ✅ |
| `listJobs` | Scheduler | List scheduled jobs | `executors/scheduler.js` | ✅ |
| `cancelJob` | Scheduler | Cancel a scheduled job | `executors/scheduler.js` | ✅ |
| `setReminder` | Scheduler | Set one-time reminder | `executors/scheduler.js` | ✅ |
| `scheduleTask` | Scheduler | Schedule one-time agent instruction | `executors/scheduler.js` | ✅ |
| `googleSearch` | External | Real-time Google Search | **MCP** (Fallback) | ✅ |
| `generateImage` | Generative | Generate image using Gemini 3 | `executors/media.js` | ✅ |
| `lookupDevice` | Smart Home | Find entity ID by alias | `executors/smarthome.js` | ✅ |
| `learnDevice` | Smart Home | Map alias to entity ID | `executors/smarthome.js` | ✅ |
| `listDeviceAliases` | Smart Home | List all aliases | `executors/smarthome.js` | ✅ |
| `deleteDeviceAlias` | Smart Home | Remove an alias | `executors/smarthome.js` | ✅ |
| `sendMessage` | Communication | Send WhatsApp/text message | `executors/communication.js` | ✅ |
| `replyWithAudio` | Communication | Send audio response (TTS) | `executors/communication.js` | ✅ |
| `listPeople` | Social | List all known contacts | `executors/people.js` | ✅ |
| `getPerson` | Social | Get person details by ID/Phone | `executors/people.js` | ✅ |
| `searchPeople` | Social | Search people by name/notes | `executors/people.js` | ✅ |
| `updatePerson` | Social | Update person details | `executors/people.js` | ✅ |
| `deletePerson` | Social | Delete a person | `executors/people.js` | ✅ |

## 🚧 Planned Tools (Roadmap)

| Tool Name | Category | Description | Proposed Implementation | Priority |
|-----------|----------|-------------|-------------------------|----------|
| `vectorSearch` | Memory | Semantic search over memory/history | New `VectorExecutor` / `pgvector` | High |
| `ingestDocument` | RAG | Index local PDF/Doc for RAG | New `RAGExecutor` | Medium |
| `createNotionPage` | Knowledge | Create page in Notion/Obsidian | New `KnowledgeExecutor` | Low |
| `voiceClone` | Audio | TTS with custom voice (ElevenLabs) | Update `MediaExecutor` | Low |
| `spawnAgent` | Multi-Agent | Spawn sub-agent for task | **Core Agent Logic** | ✅ Done |

## 🔧 Tool Categories & Auto-Scoping

Each tool in `tools-definition.js` has a `category` field used for automatic tool scoping of scheduled jobs:

| Category | Description | Example Tools |
|----------|-------------|---------------|
| `memory` | Remember/recall facts, search history, journal | `rememberFact`, `searchMemory`, `consolidateMemory` |
| `goals` | Goal tracking | `addGoal`, `completeGoal` |
| `scheduler` | Job scheduling, state persistence | `scheduleJob`, `saveJobState`, `getJobState` |
| `filesystem` | File I/O, shell commands, git | `readFile`, `writeFile`, `runShellCommand` |
| `search` | Web search | `googleSearch` |
| `generative` | Image generation, TTS | `generateImage`, `replyWithAudio` |
| `smarthome` | Smart home device control | `lookupDevice`, `learnDevice` |
| `communication` | WhatsApp, contacts, watchers | `sendMessage`, `searchContacts` |
| `people` | People/contacts database | `listPeople`, `searchPeople` |
| `vault` | Life Vaults document storage | `createVault`, `addToVault` |
| `rag` | Semantic document search | `searchDocuments`, `ingestDocument` |
| `dj` | DJ vinyl management | `addVinylRecord`, `getTrackRecommendations` |
| `slack` | Slack messaging and history | `readAllMonitoredSlackHistory`, `sendSlackMessage` |
| `subagent` | Sub-agent spawning | `spawnAgent` |

**MCP tools** are classified by namespace pattern:
- `*_gws_*` → `calendar_email` (Google Workspace)
- `homeassistant` server → `smarthome_mcp`
- `plex` server → `media`
- `browser` server → `browser`
- `node-red` server → `automation`

**Auto-Scoping**: When a scheduled job is created or updated, the `ToolScoper` service (`apps/agent/src/services/tool-scoper.js`) makes a single cheap LLM call to classify which categories the job needs. Only tools from relevant categories are included at runtime, significantly reducing input token costs.

## ℹ️ Notes

- **Implementation Source**: Tools are defined in `apps/agent/src/tools-definition.js` and implemented in `apps/agent/src/executors/`.
- **MCP Fallback**: If a tool is not found in `ToolExecutor` ( `apps/agent/src/tool-executor.js`), the agent attempts to call it via the MCP Manager. `googleSearch` utilizes this.
- **Security**: All System tools run with high privileges. Destructive actions rely on the Supervisor service for recovery.
