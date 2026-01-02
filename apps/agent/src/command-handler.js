const { createAssistantMessage } = require('@deedee/shared/src/types');

class CommandHandler {
    constructor(db, interfaceObj) {
        this.db = db;
        this.interface = interfaceObj;
    }

    async handle(message) {
        const content = message.content?.trim();
        if (!content?.startsWith('/')) return false; // Not a command

        const chatId = message.metadata?.chatId;

        if (content === '/clear') {
            this.db.clearHistory(chatId);
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

        // Unknown command
        const reply = createAssistantMessage(`Unknown command: ${content}`);
        reply.metadata = { chatId };
        reply.source = message.source;
        await this.interface.send(reply);
        return true;
    }
}

module.exports = { CommandHandler };
