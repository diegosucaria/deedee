# Deedee 🧠

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Enabled-blue.svg)](https://www.docker.com/)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-orange.svg)](https://ai.google.dev/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/diegosucaria/deedee/graphs/commit-activity)

![Deedee Personal Agent](docs/hero.png)

**The Self-Improving Personal AI Agent for Raspberry Pi**

Deedee is an autonomous, persistent AI companion optimized for **Raspberry Pi** (it can be deployed via **Balena Cloud**). It can also run on any Docker-capable host.
It connects to your life (Telegram, Calendar, Plex, Home) and can modify its own code to learn new skills.

---

## What is this? 🤔
- **A Personal Agent**: Optimized for a SINGLE user (You).
- **Self-Improving**: Can write code, install NPM packages, and fix its own bugs.
- **Persistent**: Remembers everything. Hydrates context from a local database.
- **Microservice Arch**: Runs on Docker. Modular (Agent, Supervisor, API).
- **Secure-ish**: Designed for personal use ("YOLO Mode"). It has shell access to get things done.

## What is it NOT? 🚫
- **NOT a SaaS**: You cannot deploy one instance for 100 users. It is single-tenant.
- **NOT a "Chatbot"**: It is an Agent. It takes actions, waits for results, and can run for minutes (or hours) to solve a problem.
- **NOT Production-Safe for Enterprise**: It allows the AI to freely run commands that it thinks will help (though we have guardrails).

---

## 🚀 Quickstart

### 1. Prerequisites
- **Docker** & **Docker Compose** installed.
- **Gemini API Key** (from Google AI Studio).
- **Telegram Bot Token** (from @BotFather).

### 2. Installation
```bash
# 1. Clone the repo
git clone https://github.com/diegosucaria/deedee.git
cd deedee

# 2. Configure Environment
cp .env.example .env
nano .env
# -> Fill in GOOGLE_API_KEY and TELEGRAM_TOKEN
# -> Set WORKER_GOOGLE_SEARCH=gemini-2.5-pro (for Search Tool)
# -> Set ALLOWED_TELEGRAM_IDS to your ID (get it from @userinfobot)

# 3. Launch
docker-compose up --build
```

### 3. Usage
Open Telegram and message your bot:
> *"Hello! Who are you?"*
> *"Check my calendar for tomorrow."*
> *"Create a new tool to fetch stock prices."* (Watch it code!)

---

## ✨ Features

- **🧠 Dual-Brain Logic**: Routes fast queries to `Gemini 2.5 Flash` and complex tasks to `Gemini 3 Pro`.

Everything is customizable via environment variables. Like which models to use.
  
  ![Dual Brain Architecture](docs/dual-brain.png)

- **🗣️ Native Voice**: Replies with high-quality, low-latency audio (WAV) using Gemini TTS.
- **🛡️ Supervisor System**: An external "immune system" service that detects if the Agent breaks itself and performs a rollback.

  ![Self-Healing Loop](docs/self-healing.png)

- **🔌 MCP Integration**: Supports Model Context Protocol.
    - **Home Assistant**: "Turn on the living room light" or "Set the temperature to 22°C". Active and integrated.
    - **Plex**: "Play the movie Inception" or "Recommend me a movie I haven't seen"/
    - **GSuite**: "Calendar", "Gmail".
    - **Local**: Shell, Filesystem.
- **📱 API Gateway**: Synchronous API (`POST /v1/chat`) for iOS Shortcuts and Dashboards. Includes **Dictation Safeguards** for voice input.
- **🏠 Smart Home Intelligence**:
    - **Entity Memory**: Remembers your device names ("hallway light" → `light.hallway_main`).
    - **Adaptive Control**: Smart logic (e.g., "Turn On" always sets brightness to 100%).
- **⚡ Productivity**:
    - **Smart Notes**: "Note to self: buy milk" saves to a daily markdown journal.
    - **Morning Briefing**: `GET /v1/briefing` generates a concise audio-ready summary of your day.
- **🛑 Safety**: Global `/stop` command instantly kills any runaway agent loops.

---

## � Tools & Capabilities

Deedee comes equipped with a suite of tools, both internal and via MCP.

### Internal Tools
-   **System**: `runShellCommand`, `readFile`, `writeFile`, `listDirectory`.
-   **Git/Self-Improvement**: `pullLatestChanges`, `commitAndPush`, `rollbackLastChange`.
-   **Memory**: `rememberFact`, `getFact`, `addGoal`, `completeGoal`.
-   **Communication**: `replyWithAudio` (Native TTS), `sendEmail`.
-   **Productivity**: `listEvents` (Calendar).

### MCP Servers (Model Context Protocol)
-   **Plex**: Media library search and status (`plex_mcp_server`).
-   **Home Assistant**: Control smart home devices (`ha-mcp`).
-   *(More can be added via `apps/agent/mcp_config.json`)*

---

## �🤖 Telegram Bot Setup

1.  Open Telegram and search for **@BotFather**.
2.  Send `/newbot` and follow the instructions to name your bot.
3.  Copy the **HTTP API Token** (this is your `TELEGRAM_TOKEN`).
4.  Search for **@userinfobot**.
5.  Send `/start` to get your **ID** (this is your `ALLOWED_TELEGRAM_IDS`).

---

## 📱 iOS Shortcut Setup

You can talk to Deedee via Siri using Apple Shortcuts.

1.  **Create a new Shortcut**.
2.  **Add "Get Contents of URL"**.
3.  **URL**: `https://<your-api-url>/v1/chat` (or `http://raspberrypi.local:3001/v1/chat` if local).
4.  **Method**: `POST`.
5.  **Headers**:
    *   `Authorization`: `Bearer <YOUR_DEEDEE_API_TOKEN>`
    *   `Content-Type`: `application/json`
6.  **Request Body (JSON)**:
    ```json
    {
      "message": "Text (or 'Dictated Text' variable)",
      "source": "iphone",
      "chatId": "ios_shortcut"
    }
    ```
7.  **Parse Response**:
    *   Get `agentResponse.replies` from the result.
    *   Iterate and Speak/Show the content.

> **Tip**: Setting `source: iphone` enables special safeguards where Deedee will ask for clarification if your dictation is garbled.

## 🌅 Morning Briefing Setup

To wake up to a personalized summary:
1.  Create an iOS Automation (e.g., "When Alarm Stops").
2.  Add "Get Contents of URL":
    -   **URL**: `https://<your-api-url>/v1/briefing`
    -   **Method**: `GET`
    -   **Headers**: `Authorization: Bearer <TOKEN>`
3.  Parse JSON response (`Dictionary` -> `Value for key 'briefing'`).
4.  Add "Speak Text" action.

## 🏙️ City Weather Lock Screen

To generate a dynamic wallpaper:
1.  **URL**: `https://<your-api-url>/v1/city-image?city=London`
2.  **Method**: `GET`
    - Response is a binary PNG image.
3.  **Shortcut Action**: "Set Wallpaper" or "Save to Photo Album".

## 💻 API Usage Examples

You can interact with Deedee from your terminal or any HTTP client.

### 1. Chat (Text)
```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Check my calendar for today"}'
```

### 2. Morning Briefing (Audio Text)
```bash
curl -X GET http://localhost:3001/v1/briefing \
  -H "Authorization: Bearer <YOUR_TOKEN>"
# Returns: {"success": true, "briefing": "Good morning! It's 20°C in Córdoba..."}
```

### 3. City Weather Wallpaper (Image)
```bash
curl -X GET "http://localhost:3001/v1/city-image?city=Tokyo" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  --output wallpaper.png
# Saves 'wallpaper.png' to current directory
```

---

## 🛠️ Architecture

See the full documentation for details:

![System Architecture](docs/diagram.png)

-   **[Architecture Deep Dive](docs/architecture.md)**: Detailed system map and component breakdown.
-   **[Technical Sequence Diagrams](docs/sequence-diagrams.md)**: Visualizing the API Flow and MCP Execution.
-   **[Memory & Persistence](docs/memory.md)**: How the SQLite database and "Self-Improvement" Works.
-   **[MCP Configuration](docs/mcp-configuration.md)**: Guide to adding external tools (Home Assistant, Plex, etc).

1.  **Agent**: Node.js + LangChain/Gemini.
2.  **Supervisor**: Watchdog + Git Operations.
3.  **API**: Express Gateway.
4.  **Interfaces**: Telegram Polling Bot.

## 📄 License

MIT License. See [LICENSE](LICENSE) file.
