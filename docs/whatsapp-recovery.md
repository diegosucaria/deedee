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

### Level 3: The Nuke (Hard Reset)
