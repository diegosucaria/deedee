const { createAssistantMessage } = require('@deedee/shared/src/types');

class ConfirmationManager {
    constructor(db) {
        this.db = db;
        // In-memory store for pending actions: { chatId: { toolName, args, timestamp } }
        this.pendingActions = new Map();

        // Define sensitive rules
        this.rules = [
            {
                // Example: Guard turning off all lights or critical automations
                // Adjust these rules based on your "Smart Mode" preference
                condition: (name, args) => {
                    if (name === 'ha_call_service' || name === 'call_service') {
                        // Critical System Domains
                        if (args.domain === 'homeassistant') return true; // Block reload/restart
                        if (args.domain === 'hassio') return true; // Block system updates/restores

                        // Dangerous Actions
                        if (args.domain === 'automation' && args.service === 'turn_off') return true;
                        if (args.domain === 'script' && args.service.includes('delete')) return true;
                        if (args.domain === 'alarm_control_panel' && args.service === 'disarm') return true;

                        // Mass actions (safety net)
                        if (args.entity_id === 'all') return true;
                    }
                    return false;
                },
                message: '⚠️ This Home Assistant action affects the system or security and requires confirmation.'
            },
            {
                condition: (name, args) => name === 'runShellCommand' && (
                    args.command.includes('rm ') ||
                    args.command.includes(' > ') ||
                    args.command.includes('mv ') ||
                    args.command.includes('format')
                ),
                message: '⚠️ Destructive shell command requires confirmation.'
            },
            {
                condition: (name, args) => name === 'sendEmail' && !args.to.includes('@'), // loose check
                message: '⚠️ Sending email requires confirmation (Safety Check).'
            },
            {
                condition: (name, args) => {
                    const destructivePlex = [
                        'media_delete', 'playlist_delete',
                        'collection_delete', 'media_edit_metadata',
                        'playlist_edit', 'collection_edit'
                    ];
                    return destructivePlex.includes(name);
                },
                message: '⚠️ This action modifies your Plex library and requires confirmation.'
            }
        ];
    }

    /**
     * Checks if an action requires confirmation.
     * @returns {Object} { requiresConfirmation: boolean, message: string }
     */
    check(name, args) {
        for (const rule of this.rules) {
            if (rule.condition(name, args)) {
                return { requiresConfirmation: true, message: rule.message };
            }
        }
        return { requiresConfirmation: false };
    }

    store(chatId, executionName, args) {
        this.pendingActions.set(chatId, {
            name: executionName,
            args,
            timestamp: Date.now()
        });
        console.log(`[ConfirmationManager] Stored pending action for chat ${chatId}: ${executionName}`);
    }

    retrieve(chatId) {
        const action = this.pendingActions.get(chatId);
        // Optional: Expire after 5 minutes?
        if (action && Date.now() - action.timestamp > 5 * 60 * 1000) {
            this.pendingActions.delete(chatId);
            return null;
        }
        return action;
    }

    clear(chatId) {
        this.pendingActions.delete(chatId);
    }
}

module.exports = { ConfirmationManager };
