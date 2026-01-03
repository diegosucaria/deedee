# Technical Sequence Diagrams

These diagrams illustrate the internal data flow of Deedee.

## 1. Synchronous API Flow (iOS Shortcuts)
Unlike the asynchronous Telegram bot, the API Service keeps the HTTP connection open until the Agent has fully processed the request (including all tool calls). This allows Siri/iOS to speak the final answer immediately.

```mermaid
sequenceDiagram
    participant User as iOS Shortcut
    participant API as API Service (3001)
    participant Agent as Agent (3000)
    participant Router
    participant Tool as MCP/Internal Tool
    participant LLM as Gemini

    User->>API: POST /v1/chat (JSON)
    activate API
    API->>Agent: POST /chat (Wait for completion)
    activate Agent
    
    Agent->>Router: Classify Intent
    Router-->>Agent: Use "Flash" + Tools
    
    loop Reasoning Loop
        Agent->>LLM: Generate Content
        LLM-->>Agent: Tool Call (e.g. plex_search)
        Agent->>Tool: Execute Tool
        Tool-->>Agent: Result
    end

    Agent->>LLM: Final Answer
    LLM-->>Agent: "Playing Movie..."
    
    Agent-->>API: { replies: [...] }
    deactivate Agent
    
    API-->>User: 200 OK (Clean Response)
    deactivate API
    User->>User: Speak "Playing Movie..."
```

## 2. MCP Tool Execution (Stdio Transport)
This diagram shows how the Agent orchestrates external processes (like Python scripts) using the Model Context Protocol.

```mermaid
sequenceDiagram
    participant Agent
    participant MCP as MCPManager
    participant Proc as Child Process (uvx/python)
    participant Server as MCP Server (Plex/HA)

    Note over Agent,Server: Initialization Phase
    Agent->>MCP: init()
    MCP->>Proc: spawn(command, args)
    activate Proc
    Proc->>Server: Start Script
    activate Server
    Server-->>MCP: Capabilities & Tools List (JSON-RPC)
    MCP-->>Agent: Tools Ready (Cached)

    Note over Agent,Server: Execution Phase
    Agent->>MCP: executeTool("plex_search", {query:"Matrix"})
    MCP->>Server: call_tool("plex_search")
    Server->>Server: Query Plex API
    Server-->>MCP: Tool Result
    MCP-->>Agent: Result Object
```
