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

                // ALIAS RESOLUTION
                let target = to;

                // Fetch owner phone from DB or Env
                let ownerPhone = process.env.MY_PHONE;
                let ownerName = 'diego'; // Default fallback
                let dryRun = false;

                try {
                    // Check if method exists (it should now)
                    if (this.services.db.getAgentSetting) {
                        const phoneSetting = this.services.db.getAgentSetting('owner_phone');
                        if (phoneSetting && phoneSetting.value) {
                            ownerPhone = phoneSetting.value;
                        }
                        const nameSetting = this.services.db.getAgentSetting('owner_name');
                        if (nameSetting && nameSetting.value) {
                            ownerName = nameSetting.value.toLowerCase();
                        }
                        const dryRunSetting = this.services.db.getAgentSetting('communication_dry_run');
                        if (dryRunSetting && dryRunSetting.value === true) {
                            dryRun = true;
                        }
                    }
                } catch (e) { console.warn('[Communication] Failed to fetch settings:', e); }

                const ALIASES = {
                    'me': ownerPhone,
                    'myself': ownerPhone,
                    'owner': ownerPhone,
                    [ownerName]: ownerPhone // Dynamic name
                };

                if (ALIASES[target.toLowerCase()]) {
                    target = ALIASES[target.toLowerCase()];
                    console.log(`[CommunicationExecutor] Resolved alias '${to}' to '${target}'`);
                } else if (target.match(/[a-zA-Z]/) && !target.includes('@')) {
                    // If target has letters and isn't a JID or alias, try searching People DB
                    if (this.services.db && this.services.db.searchPeople) {
                        const matches = this.services.db.searchPeople(target);
                        if (matches.length === 1 && matches[0].phone) {
                            target = matches[0].phone;
                            console.log(`[CommunicationExecutor] Resolved contact '${to}' to '${target}' (${matches[0].name})`);
                        } else if (matches.length > 1) {
                            const candidates = matches.map(m => `- ${m.name} (${m.phone})`).join('\n');
                            return {
                                success: false,
                                info: `Found multiple contacts matching "${to}". Please clarify:\n${candidates}`
                            };
                        } else {
                            // No matches found
                            return {
                                success: false,
                                info: `Could not find contact matching "${to}". Please provide a phone number or check the name.`
                            };
                        }
                    } else {
                        // DB not available or searchPeople missing
                        console.warn('[CommunicationExecutor] People DB search unavailable for name resolution.');
                    }
                }

                // Sanitize 'to' (Allow + for international, remove spaces/dashes)
                const cleanTo = target.replace(/[^0-9]/g, '');

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
                    if (dryRun) {
                        console.log(`[CommunicationExecutor] Dry Run: Message would have been sent to ${cleanTo} (${svc})`);
                        return { success: true, info: `Success (Dry Run): Message to ${cleanTo} skipped.` };
                    }
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
