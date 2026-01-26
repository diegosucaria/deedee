# WhatsApp Recovery Strategies

This document outlines the known "Zombie Session" issue and the strategies implemented to resolve it.

## The Issue: "Zombie State"
When the WhatsApp client (`Baileys`) encounters heavy session data or corruption during the initial sync, it may time out. When this happens, it defaults to a fallback behavior:
- **Forcing Online State**: It tells the server "I am online" to avoid crashing.
- **Notification Stealing**: Because the server thinks the web client is active, it stops sending notifications to the phone.
- **Silent Failure**: The client looks connected (Green) but encryption keys are out of sync, so it cannot decrypt new messages.

**Symptom**:
Logs show: `Timeout in AwaitingInitialSync, forcing state to Online`.

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

### Level 3: The Nuke (Hard Reset)
