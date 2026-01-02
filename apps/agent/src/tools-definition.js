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
        name: "getFact",
        description: "Retrieve a fact from long-term memory",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING" } },
          required: ["key"]
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
        description: "Run a shell command (allowed: ls, grep, git, npm, etc)",
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
            message: { type: "STRING", description: "Commit message describing the changes" }
          },
          required: ["message"]
        }
      },
      // Audio / TTS
      {
        name: "replyWithAudio",
        description: "Generate and send an audio response (text-to-speech) to the user using Gemini 2.5. Use this ONLY when the user explicitly requests an audio/voice response.",
        parameters: {
          type: "OBJECT",
          properties: {
            text: { type: "STRING", description: "The text content to be converted to speech" }
          },
          required: ["text"]
        }
      }
    ]
  }
];

module.exports = { toolDefinitions };
