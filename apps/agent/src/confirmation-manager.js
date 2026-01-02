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
                    if (name === 'homeassistant' || name === 'call_service') { // Adjust based on actual tool name in definition
                        // If it's a critical domain/service
                        if (args.domain === 'automation' && args.service === 'turn_off') return true;
                        if (args.domain === 'script' && args.service.includes('delete')) return true;
                        if (args.domain === 'alarm_control_panel' && args.service === 'disarm') return true;
                    }
                    return false;
                },
                message: '⚠️ Disabling an automation or security system requires confirmation.'
            },
            {
                condition: (name, args) => name === 'runShellCommand' && (args.command.includes('rm -rf') || args.command.includes('format')),
                message: '⚠️ Destructive shell command requires confirmation.'
            },
            {
                condition: (name, args) => name === 'sendEmail' && !args.to.includes('@'), // loose check
                message: '⚠️ Sending email requires confirmation (Safety Check).'
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
