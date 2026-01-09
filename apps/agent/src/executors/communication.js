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

                // ALIAS RESOLUTION
                // target is already defined above at line 16
                let foundPerson = null;
                let originalSearch = null;



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
                    // Search DB
                    if (this.services.db && this.services.db.searchPeople) {
                        originalSearch = target;
                        const matches = this.services.db.searchPeople(target);
                        if (matches.length === 1 && matches[0].phone) {
                            foundPerson = matches[0];
                            target = matches[0].phone;
                            console.log(`[CommunicationExecutor] Resolved contact '${to}' to '${target}' (${matches[0].name})`);
                        } else if (matches.length > 1) {
                            const candidates = matches.map(m => `- ${m.name} (${m.phone})`).join('\n');
                            return {
                                success: false,
                                info: `Found multiple contacts matching "${to}". Please clarify:\n${candidates}`
                            };
                        } else {
                            // ...

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
                if (svc === 'whatsapp') {
                    const isVerified = this.services.db.isVerifiedContact(svc, cleanTo);
                    const contactName = foundPerson ? foundPerson.name : to;

                    if (!isVerified && !force) {
                        console.log(`[CommunicationExecutor] Blocked first-time message to ${cleanTo}`);
                        // Enriched Error Message
                        return {
                            success: false,
                            info: `SAFETY BLOCKED: First-time message verification required.\n\n` +
                                `Contact: ${contactName}\n` +
                                `Phone: ${cleanTo}\n\n` +
                                `Please confirm you want to send this message. If confirmed, retry with 'force: true'.`
                        };
                    }

                    if (!isVerified && force) {
                        this.services.db.verifyContact(svc, cleanTo);

                        // Auto-Save Alias if we found a person via search
                        if (foundPerson && originalSearch) {
                            const newNote = `\nAlias: ${originalSearch}`;
                            // Avoid duplicates
                            if (!foundPerson.notes || !foundPerson.notes.toLowerCase().includes(originalSearch.toLowerCase())) {
                                const updatedNotes = (foundPerson.notes || '') + newNote;
                                this.services.db.updatePerson(foundPerson.id, { notes: updatedNotes });
                                console.log(`[Communication] Added alias '${originalSearch}' to ${foundPerson.name}`);
                            }
                        }
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
                        console.log(`[CommunicationExecutor] Content: "${content}"`);
                        return { success: true, info: `Success (Dry Run): Message to ${cleanTo} skipped. Content: "${content.substring(0, 50)}..."` };
                    }
                    console.log(`[CommunicationExecutor] Sending to ${cleanTo} (${svc}): "${content}"`);
                    await this.services.interface.send(payload);

                    // Mark as verified if successful (implicit trust if we sent it successfully? No, keep explicit above)
                    // Actually, if we just sent it, we should probably mark it verified to avoid asking again?
                    // Logic above handles it for 'force'. If it was already verified, no need.

                } else {
                    throw new Error('Interface service not available');
                }

                return { success: true, info: `Message sent to ${cleanTo}` };
            }

            case 'addWatcher': {
                const { contactString, condition, instruction } = args;
                console.log(`[CommunicationExecutor] Adding watcher for '${contactString}'`);
                // Use AgentDB directly
                const result = this.services.db.createWatcher({
                    contactString,
                    condition,
                    instruction,
                    status: 'active'
                });
                return { success: true, info: `Watcher added. ID: ${result.lastInsertRowid}` };
            }

            case 'readChatHistory': {
                const { contact, limit, session } = args;
                console.log(`[CommunicationExecutor] reading history for ${contact}`);

                // Resolve Contact Alias First?
                // Reuse alias resolution logic? For now, assume phone or resolving inside agent if tool caller did it.
                // Or I can copy the resolution logic. Let's do simple cleaning first.
                // Assuming contact is phone number or JID.
                const cleanContact = contact.replace(/[^0-9]/g, '');
                const jid = `${cleanContact}@s.whatsapp.net`;

                try {
                    const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
                    const res = await axios.get(`${interfacesUrl}/whatsapp/history`, {
                        params: { jid, limit: limit || 10, session: session || 'user' },
                        headers: { Authorization: `Bearer ${process.env.DEEDEE_API_TOKEN}` }
                    });

                    const messages = res.data;
                    if (!messages || messages.length === 0) return { info: "No history found." };

                    const formatted = messages.map(m => `[${new Date(m.timestamp).toLocaleString()}] ${m.role === 'assistant' ? 'Me' : 'Them'}: ${m.content}`).join('\n');

                    return { success: true, info: `History with ${contact}:\n${formatted}` };
                } catch (e) {
                    console.error('[Communication] Failed to fetch history:', e.message);
                    return { success: false, error: "Failed to read history. Interfaces service might be down or contact invalid." };
                }
            }

            case 'listConversations': {
                const { limit, session } = args;
                try {
                    const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
                    const res = await axios.get(`${interfacesUrl}/whatsapp/recent`, {
                        params: { limit: limit || 10, session: session || 'user' },
                        headers: { Authorization: `Bearer ${process.env.DEEDEE_API_TOKEN}` }
                    });

                    const chats = res.data;
                    if (!chats || chats.length === 0) return { info: "No active conversations found." };

                    const list = chats.map(c => `- ${c.name || c.jid} (Last: ${new Date(c.lastTimestamp).toLocaleString()}) [${c.msgCount} msgs]`).join('\n');
                    return { success: true, info: `Recent Conversations:\n${list}` };
                } catch (e) {
                    console.error('[Communication] Failed to list conversations:', e.message);
                    return { success: false, error: "Failed to list conversations." };
                }
            }

            default: return null;
        }
    }
}

module.exports = { CommunicationExecutor };
