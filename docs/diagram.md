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

--- 

1. The Hero Banner (For the top of README)
Goal: Establish Deedee as a friendly, futuristic, and helpful personal assistant. Prompt:

"A cinematic wide shot of a friendly, small, spherical floating AI robot named Deedee, hovering over a Raspberry Pi on a desk. The robot projects a holographic interface showing a calendar, a weather icon, and a snippet of clean code. The lighting is moody and cozy, neon blue and purple ambient desk lights, depth of field focused on the robot. Style: High-end 3D render, tech-noir, sleek, clean, 8k resolution, aspect ratio 16:9."

2. The "Dual Brain" Router Concept (For Architecture)
Goal: Visualize the "Smart Router" that splits traffic between Gemini Flash (Speed) and Gemini Pro (Reasoning). Prompt:

"Abstract 3D isometric data visualization. A central glowing orb (The Router) splitting a stream of data into two distinct paths. Left path: High-speed, bright yellow lightning streaks symbolizing speed (Flash). Right path: complex, structured, glowing blue geometric crystal lattice symbolizing deep reasoning (Pro). Dark background, cybernetic neural network aesthetic. Clean, minimal, tech illustration."

3. The "Self-Healing" Cycle (For Self-Improvement)
Goal: Illustrate the loop of Agent -> Supervisor -> Git -> Update. Prompt:

"A stylized vector illustration of an infinite loop cycle. Four stages in the circle: 1. A robot writing on a holographic keyboard (Coding), 2. A glowing shield scanning the code (Supervisor), 3. A rocket ship launching (Deploy), 4. The robot leveling up or glowing brighter (Update). Flat 2.0 design, vibrant colors, clean lines on a dark background. Infographic style."


--- 


