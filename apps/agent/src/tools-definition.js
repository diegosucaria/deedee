// Tool Definitions for Gemini

const toolDefinitions = [
  {
    functionDeclarations: [
      // Memory / DB
      {
        name: "rememberFact",
        category: "memory",
        description: "Save a fact or preference to long-term memory",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Unique key (e.g., 'user_name')" },
            value: { type: "STRING", description: "Value to store" }
          },
          required: ["key", "value"]
        }
      },
      {
        name: "saveJobState",
        category: "scheduler",
        description: "Save a value to the persistent state of the current scheduled job. Use this to remember things between runs (e.g. 'last_weather_status'). ONLY works within a scheduled job.",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Key for the state (e.g., 'status')" },
            value: { type: "STRING", description: "Value to store" }
          },
          required: ["key", "value"]
        }
      },
      {
        name: "getJobState",
        category: "scheduler",
        description: "Retrieve a value from the persistent state of the current scheduled job. ONLY works within a scheduled job.",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING" } },
          required: ["key"]
        }
      },
      {
        name: "getFact",
        category: "memory",
        description: "Retrieve a fact from long-term memory",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING" } },
          required: ["key"]
        }
      },
      {
        name: "searchMemory",
        category: "memory",
        description: "Search the agent's full memory: chat history, daily journal summaries, durable facts, and vault documents. Use this for 'What did I do last Tuesday?', 'When did I talk to X about Y?', or recalling any past information.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Keyword to search for (e.g. 'grocery', 'project')" },
            limit: { type: "NUMBER", description: "Max results (default 10)" }
          },
          required: ["query"]
        }
      },
      {
        name: "searchHistory",
        category: "memory",
        description: "Search specific details from the chat history. Use this when the Context Summary is too high-level and you need exact details (e.g. 'what was the code for X?').",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The specific detail or keyword to search for." },
            limit: { type: "NUMBER", description: "Max results (default 5)" }
          },
          required: ["query"]
        }
      },
      {
        name: "consolidateMemory",
        category: "memory",
        description: "Summarize a specific day's logs into a journal entry and optionally clear raw logs. Useful for nightly maintenance.",
        parameters: {
          type: "OBJECT",
          properties: {
            date: { type: "STRING", description: "YYYY-MM-DD date to consolidate. Defaults to 'yesterday'." }
          },
          required: []
        }
      },
      {
        name: "addGoal",
        category: "goals",
        description: "Register a new high-level goal or task (e.g. 'Update code for PDF support')",
        parameters: {
          type: "OBJECT",
          properties: { description: { type: "STRING" } },
          required: ["description"]
        }
      },
      {
        name: "completeGoal",
        category: "goals",
        description: "Mark a goal as completed",
        parameters: {
          type: "OBJECT",
          properties: { id: { type: "NUMBER" } },
          required: ["id"]
        }
      },
      // Local System
      {
        name: "readFile",
        category: "filesystem",
        description: "Read a file from the local system",
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING" } },
          required: ["path"]
        }
      },
      {
        name: "writeFile",
        category: "filesystem",
        description: "Write content to a file",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING" },
            content: { type: "STRING" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "listDirectory",
        category: "filesystem",
        description: "List files in a directory",
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING" } },
          required: ["path"]
        }
      },
      {
        name: "runShellCommand",
        category: "filesystem",
        description: "Run a shell command",
        parameters: {
          type: "OBJECT",
          properties: { command: { type: "STRING" } },
          required: ["command"]
        }
      },
      {
        name: "rollbackLastChange",
        category: "filesystem",
        description: "Undoes the last code change made to the system using git revert. Use this if a recent update broke something.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "pullLatestChanges",
        category: "filesystem",
        description: "Updates the codebase by pulling the latest changes from the remote repository. IMPORTANT: Upon success, do NOT report 'I have pulled changes'. Proceed IMMEDIATELY to the next step (e.g., listDirectory, readFile).",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "commitAndPush",
        category: "filesystem",
        description: "Commits and pushes changes to the remote repository. Automatically runs 'npm test' first and fails if tests do not pass.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: { type: "STRING", description: "Commit message describing the changes. MUST use Conventional Commits format (e.g. 'feat(scope): subject'). Be descriptive." }
          },
          required: ["message"]
        }
      },
      // Productivity
      {
        name: "logJournal",
        category: "memory",
        description: "Log a note, idea, or todo to a daily markdown journal. Use this for 'Note to self', 'Remember to buy milk', etc.",
        parameters: {
          type: "OBJECT",
          properties: { content: { type: "STRING" } },
          required: ["content"]
        }
      },
      // Scheduler
      {
        name: "scheduleJob",
        category: "scheduler",
        description: "Schedule a recurring task using cron syntax. The task must be a simple description that the agent will execute later.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Unique name for the job" },
            cron: { type: "STRING", description: "Cron expression (e.g. '0 9 * * *' for daily at 9am)" },
            task: { type: "STRING", description: "Description of the task to perform (e.g. 'Check weather and send report')" },
            expiresAt: { type: "STRING", description: "Optional. ISO 8601 Date String (e.g. '2025-12-31T23:59:00') when this job should stop running and be deleted." }
          },
          required: ["name", "cron", "task"]
        }
      },
      {
        name: "listJobs",
        category: "scheduler",
        description: "List all currently scheduled jobs with details (name, schedule, task description). Use this to find a job ID before cancelling or modifying it.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "cancelJob",
        category: "scheduler",
        description: "Cancel a scheduled job by name.",
        parameters: {
          type: "OBJECT",
          properties: { name: { type: "STRING" } },
          required: ["name"]
        }
      },
      {
        name: "setReminder",
        category: "scheduler",
        description: "Set a one-time reminder for a specific date/time. The agent will message the user with the reminder content at the specified time.",
        parameters: {
          type: "OBJECT",
          properties: {
            time: { type: "STRING", description: "ISO 8601 Date String (e.g. '2025-12-31T23:59:00'). MUST be in the future." },
            message: { type: "STRING", description: "The content of the reminder (e.g. 'Buy milk', 'Call Mom')." }
          },
          required: ["time", "message"]
        }
      },
      {
        name: "scheduleTask",
        category: "scheduler",
        description: "Schedule a one-time instruction to be executed by the agent at a specific time. Use this for delayed actions like 'Turn off lights in 10 minutes' or 'Check status at 5pm'. The instruction will be processed as a command.",
        parameters: {
          type: "OBJECT",
          properties: {
            time: { type: "STRING", description: "ISO 8601 Date String (e.g., '2025-12-31T23:59:00')." },
            task: { type: "STRING", description: "The instruction to execute (e.g., 'Turn off the ACs')." }
          },
          required: ["time", "task"]
        }
      },
      // External Tools
      {
        name: "googleSearch",
        category: "search",
        description: "Perform a Google Search for quick facts, weather, news, or simple Q&A. Do NOT use this for deep research, flight booking, or interacting with pages. For those, use 'browser_navigate'.",
        parameters: {
          type: "OBJECT",
          properties: {
            prompt: { type: "STRING", description: "The search query." }
          },
          required: ["prompt"]
        }
      },
      // Image Generation
      {
        name: "generateImage",
        category: "generative",
        description: "Create/Draw/Render a NEW image using Gemini 3 Pro. Returns a base64 string. Do NOT use this to analyze images.",
        parameters: {
          type: "OBJECT",
          properties: {
            prompt: { type: "STRING", description: "Detailed prompt for the image." }
          },
          required: ["prompt"]
        }
      },
      // Smart Home Memory
      {
        name: "lookupDevice",
        category: "smarthome",
        description: "Check if the agent remembers a specific device alias (e.g., 'hallway light') and get its entity ID. usage: always call this BEFORE searching HA.",
        parameters: {
          type: "OBJECT",
          properties: { alias: { type: "STRING" } },
          required: ["alias"]
        }
      },
      {
        name: "learnDevice",
        category: "smarthome",
        description: "Teach the agent that a specific alias (e.g., 'hallway light') corresponds to an entity ID (e.g., 'light.hallway'). Call this after you successfully find a device via search.",
        parameters: {
          type: "OBJECT",
          properties: {
            alias: { type: "STRING" },
            entityId: { type: "STRING" }
          },
          required: ["alias", "entityId"]
        }
      },
      {
        name: "listDeviceAliases",
        category: "smarthome",
        description: "List all learned smart home device aliases.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "deleteDeviceAlias",
        category: "smarthome",
        description: "Remove a specific learned device alias mapping. Use this if an alias is incorrect.",
        parameters: {
          type: "OBJECT",
          properties: { alias: { type: "STRING" } },
          required: ["alias"]
        }
      },
      {
        name: "sendMessage",
        category: "communication",
        description: "Send a message to a specific user via WhatsApp or other services. Useful for initiating conversations, sending reminders to specific numbers, or replying with impersonation.",
        parameters: {
          type: "OBJECT",
          properties: {
            to: { type: "STRING", description: "The recipient's phone number or ID. For WhatsApp, just the number (e.g. 15550001234)." },
            content: { type: "STRING", description: "The message content. If type is 'image' or 'audio', this must be a base64 encoded string." },
            service: { type: "STRING", description: "Optional. Service to use. Default: 'whatsapp'." },
            session: { type: "STRING", description: "Optional. The identity/session to send FROM. Values: 'assistant' (default), 'user' (impersonation)." },
            type: { type: "STRING", description: "Optional. The type of message. Values: 'text' (default), 'image', 'audio'." },
            force: { type: "BOOLEAN", description: "Optional. Set to true to bypass the 'First Time Contact' safeguard." }
          },
          required: ["to", "content"]
        }
      },
      {
        name: "searchContacts",
        category: "communication",
        description: "Search for a contact's phone number by name. Use this to find who to text. Returns a list of matches with names and phone numbers.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Name to search for (e.g. 'Mom', 'Diego')." },
            session: { type: "STRING", description: "Optional. Session to search in. Default: 'user'." }
          },
          required: ["query"]
        }
      },
      // People Management
      {
        name: "listPeople",
        category: "people",
        description: "List all known people/contacts in the database.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "Optional. Max results to return." },
            offset: { type: "NUMBER", description: "Optional. Pagination offset." },
            query: { type: "STRING", description: "Optional. Filter by name, relationship, or phone." }
          },
          required: []
        }
      },
      {
        name: "getPerson",
        category: "people",
        description: "Get details of a specific person by ID or phone number.",
        parameters: {
          type: "OBJECT",
          properties: {
            idOrPhone: { type: "STRING", description: "The UUID or Phone number of the person." }
          },
          required: ["idOrPhone"]
        }
      },
      {
        name: "searchPeople",
        category: "people",
        description: "Fuzzy search people by name, relationship, or notes.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query." }
          },
          required: ["query"]
        }
      },
      {
        name: "updatePerson",
        category: "people",
        description: "Update details for a person.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "The person's UUID." },
            updates: {
              type: "OBJECT",
              description: "Fields to update (name, phone, relationship, notes, metadata).",
              properties: {
                name: { type: "STRING" },
                phone: { type: "STRING" },
                relationship: { type: "STRING" },
                notes: { type: "STRING" },
                metadata: { type: "STRING" } // JSON string or object handling depends on Agent
              }
            }
          },
          required: ["id", "updates"]
        }
      },
      {
        name: "deletePerson",
        category: "people",
        description: "Delete a person from the database.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" }
          },
          required: ["id"]
        }
      },
      // Watchers & WhatsApp Intelligence
      {
        name: "addWatcher",
        category: "communication",
        description: "Register a new message watcher. The agent will silently monitor incoming messages and execute the instruction ONLY when the condition is met. Use this for 'Tell me when X happens' or 'If X replies, say Y'.",
        parameters: {
          type: "OBJECT",
          properties: {
            contactString: { type: "STRING", description: "The contact name or phone number to watch (e.g. 'Mom', '1234567890')." },
            condition: { type: "STRING", description: "The condition to match. Currently supports 'contains \"keyword\"' (case-insensitive)." },
            instruction: { type: "STRING", description: "What to do when triggered. (e.g. 'Reply with \"I am busy\"' or 'Notify me')." }
          },
          required: ["contactString", "condition", "instruction"]
        }
      },
      {
        name: "readChatHistory",
        category: "communication",
        description: "Read the recent message history with a specific contact. Use this to catch up on a conversation or understand context before replying.",
        parameters: {
          type: "OBJECT",
          properties: {
            contact: { type: "STRING", description: "The contact phone number or ID (e.g. '1234567890')." },
            limit: { type: "NUMBER", description: "Optional. Number of messages to retrieve. Default is 10." },
            session: { type: "STRING", description: "Optional. 'user' (default) or 'assistant'." }
          },
          required: ["contact"]
        }
      },
      {
        name: "listConversations",
        category: "communication",
        description: "List recent active conversations from WhatsApp. Use this to see who has messaged recently.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "Optional. Number of conversations to list. Default is 10." },
            session: { type: "STRING", description: "Optional. 'user' (default) or 'assistant'." }
          },
          required: []
        }
      },
      // Audio / TTS
      {
        name: "replyWithAudio",
        category: "generative",
        description: "Generate and send an audio response (text-to-speech) to the user using Gemini TTS. FAIL if the user did NOT explicitly request an audio/voice response. Do NOT use this for simple greetings.",
        parameters: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING", description: "The text content to be converted to speech" },
            languageCode: { type: "STRING", description: "Optional. Language code for speech (e.g., 'es-419' for Spanish, 'en-US' for English). DEFAULT to the language of the 'text' content." }
          },
          required: ["text"]
        }
      },
      // Life Vaults
      {
        name: "createVault",
        category: "vault",
        description: "Create a new Life Vault for a specific topic (e.g. 'health', 'finance').",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "deleteVault",
        category: "vault",
        description: "Permanently delete a Life Vault and all its contents. Use with caution.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "listVaults",
        category: "vault",
        description: "List all existing Life Vaults and their stats.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "addToVault",
        category: "vault",
        description: "Add a file to a specific vault and update the wiki. THIS ALSO SWITCHES THE SESSION CONTEXT to that vault.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING", description: "Target vault (e.g. 'health')" },
            file_path: { type: "STRING", description: "Absolute path to the temp file to ingest (usually from a previous tool output or upload)" },
            summary: { type: "STRING", description: "Brief description of what this file is (e.g. 'Blood Test 2024')" }
          },
          required: ["topic", "file_path", "summary"]
        }
      },
      {
        name: "readVaultFile",
        category: "vault",
        description: "Read a specific file from the active vault.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            filename: { type: "STRING", description: "Name of the file to read (must exist in the vault)" }
          },
          required: ["topic", "filename"]
        }
      },
      {
        name: "readVaultPage",
        category: "vault",
        description: "Read a markdown page from a vault (defaults to index.md).",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            page: { type: "STRING", description: "Filename (e.g. 'index.md', 'summary.md')" }
          },
          required: ["topic"]
        }
      },
      {
        name: "writeVaultPage",
        category: "vault",
        description: "Create or Update a markdown page in a vault.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            page: { type: "STRING" },
            content: { type: "STRING" }
          },
          required: ["topic", "page", "content"]
        }
      },
      {
        name: "listVaultFiles",
        category: "vault",
        description: "List raw files stored in a vault.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "setSessionTopic",
        category: "vault",
        description: "Manually switch the current chat session to focus on a specific Vault topic (e.g. 'health'). This loads the vault context.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "saveNoteToVault",
        category: "vault",
        description: "Save a text note or knowledge snippet to the active vault's wiki. Use this when the user says 'Save this to the vault' or 'Remember that...'.",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            content: { type: "STRING", description: "The content/knowledge to save." }
          },
          required: ["topic", "content"]
        }
      },
      // Local RAG
      {
        name: "searchDocuments",
        category: "rag",
        description: "Search indexed vault documents (PDFs, text, images, audio, video) using semantic search. Supports cross-modal search: text queries can find relevant images, audio, and video files.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The search query." }
          },
          required: ["query"]
        }
      },
      {
        name: "ingestDocument",
        category: "rag",
        description: "Ingest a file (PDF, text, image, audio, or video) into the semantic search index using multimodal embeddings.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Absolute path to the file." }
          },
          required: ["path"]
        }
      },
      {
        name: "reindexEmbeddings",
        category: "rag",
        description: "Force re-embed all documents with the current embedding model and dimensions. Use after changing embedding settings or to improve search quality.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      // DJ Assistant
      {
        name: "add_vinyl",
        category: "dj",
        description: "Add a vinyl record to the DJ Crate. Accepts an image (cover/label/receipt) or text.",
        parameters: {
          type: "OBJECT",
          properties: {
            image_path: { type: "STRING", description: "Optional. Absolute path to local image file." }
          },
          required: []
        }
      },
      {
        name: "list_vinyls",
        description: "List all vinyl records in the user's DJ Crate. Use this to see what records are available before building a set or making recommendations.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "Max records to return (default 50)." },
            offset: { type: "NUMBER", description: "Offset for pagination (default 0)." }
          },
          required: []
        }
      },
      {
        name: "get_vinyl",
        description: "Get full details of a single vinyl record from the DJ Crate by its ID, including all tracks with BPM and key.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "The vinyl record ID." }
          },
          required: ["id"]
        }
      },
      {
        name: "search_vinyls",
        description: "Search the DJ Crate for vinyl records matching a query. Searches across artist, title, label, and catalog number.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query (artist name, track title, label, etc.)." }
          },
          required: ["query"]
        }
      },
      {
        name: "list_crate_tracks",
        description: "List ALL individual tracks/songs across all vinyls in the DJ Crate with vinyl name, track position (e.g. A1, B1), BPM, key, genre, and vinyl speed (RPM). Use this when building a DJ set or finding what songs are available to play.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "recommend_vinyl",
        category: "dj",
        description: "Get track recommendations strictly from the user's Vinyl Crate. Use this when the user is playing vinyls.",
        parameters: {
          type: "OBJECT",
          properties: {
            current_track: { type: "STRING", description: "Name of the track currently playing." }
          },
          required: ["current_track"]
        }
      },
      {
        name: "ingest_dj_history",
        category: "dj",
        description: "Ingest a playlist history file into the DJ History Vault with context metadata.",
        parameters: {
          type: "OBJECT",
          properties: {
            content: { type: "STRING", description: "The content of the history file (tracklist)." },
            venue: { type: "STRING", description: "Where the set was played." },
            date: { type: "STRING", description: "When the set was played (YYYY-MM-DD)." },
            party: { type: "STRING", description: "Name of the event/party." }
          },
          required: ["content", "venue", "date", "party"]
        }
      },
      {
        name: "recommend_digital",
        category: "dj",
        description: "Get track recommendations from Global Knowledge + History Vault. Use this for digital sets.",
        parameters: {
          type: "OBJECT",
          properties: {
            current_track: { type: "STRING", description: "Name of the track currently playing." },
            context: { type: "STRING", description: "Optional. Extra context (e.g. 'late night', 'warm up')." }
          },
          required: ["current_track"]
        }
      },
      // Wardrobe
      {
        name: "add_garment",
        category: "wardrobe",
        description: "Add a garment to the user's wardrobe from an image. Accepts a base64-encoded image.",
        parameters: {
          type: "OBJECT",
          properties: {
            image_base64: { type: "STRING", description: "Base64-encoded image data (no data: prefix)." },
            mime_type: { type: "STRING", description: "Optional MIME type (e.g. 'image/jpeg')." }
          },
          required: ["image_base64"]
        }
      },
      {
        name: "list_garments",
        category: "wardrobe",
        description: "List garments in the user's wardrobe, optionally filtered by type.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "Max garments to return (default 100)." },
            offset: { type: "NUMBER", description: "Offset for pagination." },
            type: { type: "STRING", description: "Optional filter: top|bottom|shoes|outerwear|accessory|underwear|other." }
          },
          required: []
        }
      },
      {
        name: "get_garment",
        category: "wardrobe",
        description: "Get full details of a single garment by id.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "Garment id." }
          },
          required: ["id"]
        }
      },
      {
        name: "search_garments",
        category: "wardrobe",
        description: "Search wardrobe by type, color, pattern, brand, or notes.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query." }
          },
          required: ["query"]
        }
      },
      {
        name: "update_garment",
        category: "wardrobe",
        description: "Update fields on a garment (type, subtype, color, brand, size, notes, etc.).",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "Garment id." },
            patch: {
              type: "OBJECT",
              description: "Partial fields to update. Allowed keys: type, subtype, primary_color, secondary_colors, pattern, material_guess, warmth, formality, season_tags, brand, model, size, fit_notes."
            }
          },
          required: ["id", "patch"]
        }
      },
      {
        name: "delete_garment",
        category: "wardrobe",
        description: "Delete a garment from the wardrobe by id.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "Garment id." }
          },
          required: ["id"]
        }
      },
      {
        name: "confirm_brand",
        category: "wardrobe",
        description: "Accept or reject a pending brand candidate for a garment (for items in the 'needs_brand_confirm' state).",
        parameters: {
          type: "OBJECT",
          properties: {
            garment_id: { type: "STRING", description: "Garment id." },
            accept: { type: "BOOLEAN", description: "True to accept the candidate brand/model, false to reject." }
          },
          required: ["garment_id", "accept"]
        }
      },
      {
        name: "add_to_shopping_list",
        category: "wardrobe",
        description: "Add a wanted garment to the shopping list. Useful when a recommended outfit is missing a key piece.",
        parameters: {
          type: "OBJECT",
          properties: {
            description: { type: "STRING" },
            type: { type: "STRING", description: "e.g. top|bottom|shoes|outerwear|accessory" },
            primary_color: { type: "STRING" },
            pattern: { type: "STRING" },
            material_hint: { type: "STRING" },
            context: {
              type: "OBJECT",
              description: "Optional structured context (e.g. outfit_id, reason)."
            },
            priority: { type: "STRING", description: "low|medium|high (default medium)." }
          },
          required: ["description"]
        }
      },
      {
        name: "list_shopping_items",
        category: "wardrobe",
        description: "List shopping list items, optionally filtered by status (wanted|purchased|dismissed).",
        parameters: { type: "OBJECT", properties: { status: { type: "STRING" } }, required: [] }
      },
      {
        name: "mark_wardrobe_item_purchased",
        category: "wardrobe",
        description: "Mark a wardrobe shopping list item as purchased, optionally linking to the new garment id that fulfilled it.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            garment_id: { type: "STRING", description: "Optional garment id that fulfills this shopping item." }
          },
          required: ["id"]
        }
      },
      {
        name: "dismiss_shopping_item",
        category: "wardrobe",
        description: "Dismiss a shopping item (no longer wanted).",
        parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
      },
      {
        name: "wardrobe_pack_for_trip",
        category: "wardrobe",
        description: "Plan a wardrobe travel capsule: fetches weather via subagent, reasons over wardrobe with Pro model, and saves a wr_trips row with planned_capsule and per-day outfit suggestions.",
        parameters: {
          type: "OBJECT",
          properties: {
            destination: { type: "STRING" },
            start_date: { type: "STRING", description: "YYYY-MM-DD" },
            end_date: { type: "STRING", description: "YYYY-MM-DD" },
            activities: { type: "ARRAY", items: { type: "STRING" } },
            calendar_event_id: { type: "STRING", description: "Optional linked calendar event id." }
          },
          required: ["destination", "start_date", "end_date"]
        }
      },
      {
        name: "get_wardrobe_trip",
        category: "wardrobe",
        description: "Get full details of a wardrobe trip (capsule + daily plan) by id.",
        parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
      },
      {
        name: "list_wardrobe_trips",
        category: "wardrobe",
        description: "List wardrobe trips, optionally filtered by status (planned|active|completed).",
        parameters: { type: "OBJECT", properties: { status: { type: "STRING" } }, required: [] }
      },
      {
        name: "start_wardrobe_trip",
        category: "wardrobe",
        description: "Mark a wardrobe trip as active. Copies planned_capsule into actual_capsule if empty.",
        parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
      },
      {
        name: "complete_wardrobe_trip",
        category: "wardrobe",
        description: "Mark a wardrobe trip as completed.",
        parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] }
      },
      {
        name: "set_wardrobe_trip_capsule",
        category: "wardrobe",
        description: "Overwrite a wardrobe trip's actual_capsule with the given garment ids. Use to record exactly what was actually packed.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            garment_ids: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["id", "garment_ids"]
        }
      },
      {
        name: "add_to_wardrobe_trip_capsule",
        category: "wardrobe",
        description: "Append garments to a wardrobe trip's actual_capsule. Accepts either explicit garment_ids or a photo (image_base64) that will be analyzed via analyze_outfit_photo.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            garment_ids: { type: "ARRAY", items: { type: "STRING" } },
            image_base64: { type: "STRING" },
            mime_type: { type: "STRING" }
          },
          required: ["id"]
        }
      },
      {
        name: "remove_from_wardrobe_trip_capsule",
        category: "wardrobe",
        description: "Remove garments from a wardrobe trip's actual_capsule.",
        parameters: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            garment_ids: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["id", "garment_ids"]
        }
      },
      {
        name: "critique_outfit",
        category: "wardrobe",
        description: "Evaluate an outfit, score it 0-10, list specific strengths/weaknesses, and propose a better alternative using only pieces from the wardrobe. Accepts either a photo (image_base64) or explicit garment_ids.",
        parameters: {
          type: "OBJECT",
          properties: {
            image_base64: { type: "STRING", description: "Optional photo to analyze." },
            mime_type: { type: "STRING" },
            garment_ids: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Alternative to image_base64: explicit garment ids to critique."
            },
            trip_id: { type: "STRING", description: "Optional active trip to scope alternatives within the capsule." },
            question: { type: "STRING", description: "Optional user question to anchor the critique." }
          },
          required: []
        }
      },
      {
        name: "visualize_outfit",
        category: "wardrobe",
        description: "Render a virtual-mirror image of the user wearing one or more outfits. Pass either a flat array of garment ids (single panel) or an array of arrays (multi-mirror, up to 4 panels).",
        parameters: {
          type: "OBJECT",
          properties: {
            garment_ids_panels: {
              type: "ARRAY",
              description: "Either ['id1','id2',...] for one outfit, or [['id1','id2'], ['id3','id4']] for multiple panels.",
              items: {}
            },
            layout: { type: "STRING", description: "auto|single|horizontal|grid (default auto)." },
            outfit_id: { type: "STRING", description: "Optional. Attach the render to an existing outfit id." }
          },
          required: ["garment_ids_panels"]
        }
      },
      {
        name: "set_reference_selfie",
        category: "wardrobe",
        description: "Save a full-body reference selfie used for virtual-mirror image generation. Call this the first time visualize_outfit asks for one.",
        parameters: {
          type: "OBJECT",
          properties: {
            image_base64: { type: "STRING" },
            mime_type: { type: "STRING" }
          },
          required: ["image_base64"]
        }
      },
      {
        name: "get_wardrobe_profile",
        category: "wardrobe",
        description: "Read the user's wardrobe profile (preferred brands, style notes, reference selfie status).",
        parameters: { type: "OBJECT", properties: {}, required: [] }
      },
      {
        name: "update_wardrobe_profile",
        category: "wardrobe",
        description: "Update wardrobe profile fields. Allowed keys: preferred_brands (array), sizing (object), style_notes (string).",
        parameters: {
          type: "OBJECT",
          properties: {
            patch: {
              type: "OBJECT",
              description: "Partial fields to update."
            }
          },
          required: ["patch"]
        }
      },
      {
        name: "recommend_outfit",
        category: "wardrobe",
        description: "Generate outfit proposals covering 4 buckets (weather/occasion/item/safe_repeat). Optionally scoped to a subset of garment ids or to an active trip's capsule.",
        parameters: {
          type: "OBJECT",
          properties: {
            garment_ids: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Optional. Restrict reasoning to just these garment ids."
            },
            trip_id: { type: "STRING", description: "Optional. Scope to an active trip's capsule." },
            context: { type: "STRING", description: "Free-text context: weather, occasion, vibe, dress code." },
            count: { type: "NUMBER", description: "Max proposals (default 4)." }
          },
          required: []
        }
      },
      {
        name: "like_outfit",
        category: "wardrobe",
        description: "Mark an outfit as liked (or unliked). Liked outfits bias future recommendations.",
        parameters: {
          type: "OBJECT",
          properties: {
            outfit_id: { type: "STRING" },
            liked: { type: "BOOLEAN", description: "True to like, false to unlike (default true)." }
          },
          required: ["outfit_id"]
        }
      },
      {
        name: "list_outfits",
        category: "wardrobe",
        description: "List saved outfits, optionally filtered to liked only.",
        parameters: {
          type: "OBJECT",
          properties: {
            liked: { type: "BOOLEAN", description: "Filter: true=liked only, false=unliked only, omit for all." }
          },
          required: []
        }
      },
      {
        name: "analyze_outfit_photo",
        category: "wardrobe",
        description: "Hybrid primitive for 'what should I wear' style requests. Given a photo of clothes, simultaneously matches items to the existing wardrobe AND auto-adds any unmatched garments. Returns garment ids you can then pass to recommend_outfit/visualize_outfit/critique_outfit. Use whenever the user sends a photo and asks about combinations.",
        parameters: {
          type: "OBJECT",
          properties: {
            image_base64: { type: "STRING", description: "Base64 image (no data: prefix)." },
            mime_type: { type: "STRING", description: "Optional MIME type." },
            caption: { type: "STRING", description: "Optional user caption / question." },
            trip_id: { type: "STRING", description: "Optional active trip id to scope matching to the trip's capsule." }
          },
          required: ["image_base64"]
        }
      },
      // Slack Integration
      {
        name: "searchSlack",
        category: "slack",
        description: "Search Slack messages across channels and DMs. WARNING: If the user asks to summarize messages, find tasks for the day, or asks 'what happened yesterday', DO NOT use this tool. This tool is for SPECIFIC keyword lookups ONLY. Instead, use getSlackMonitoredChannels and readSlackHistory to scan their important conversations. You MUST use Slack's advanced search syntax to filter results efficiently and avoid hitting limits. Examples: 'from:@U01P1A8BUCQ', 'in:#channel', 'has:link', 'after:2024-01-01'. IMPORTANT: When filtering by person, ALWAYS call resolveSlackUser FIRST to get their exact userId, then use 'from:@USERID' syntax. NEVER guess usernames or try multiple name variations.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The search query (e.g., 'launch plan in:#marketing from:@alice')" },
            limit: { type: "NUMBER", description: "Max results (default 10, max 50)" },
            workspace: { type: "STRING", description: "Optional. The specific workspace team ID to search. If omitted, searches all workspaces." }
          },
          required: ["query"]
        }
      },
      {
        name: "readSlackHistory",
        category: "slack",
        description: "Read recent message history from a Slack channel or DM. Use this as the PRIMARY tool to catch up on a conversation, extract summaries, or find 'tasks you need to do today' (by scanning recent history of monitored channels).",
        parameters: {
          type: "OBJECT",
          properties: {
            channel: { type: "STRING", description: "The channel ID, channel name (e.g., 'general'), or username (e.g., 'alice') to read from." },
            limit: { type: "NUMBER", description: "Max messages to retrieve (default 20, max 100)" },
            days_back: { type: "NUMBER", description: "Only retrieve messages newer than this many days ago (default 1). Set to a higher number if you need older context." },
            workspace: { type: "STRING", description: "Optional. The specific workspace team ID to read from. Crucial if scanning channels from multiple workspaces." }
          },
          required: ["channel"]
        }
      },
      {
        name: "sendSlackMessage",
        category: "slack",
        description: "Send a message to a Slack channel or DM as the user. Use this to reply to Slack conversations or send new messages.",
        parameters: {
          type: "OBJECT",
          properties: {
            channel: { type: "STRING", description: "Channel ID or name where to send the message." },
            text: { type: "STRING", description: "The message content to send." },
            thread_ts: { type: "STRING", description: "Optional. Thread timestamp to reply in a thread." },
            workspace: { type: "STRING", description: "Optional. The specific workspace team ID to send to. If omitted, attempts to auto-resolve." }
          },
          required: ["channel", "text"]
        }
      },
      {
        name: "getSlackMonitoredChannels",
        category: "slack",
        description: "Returns the list of Slack channels that the user has configured manually as 'monitored' for briefings and scheduled tasks. Returns a list of objects containing channel ID, channel names, and their respective workspace IDs. WARNING: Do not fetch these channels to read them individually in a loop! Use `readAllMonitoredSlackHistory` to get the history for all monitored channels at once efficiently.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "resolveSlackUser",
        category: "slack",
        description: "Resolve a person's name to their Slack user ID and username. ALWAYS call this FIRST when the user asks about messages from a specific person (e.g., 'what did Sean say?'). Returns the user's Slack ID, real name, display name, and email so you can use their exact ID in searchSlack queries (e.g., 'from:@U01P1A8BUCQ') or readSlackHistory. This avoids guessing usernames.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "The name (or partial name) to search for (e.g., 'Sean', 'alice')." },
            workspace: { type: "STRING", description: "Optional. The specific workspace team ID to search in. If omitted, searches all workspaces." }
          },
          required: ["name"]
        }
      },
      {
        name: "readAllMonitoredSlackHistory",
        category: "slack",
        description: "Reads the recent message history from ALL of the user's configured monitored Slack channels across all workspaces in a single optimized fetching call. Use this instead of manually calling readSlackHistory in a loop when you need to extract tasks, find mentions, or summarize the day. WARNING: The output will be very large. If you are spawning a sub-agent to use this tool to extract tasks, you MUST set `model: 'FLASH'`. CRITICAL: Because a task might be assigned in a DM but completed in a project channel, the FLASH sub-agent should simply extract a chronological summary of action items, discussions, and decisions PER CHANNEL. Do not prematurely discard tasks. The main PRO agent will use this comprehensive summary to deduce which tasks are genuinely still pending.",
        parameters: {
          type: "OBJECT",
          properties: {
            days_back: { type: "NUMBER", description: "Only retrieve messages newer than this many days ago (default 1)." }
          },
          required: []
        }
      }
    ]
  },
  // --- Sub-Agent Tools ---
  {
    functionDeclarations: [
      {
        name: "spawnAgent",
        category: "subagent",
        description: "Spawn a sub-agent to perform a specific task independently. The sub-agent runs in an isolated session with its own context and can use tools. Use this for tasks that can run in parallel or require focused execution. By default, this BLOCKS until the sub-agent completes and returns the result directly. Set waitForResult to false ONLY for fire-and-forget tasks where you do not need the result (e.g., sending a notification, background cleanup).",
        parameters: {
          type: "OBJECT",
          properties: {
            task: { type: "STRING", description: "Clear, specific task description for the sub-agent." },
            model: { type: "STRING", description: "Optional model override: 'FLASH' (default, fast/cheap) or 'PRO' (complex reasoning)." },
            tools: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Optional allowlist of tool names the sub-agent can use. Default: all tools."
            },
            timeoutMinutes: { type: "NUMBER", description: "Max execution time in minutes (default: 6, max: 10)." },
            waitForResult: { type: "BOOLEAN", description: "Default: true (blocks until done). Set to false ONLY for fire-and-forget tasks where you don't need the result." },
            lightweight: { type: "BOOLEAN", description: "If true, sub-agent gets minimal system prompt (no user facts, skills, coding rules). Use for scanner/fetch tasks that don't need user context. Default: false." }
          },
          required: ["task"]
        }
      },
      {
        name: "getAgentResult",
        category: "subagent",
        description: "Check the status and result of a previously spawned sub-agent task.",
        parameters: {
          type: "OBJECT",
          properties: {
            taskId: { type: "STRING", description: "The task ID returned by spawnAgent." }
          },
          required: ["taskId"]
        }
      },
      {
        name: "listAgentTasks",
        category: "subagent",
        description: "List all active and recent sub-agent tasks for the current session.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      }
    ]
  }
];

module.exports = { toolDefinitions };
