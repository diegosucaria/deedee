const { BaseExecutor } = require('./base');
const axios = require('axios');

class CommunicationExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { message } = context;

        switch (name) {
            case 'sendMessage': {
                const { to, content, session, service, type, force } = args;
                console.log(`[CommunicationExecutor] Sending ${type || 'text'} to ${to} via ${service || 'whatsapp'} (Session: ${session || 'default'})`);

                const svc = service || 'whatsapp';

                // Sanitize 'to' (Remove non-digits)
                // This fixes the 'invalid JID' error when 'to' contains '+' or spaces
                const cleanTo = to.replace(/[^0-9]/g, '');

                if (!cleanTo || cleanTo.length < 5) {
                    throw new Error(`Invalid phone number: ${to}`);
                }

                // Check "First Time Contact" Safeguard
                // Only for WhatsApp for now as email isn't critical
                if (svc === 'whatsapp') {
                    const isVerified = this.services.db.isVerifiedContact(svc, cleanTo);

                    if (!isVerified && !force) {
                        // We interpret this as a "Soft Failure" that prompts the agent to ask the user.
                        // We return a string explaining the situation.
                        console.log(`[CommunicationExecutor] Blocked first-time message to ${cleanTo}`);
                        return {
                            success: false,
                            info: `SAFETY BLOCKED: You are trying to message ${cleanTo} for the first time. Please confirm with the user. If confirmed, retry with 'force: true'.`
                        };
                    }

                    // If we are here, we either are verified or forced.
                    // If forced, we verify now.
                    if (!isVerified && force) {
                        this.services.db.verifyContact(svc, cleanTo);
                    }
                }

                // Construct metadata
                // WhatsApp JID format: [digits]@s.whatsapp.net
                const metadata = {
                    chatId: `${cleanTo}@s.whatsapp.net`,
                    session: session || 'assistant'
                };

                const payload = {
                    source: svc,
                    content: content,
                    metadata: metadata,
                    type: type || 'text'
                };

                // Use the interface service if available to send
                if (this.services.interface && this.services.interface.send) {
                    await this.services.interface.send(payload);

                    // Mark as verified if successful (implicit trust if we sent it successfully? No, keep explicit above)
                    // Actually, if we just sent it, we should probably mark it verified to avoid asking again?
                    // Logic above handles it for 'force'. If it was already verified, no need.

                } else {
                    throw new Error('Interface service not available');
                }

                return { success: true, info: `Message sent to ${cleanTo}` };
            }

            default: return null;
        }
    }
}

module.exports = { CommunicationExecutor };
