const { BaseExecutor } = require('./base');
const axios = require('axios');

class CommunicationExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { message } = context;

        switch (name) {
            case 'sendMessage': {
                const { to, content, session, service, type } = args;
                console.log(`[CommunicationExecutor] Sending ${type || 'text'} to ${to} via ${service || 'whatsapp'} (Session: ${session || 'default'})`);

                // We need to call the Interfaces API
                // The interface service url is usually known or we can use the 'interface' service wrapper if available
                // But looking at other executors, they access `this.services`.
                // Let's assume `this.services.interface` exists or we use `process.env.INTERFACES_URL`.

                // Construct metadata
                const metadata = {
                    chatId: to + '@s.whatsapp.net', // Naive formatting, ideally the tool provides full JID or we normalize
                    // But wait, 'to' might be just a number. WhatsApp expects JID. 
                    // If 'to' does not have '@s.whatsapp.net', assume it's a number.
                    session: session || 'assistant'
                };

                if (to && !to.includes('@')) {
                    metadata.chatId = `${to}@s.whatsapp.net`;
                } else if (to) {
                    metadata.chatId = to;
                }

                const payload = {
                    source: service || 'whatsapp',
                    content: content,
                    metadata: metadata,
                    type: type || 'text'
                };

                // Use the interface service if available to send
                if (this.services.interface && this.services.interface.send) {
                    await this.services.interface.send(payload);
                } else {
                    // Fallback to axios if interface service wrapper isn't rich enough or just to be safe
                    // But we don't know the URL here easily unless valid in services.
                    // Checking agent.js, services.interface is passed.
                    // Let's rely on services.interface.send
                    throw new Error('Interface service not available');
                }

                return { success: true, info: `Message sent to ${to}` };
            }

            default: return null;
        }
    }
}

module.exports = { CommunicationExecutor };
