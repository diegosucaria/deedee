```bash 
                                  +---------------------+
                                  |   Google Cloud      |
                                  |  (Gemini + GSuite)  |
                                  +----------^----------+
                                             | HTTP/API
                                             |
+--------------------------------------------v---------------------------------------------+
|                                    RASPBERRY PI (Balena)                                 |
|                                                                                          |
|  +-------------------+        +----------------------+        +-----------------------+  |
|  |   APPS/INTERFACES |        |      APPS/AGENT      |        |    APPS/SUPERVISOR    |  |
|  | (The Ears/Mouth)  |        |      (The Brain)     |        |   (The Immune System) |  |
|  |                   |  HTTP  |                      |  HTTP  |                       |  |
|  |  [Telegram Poller]+------->+  [Express Server]    +------->+   [Git Ops Server]    |  |
|  |  [Slack Socket]   |<-------+  [Gemini Client]     |        |                       |  |
|  |                   |        |  [MCP Clients]       |        |   +---------------+   |  |
|  +---------^---------+        |     |      |         |        |   |  Local Repo   |   |  |
|            |                  |     |      |         |        |   | (/app/source) |   |  |
|            |                  |     v      v         |        |   +-------^-------+   |  |
|            |                  +--[SQLite]--[Filesystem]       +-----------|-----------+  |
|            |                                                              |              |
+------------|--------------------------------------------------------------|--------------+
             |                                                              |
      +------v------+                                                 +-----v------+
      | Chat Apps   |                                                 |   GitHub   |
      | (Telegram)  |                                                 | (CI/CD)    |
      +-------------+                                                 +------------+
```


Prompt: "Create a system architecture diagram for a personal AI agent running on a Raspberry Pi.

Nodes:

Users (Telegram/Slack)
Interfaces Container (Node.js service handling chat polling)
Agent Container (The main brain, Node.js + Gemini AI)
Supervisor Container (System management, Git operations)
External Services: Google Gemini API, Google Workspace (Calendar/Gmail), GitHub.
Storage: SQLite DB (inside Agent), Local Filesystem (Source Code).
Connections:

Users send messages to Interfaces via Telegram/Slack APIs.
Interfaces posts messages to Agent via HTTP (Port 3000).
Agent calls Google Gemini API for reasoning.
Agent calls Google Workspace for tools.
Agent reads/writes to SQLite and Local Filesystem.
Agent sends system commands (like 'update') to Supervisor via HTTP (Port 4000).
Supervisor performs 'Git Push/Pull' to GitHub.
GitHub triggers Balena Cloud to update the Raspberry Pi containers.
Style: Modern, microservices layout, highlighting the Agent as the central node."

