const { createAssistantMessage } = require('@deedee/shared/src/types');

class CommandHandler {
    constructor(db, interfaceObj, confirmationManager, stopFlags) {
        this.db = db;
        this.interface = interfaceObj;
        this.confirmationManager = confirmationManager;
        this.stopFlags = stopFlags;
    }

    /**
     * @returns {Object|boolean} Returns object with instruction if special handling needed, or boolean true/false
     */
    async handle(message) {
        const content = message.content?.trim();
        if (!content?.startsWith('/')) return false; // Not a command

        const chatId = message.metadata?.chatId;

        const [cmd, ...args] = content.split(' ');

        if (cmd === '/stop') {
            if (this.stopFlags) {
                this.stopFlags.add(chatId);
                this.stopFlags.add('GLOBAL_STOP');
                console.log(`[CommandHandler] Stop flag set for ${chatId} and GLOBAL_STOP`);
                await this.sendReply(chatId, message.source, 'Stopping ALL execution loops...');
            }
            return true;
        }

        if (cmd === '/clear') {
            const target = args[0]?.toLowerCase();

            if (target) {
                if (target === 'all') {
                    this.db.clearAllHistory();
                    await this.sendReply(chatId, message.source, 'WARNING: All history and sessions have been wiped.');
                } else {
                    const count = this.db.clearHistoryBySource(target);
                    await this.sendReply(chatId, message.source, `Deleted ${count} messages from source "${target}".`);
                }
            } else {
                // Default: Clear current chat
                this.db.clearHistory(chatId);
                const reply = createAssistantMessage('Current chat history cleared.');
                reply.metadata = { chatId, systemAction: 'CLEAR_HISTORY' };
                reply.source = message.source;
                await this.interface.send(reply);
            }
            return true;
        }

        if (cmd === '/clear_all' || cmd === '/delete_all_sessions') {
            this.db.clearAllHistory();
            const reply = createAssistantMessage('All chat sessions and history deleted from database.');
            reply.metadata = { chatId, systemAction: 'CLEAR_HISTORY' };
            reply.source = message.source;
            await this.interface.send(reply);
            return true;
        }

        if (cmd === '/reset_goals') {
            this.db.clearGoals(chatId);
            const reply = createAssistantMessage('Pending goals reset (marked as failed).');
            reply.metadata = { chatId };
            reply.source = message.source;
            await this.interface.send(reply);
            return true;
        }

        if (cmd === '/confirm') {
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

        if (content === '/summaries') {
            const summaries = this.db.getSummaries(5);
            let text = '## Recent Context Summaries\n';
            if (summaries.length === 0) text += '_No summaries found._';
            summaries.forEach(s => {
                text += `\n**[${s.created_at}]** (${s.range_start} -> ${s.range_end})\n> ${s.content.substring(0, 150)}...\n`;
            });
            await this.sendReply(chatId, message.source, text);
            return true;
        }

        if (content === '/clear_summaries') {
            this.db.clearSummaries();
            await this.sendReply(chatId, message.source, 'All context summaries deleted. Memory reset.');
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
