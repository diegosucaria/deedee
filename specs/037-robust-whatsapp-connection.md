# Robust WhatsApp Connection Specification

## 1. Problem
The current WhatsApp integration relies on the default Baileys connection logic, which can be prone to:
-   **"Zombie" Sessions**: The socket remains open but unresponsive to events.
-   **Aggressive Recycles**: Rapid disconnect/reconnect loops without backoff can trigger bans or rate limits.
-   **Silent Failures**: The agent thinks it's connected but messages aren't delivering.

## 2. Goals
1.  **Smart Reconnection**: Implement an exponential backoff strategy with jitter to be a "good citizen" and avoid server-side rate limits.
2.  **Liveness Checks**: Implement an **Application-Level Heartbeat** to detect "Zombie" states where the TCP socket is alive but the session is hung.
3.  **Self-Healing**: Automatically force a recycled connection if the heartbeat fails.

## 3. Implementation Details

### A. Reconnection Logic (The "Good Citizen" Strategy)
Instead of immediate retries, we will implement a `ReconnectionManager` or logic within `WhatsAppService` that handles the `connection.update` event.

-   **Config (Standard)**:
    -   `initialMs`: 1000ms
    -   `maxMs`: 60000ms (1 minute)
    -   `factor`: 1.5
    -   `jitter`: 0.2 (Randomness to prevent thundering herd)
    -   `maxAttempts`: Infinite.

### B. Application Heartbeat (The "Pulse")
Baileys has a WS ping, but we need to ensure the *application logic* is processing frames.

-   **Mechanism**:
    -   **Primary**: `sock.ws.ping()` every 20s (Keep TCP alive).
    -   **Secondary (App Level)**: Send a `presence` update or trivial query tone to `@s.whatsapp.net` every 60s.
    -   **Timeout**: If no response to App Level query in 10s -> Force Reconnect.
-   **Action**: `sock.end()` (Force close) -> Trigger Reconnect Logic.

### C. Architecture Changes

**`apps/interfaces/src/whatsapp.js`**

1.  **New State Variables**:
    -   `reconnectAttempts`: Track how many times we've tried.
    -   `lastHeartbeat`: Timestamp of last successful ping.
    -   `heartbeatTimer`: Interval ID.

2.  **Modifications**:
    -   **`start()`**: Initialize the connection.
    -   **`handleConnectionUpdate()`**:
        -   If `connection === 'close'`:
            -   Calculate delay using Backoff formula.
            -   Schedule `start()` after delay.
            -   Log: `Connection closed. Reconnecting in ${delay}ms (Attempt ${attempts})`.
        -   If `connection === 'open'`:
            -   Reset `reconnectAttempts = 0`.
            -   Start `startHeartbeatLoop()`.
    
    -   **`startHeartbeatLoop()`**:
        -   Set `setInterval` for 60s.
        -   In loop:
            -   Send Ping.
            -   Wait for Pong (Promise with timeout).
            -   Catch Error: Call `this.destroy()` / `this.start()` to recycle.

## 4. Risks & Mitigations
-   **Risk**: Too many pings might look suspicious?
    -   **Mitigation**: Keep interval reasonable (e.g., 60s-120s). Standard Keep-Alive is usually automated by WS, but app-level is safer for logic hangs.
-   **Risk**: Recursive loops if `start()` fails immediately.
    -   **Mitigation**: The backoff strategy protects against this.

## 5. Verification
-   **Test**: Disconnect internet, wait, reconnect. Verify backoff logs.
-   **Test**: Manually corrupt socket/kill process. Verify heartbeat catches it (simulate no pong).
