// Tool Definitions for Gemini

const toolDefinitions = [
  {
    functionDeclarations: [
      // Memory / DB
      {
        name: "rememberFact",
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
        description: "Retrieve a value from the persistent state of the current scheduled job. ONLY works within a scheduled job.",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING" } },
          required: ["key"]
        }
      },
      {
        name: "getFact",
        description: "Retrieve a fact from long-term memory",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING" } },
          required: ["key"]
        }
      },
      {
        name: "searchMemory",
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
        description: "Register a new high-level goal or task (e.g. 'Update code for PDF support')",
        parameters: {
          type: "OBJECT",
          properties: { description: { type: "STRING" } },
          required: ["description"]
        }
      },
      {
        name: "completeGoal",
        description: "Mark a goal as completed",
        parameters: {
          type: "OBJECT",
          properties: { id: { type: "NUMBER" } },
          required: ["id"]
        }
      },
      // GSuite
      {
        name: "listEvents",
        description: "List calendar events for a time range",
        parameters: {
          type: "OBJECT",
          properties: {
            timeMin: { type: "STRING" },
            timeMax: { type: "STRING" },
            maxResults: { type: "NUMBER" }
          }
        }
      },
      {
        name: "createCalendarEvent",
        description: "Create a new event in the Google Calendar. Use this when the user asks to schedule something.",
        parameters: {
          type: "OBJECT",
          properties: {
            summary: { type: "STRING", description: "Title of the event" },
            startTime: { type: "STRING", description: "Start time in ISO 8601 format (e.g. '2025-10-22T09:00:00-03:00'). PREFER including offset." },
            endTime: { type: "STRING", description: "End time in ISO 8601 format" },
            timeZone: { type: "STRING", description: "Optional. IANA Timezone (e.g. 'America/Argentina/Buenos_Aires'). Defaults to user's local timezone (America/Argentina/Buenos_Aires) if not provided." },
            description: { type: "STRING", description: "Optional description or notes for the event" }
          },
          required: ["summary", "startTime", "endTime"]
        }
      },
      {
        name: "sendEmail",
        description: "Send an email",
        parameters: {
          type: "OBJECT",
          properties: {
            to: { type: "STRING" },
            subject: { type: "STRING" },
            body: { type: "STRING" }
          },
          required: ["to", "subject", "body"]
        }
      },
      // Local System
      {
        name: "readFile",
        description: "Read a file from the local system",
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING" } },
          required: ["path"]
        }
      },
      {
        name: "writeFile",
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
        description: "List files in a directory",
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING" } },
          required: ["path"]
        }
      },
      {
        name: "runShellCommand",
        description: "Run a shell command",
        parameters: {
          type: "OBJECT",
          properties: { command: { type: "STRING" } },
          required: ["command"]
        }
      },
      {
        name: "rollbackLastChange",
        description: "Undoes the last code change made to the system using git revert. Use this if a recent update broke something.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "pullLatestChanges",
        description: "Updates the codebase by pulling the latest changes from the remote repository. IMPORTANT: Upon success, do NOT report 'I have pulled changes'. Proceed IMMEDIATELY to the next step (e.g., listDirectory, readFile).",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "commitAndPush",
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
        description: "List all currently scheduled jobs with details (name, schedule, task description). Use this to find a job ID before cancelling or modifying it.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "cancelJob",
        description: "Cancel a scheduled job by name.",
        parameters: {
          type: "OBJECT",
          properties: { name: { type: "STRING" } },
          required: ["name"]
        }
      },
      {
        name: "setReminder",
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
        description: "Check if the agent remembers a specific device alias (e.g., 'hallway light') and get its entity ID. usage: always call this BEFORE searching HA.",
        parameters: {
          type: "OBJECT",
          properties: { alias: { type: "STRING" } },
          required: ["alias"]
        }
      },
      {
        name: "learnDevice",
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
        description: "List all learned smart home device aliases.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "deleteDeviceAlias",
        description: "Remove a specific learned device alias mapping. Use this if an alias is incorrect.",
        parameters: {
          type: "OBJECT",
          properties: { alias: { type: "STRING" } },
          required: ["alias"]
        }
      },
      {
        name: "sendMessage",
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
        description: "Create a new Life Vault for a specific topic (e.g. 'health', 'finance').",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "deleteVault",
        description: "Permanently delete a Life Vault and all its contents. Use with caution.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "listVaults",
        description: "List all existing Life Vaults and their stats.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "addToVault",
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
        description: "Read a markdown page from a vault (defaults to index.md).",
        parameters: {
          type: "OBJECT",
          properties: {
            topic: { type: "STRING" },
            page: { type: "STRING", description: "Filename (e.g. 'index.md', 'summary.md')" }
          },
          required: ["topic", "page"]
        }
      },
      {
        name: "writeVaultPage",
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
        description: "List raw files stored in a vault.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "setSessionTopic",
        description: "Manually switch the current chat session to focus on a specific Vault topic (e.g. 'health'). This loads the vault context.",
        parameters: {
          type: "OBJECT",
          properties: { topic: { type: "STRING" } },
          required: ["topic"]
        }
      },
      {
        name: "saveNoteToVault",
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
        description: "Search indexed vault documents (PDFs, text files) using semantic search. Use this for finding specific information from uploaded files.",
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
        description: "Ingest a file (PDF or Text) into the semantic search index.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Absolute path to the file." }
          },
          required: ["path"]
        }
      },
      // DJ Assistant
      {
        name: "add_vinyl",
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
        name: "recommend_vinyl",
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
      // Slack Integration
      {
        name: "searchSlack",
        description: "Search Slack messages across channels and DMs. WARNING: If the user asks to summarize messages, find tasks for the day, or asks 'what happened yesterday', DO NOT use this tool. This tool is for SPECIFIC keyword lookups ONLY. Instead, use getSlackMonitoredChannels and readSlackHistory to scan their important conversations. You MUST use Slack's advanced search syntax to filter results efficiently and avoid hitting limits. Examples: 'from:@user', 'in:#channel', 'has:link', 'after:2024-01-01', or simply 'project deadline'. Do NOT just search for a generic name like 'Sean' multiple times; instead search 'from:@Sean'.",
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
        description: "Read recent message history from a Slack channel or DM. Use this as the PRIMARY tool to catch up on a conversation, extract summaries, or find 'tasks you need to do today' (by scanning recent history of monitored channels).",
        parameters: {
          type: "OBJECT",
          properties: {
            channel: { type: "STRING", description: "The channel ID, channel name (e.g., 'general'), or username (e.g., 'alice') to read from." },
            limit: { type: "NUMBER", description: "Max messages to retrieve (default 20, max 100)" },
            days_back: { type: "NUMBER", description: "Only retrieve messages newer than this many days ago (default 2). Set to a higher number if you need older context." },
            workspace: { type: "STRING", description: "Optional. The specific workspace team ID to read from. Crucial if scanning channels from multiple workspaces." }
          },
          required: ["channel"]
        }
      },
      {
        name: "sendSlackMessage",
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
        description: "Returns the list of Slack channels that the user has configured manually as 'monitored' for briefings and scheduled tasks. Returns a list of objects containing channel ID, channel names, and their respective workspace IDs. WARNING: Do not fetch these channels to read them individually in a loop! Use `readAllMonitoredSlackHistory` to get the history for all monitored channels at once efficiently.",
        parameters: {
          type: "OBJECT",
          properties: {},
          required: []
        }
      },
      {
        name: "readAllMonitoredSlackHistory",
        description: "Reads the recent message history from ALL of the user's configured monitored Slack channels across all workspaces in a single optimized fetching call. Use this instead of manually calling readSlackHistory in a loop when you need to extract tasks, find mentions, or summarize the day. WARNING: The output will be very large. If you are spawning a sub-agent to use this tool to extract tasks, you MUST set `model: 'FLASH'`. CRITICAL: When extracting tasks, you must distinguish between tasks assigned TO the user and tasks assigned to OTHERS. Only list tasks that the user is actually responsible for or explicitly tagged/asked to do.",
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
            waitForResult: { type: "BOOLEAN", description: "Default: true (blocks until done). Set to false ONLY for fire-and-forget tasks where you don't need the result." }
          },
          required: ["task"]
        }
      },
      {
        name: "getAgentResult",
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
