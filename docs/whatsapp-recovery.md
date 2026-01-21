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

### Level 2: The Surgical Strike (Semi-Automated)
Forces a "Soft Reset" by deleting ephemeral session sync data while keeping identity keys.
- **Action**: Deletes `app-state-sync-*` and `pre-key-*` files from `baileys_auth_user/`.
- **Preserves**: `creds.json` (Device Identity).
- **Trigger**: Manual "Repair Session" button in Settings.
- **Goal**: Force WhatsApp server to re-send history and renegotiate session keys without requiring a QR scan.
- **Status**: **Implemented** (Manual trigger).

### Level 3: The Nuke (Hard Reset)
Completely wipes the session.
- **Action**: Deletes `baileys_auth_user/` folder entirely.
- **Trigger**: Recurring `515` Stream Errors or manual "Disconnect & Wipe".
- **Goal**: Fresh start.
- **Cost**: Requires QR Code scan.
- **Status**: **Implemented**.

## Future Automation
If Level 2 proves successful in resolving the Zombie State without side effects, we can automate it:
- Monitor logs for `Timeout in AwaitingInitialSync`.
- If detected, automatically invoke `whatsappSessions.user.repairSession()`.
