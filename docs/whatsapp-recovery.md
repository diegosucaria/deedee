# WhatsApp Recovery Strategies

This document outlines the known "Zombie Session" issue and the strategies implemented to resolve it.

## The Issue: "Zombie State"
When the WhatsApp client (`Baileys`) encounters heavy session data or corruption during the initial sync, it may time out. When this happens, it defaults to a fallback behavior:
- **Forcing Online State**: It tells the server "I am online" to avoid crashing.
- **Notification Stealing**: Because the server thinks the web client is active, it stops sending notifications to the phone.
- **Silent Failure**: The client looks connected (Green) but encryption keys are out of sync, so it cannot decrypt new messages.

**Symptom**:
Logs show: `Timeout in AwaitingInitialSync, forcing state to Online`.

## Before you reach for a level: diagnostics

Each session card in Settings has a **Run diagnostics** button. It sends one presence ping, which shows the account as online for a moment, reads the blocklist, and writes nothing. The web app calls `diagnoseWhatsApp()` →
`POST /v1/whatsapp/diagnose` → `POST /whatsapp/diagnose` on the interfaces
service → `runDiagnostics()` in `apps/interfaces/src/whatsapp.js`.

The report shows the session state, a presence probe and a blocklist probe
with their times, and the store counts (contacts, messages, size). A probe that
fails, or `Socket not connected`, means a socket that is open but dead: start
at Level 1. The same report still prints in chat with `/diagnose [session]`.

## Recovery Levels

### Level 1: The Kick (Automated)
Attempts to simply disconnect and reconnect the socket.
- **Trigger**: Valid disconnects or minor network errors.
- **Goal**: Establish a fresh socket connection.
- **Status**: **Implemented** (Standard Baileys retry logic).

### Level 2.5: The Scorched Earth (Semi-Automated)
Forces a "Deep Soft Reset" designed to fix crypto/session mismatch errors without a QR scan.
- **Action**: Deletes **EVERYTHING** in `baileys_auth_user/` folder.
- **Preserves**: **ONLY** `creds.json` (Device Identity).
- **Trigger**: Manual "Repair Session" button in Settings.
- **Goal**: Force WhatsApp client to rebuild the entire session store from identity, resolving `No session found` decryption errors.
- **Status**: **Implemented** (Manual trigger).

### Level 3: The Nuke (Hard Reset)
Completely wipes the session.
- **Action**: Deletes `baileys_auth_user/` folder entirely.
- **Trigger**: Recurring `515` Stream Errors or manual "Disconnect & Wipe".
- **Goal**: Fresh start.
- **Cost**: Requires QR Code scan.
- **Status**: **Implemented**.

### Protocol Self-Healing (The Real Fix)
We have enabled the **Message Retry Mechanism** in the Baileys configuration.
- **Component**: `msgRetryCounterCache` (In-Memory Map).
- **Capability**: `getMessage` callback hooked to `SQLiteStore`.
- **Effect**: When a "No session found" error occurs, the client can now sign a "Retry Receipt" effectively asking the sender to re-encrypt and re-send the message. This prevents the "Zombie State" where messages are silently dropped.
- **Status**: **Implemented** (Automatic).

### Level 5.5: The Hidden Timer (AwaitingInitialSync)
Investigating logs revealed *another* hardcoded timeout in `lib/Socket/chats.js` that interrupts the sync if `HistorySyncNotification` isn't received within **20 seconds**.
-   **Log**: `Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer`.
-   **Fix**: Patched `chats.js` to increase this specific timeout to **120s** as well.
-   **Status**: **Implemented** (Automatic).

### Level 9: Anti-Zombie Defense (Auto-Wipe on Crypto Failure)
-   **Analysis**: Logs revealed `transaction failed` followed by `No session found` during Initial Sync. `chats.js` was swallowing this error, leaving the connection in a "Zombie" state (Open but broken) until the 2-min timeout hit.
-   **Fix**: Patched `chats.js` to detect "No session found" and immediately emit a `401 Logged Out` error.
-   **Result**: This triggers `whatsapp.js`'s existing logic to **automatically nuclear wipe** `creds.json` and the auth folder, allowing a fresh start without manual intervention.
-   **Status**: **Implemented**.

### Level 10: Resilient Sync (The "Anti-Rollback" Fix)
-   **Pivot**: User rejected "Nuclear Wipe" (Level 9).
-   **Analysis**: A single "No session found" error causes the entire sync transaction to rollback, killing the session.
-   **Fix**: Modified `chats.js` to catch this specific error, log a warning, and **SKIP** the corrupt chunk/collection.
-   **Result**: The sync process continues. Valid data is saved. Corrupt data (like `status@broadcast`) is ignored. The session stays alive.
-   **Status**: **Implemented**.

