const { createAssistantMessage } = require('@deedee/shared/src/types');

class CommandHandler {
    constructor(db, interfaceObj, confirmationManager) {
        this.db = db;
        this.interface = interfaceObj;
        this.confirmationManager = confirmationManager;
    }

    /**
     * @returns {Object|boolean} Returns object with instruction if special handling needed, or boolean true/false
     */
    async handle(message) {
        const content = message.content?.trim();
        if (!content?.startsWith('/')) return false; // Not a command

        const chatId = message.metadata?.chatId;

        if (content === '/clear') {
            this.db.clearHistory(chatId);
            // Also message to user...
            const reply = createAssistantMessage('Chat history cleared.');
            reply.metadata = { chatId };
            reply.source = message.source;
            await this.interface.send(reply);
            return true;
        }

        if (content === '/reset_goals') {
            this.db.clearGoals(chatId);
            const reply = createAssistantMessage('Pending goals reset (marked as failed).');
            reply.metadata = { chatId };
            reply.source = message.source;
            await this.interface.send(reply);
            return true;
        }

        if (content === '/confirm') {
            if (!this.confirmationManager) {
                await this.sendReply(chatId, message.source, 'Confirmation manager not initialized.');
                return true;
            }
            const pending = this.confirmationManager.retrieve(chatId);
            if (!pending) {
                await this.sendReply(chatId, message.source, 'No pending action to confirm.');
                return true;
            }
            // Clear it
            this.confirmationManager.clear(chatId);
            // Return instruction to Agent to execute
            return { type: 'EXECUTE_PENDING', action: pending };
        }

        if (content === '/cancel') {
            if (this.confirmationManager) {
                this.confirmationManager.clear(chatId);
                await this.sendReply(chatId, message.source, 'Action cancelled.');
            }
            return true;
        }

        // Unknown command
        await this.sendReply(chatId, message.source, `Unknown command: ${content}`);
        return true;
    }

    async sendReply(chatId, source, text) {
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId };
        reply.source = source;
        await this.interface.send(reply);
    }
}

module.exports = { CommandHandler };
