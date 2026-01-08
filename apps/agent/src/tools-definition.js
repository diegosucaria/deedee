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
        description: "Search past conversation history for specific keywords. Use this for 'What did I do yesterday?' or finding old context.",
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
        description: "Perform a Google Search to get real-time information (weather, news, stocks, facts).",
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
        description: "Generate an image using Gemini 3 Pro. Returns a base64 string.",
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
            type: { type: "STRING", description: "Optional. The type of message. Values: 'text' (default), 'image', 'audio'." }
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
      }
    ]
  }
];

module.exports = { toolDefinitions };