### Level 4: The Deep Dive (Buffer Timeout Patch)
We discovered that the "Zombie Session" often correlates with `Buffer timeout reached, auto-flushing`. This means the initial sync is taking longer than the hardcoded 30s limit in Baileys, causing the event buffer to flush prematurely and potentially corrupting the session state.
- **Fix**: Patched `@whiskeysockets/baileys` to increase `BUFFER_TIMEOUT_MS` from **30s** to **120s**.
- **Mechanism**: `patch-package` runs automatically on `postinstall`, ensuring the fix persists in Docker deployments.
- **Status**: **Implemented**.

### Level 11: Intelligent Backoff (The "Good Citizen" Fix)
Instead of immediate or constant-delay retries which can trigger server-side rate limits, we implemented a proper **Exponential Backoff** strategy.
-   **Algorithm**: `min(1000 * 1.5^attempts, 60000)` + 20% Jitter.
-   **Benefit**: Prevents "Thundering Herd" on server restarts and reduces ban risk.
-   **Status**: **Implemented** (v7-rc.9 integration).

### Level 12: Dual Heartbeat (Zombie Killer)
To detect "Zombie" sessions where the TCP socket is open but the session logic is dead.
-   **Mechanism**:
    1.  **TCP**: Baileys standard Pings (Every 20s).
    2.  **Application**: A loop every **60s** that sends a specific Presence Update.
        -   **User Session**: Sends `unavailable`. This serves as a heartbeat AND **enforces "Do Not Disturb"** to prevent the web client from stealing notifications from the real phone.
        -   **Assistant**: Sends `available`.
-   **Action**: If the hook fails (timeout/error), it immediately triggers a `disconnect` + `connect` cycle to refresh the socket.
-   **Status**: **Implemented**.

### Level 13: Stuck Connecting (Connect Watchdog)
On 2026-10-09 the assistant session showed **Connecting** ("Initializing...")
for four days. Its login was intact; every send failed at once with
`Connection Closed` (428), and owner messages fell back to Telegram.

-   **Cause**: WhatsApp answered a reconnect with an HTTP error and hung up.
    Baileys' `WebSocketClient` always listens for `unexpected-response`, so
    `ws` never gives up on the handshake: no `close` came, and the backoff
    never ran. `connect()` refuses to start while a try is `connecting`, and
    the heartbeat skips a session that is not connected, so nothing ended it.
-   **Fix 1**: `connect()` listens for `unexpected-response` on the socket and
    ends the try. The close carries 428 ("connection closed"), never 401: an
    HTTP 401 on the upgrade is not a logout and must not wipe the login.
-   **Fix 2 (watchdog)**: a try still `connecting` after 4 minutes
    (`CONNECT_WATCHDOG_MS`, longer than Baileys' own 3-minute connect timeout)
    is ended and retried with the Level 11 backoff. The delay grows with each
    stuck try and resets only when a connection opens. Each `connect()` takes
    a number (`connectTry`); a try that wakes up after a newer one began
    stops before it opens a socket, and events from a socket the service let
    go of are ignored. `disconnect()` also stops a try in flight.
    `WHATSAPP_CONNECT_WATCHDOG=0` turns the watchdog off.
-   **Fix 3**: a `connect()` that throws (a disk error, say) now retries with
    the backoff when the session has a login, instead of staying down.
-   **Fix 4**: the version lookup (`fetchLatestBaileysVersion` reads GitHub)
    can wait up to 5 minutes, longer than the watchdog. After 20 s
    (`VERSION_FETCH_TIMEOUT_MS`) the socket uses the version Baileys ships with.
-   **Alerts**: a session with a login on disk (a finished pairing:
    `creds.json` with `me.id`) that is not connected for 15 minutes
    (`DOWN_ALERT_MS`) sends one system alert, and a second one when it
    connects again. Each names its outage: `whatsapp_down:<session>:<outage>`
    and `whatsapp_up:<session>:<outage>`. So the agent's 6 h repeat filter
    keeps out only a retry of the same outage, and a restart or a reset that
    sent no "back" cannot hide the next outage. The agent sends "connected
    again" only for an outage whose "down" reached the owner; if that "down"
    is still waiting in the ledger, it drops both, so a stale "down" never
    arrives after "back". An alert the agent did not take is tried again
    after another 15 minutes. A session in `needs_repair` (it sent its own
    alert) or `scan_qr`, or a QR nobody scanned, sends none. A logout by
    WhatsApp (401) sends `whatsapp_logged_out:<session>` at
    once, then wipes the login as before. The owner's own Disconnect sends
    nothing: `disconnect()` lets go of the socket before `logout()`, whose
    401 close would look like WhatsApp's, and always ends it (a socket still
    connecting would otherwise log in later with the creds in memory). The
    down and logout alerts also leave a dashboard notification, since
    WhatsApp may be the channel that is down. `WHATSAPP_DOWN_ALERT=0` turns
    off the down, "connected again" and logout alerts.
-   **By hand**: restarting the `interfaces` service clears a stuck try; a
    session with its login on disk reconnects without a QR scan.
-   **Status**: **Implemented**.

### Level 3: The Nuke (Hard Reset)
