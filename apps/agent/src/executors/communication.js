const { BaseExecutor } = require('./base');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { taintPayloadFields } = require('../utils/untrusted-content');

class CommunicationExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { message } = context;

        switch (name) {
            case 'sendMessage': {
                const { to, content, session, service, type, imagePath } = args;
                // An owner-approved call (see services/approval-service.js) may open a first contact.
                const approved = context?.approved === true;
                console.log(`[CommunicationExecutor] Sending ${type || 'text'} to ${to} via ${service || 'whatsapp'} (Session: ${session || 'default'})${imagePath ? ` [imagePath=${imagePath}]` : ''}`);

                const svc = service || 'whatsapp';

                // ALIAS RESOLUTION
                // Trim as the approval guard does (ConfirmationManager.isOwnerTarget):
                // "me " must resolve to the owner, not search the people table.
                let target = typeof to === 'string' ? to.trim() : to;

                // Fetch owner phone from DB or Env
                let ownerPhone = process.env.MY_PHONE;
                let ownerName = 'owner'; // no owner_name set yet; the approval guard uses the same default
                let dryRun = false;

                try {
                    // Check if method exists (it should now)
                    if (services.db.getAgentSetting) {
                        const phoneSetting = services.db.getAgentSetting('owner_phone');
                        if (phoneSetting && phoneSetting.value) {
                            ownerPhone = phoneSetting.value;
                        }
                        const nameSetting = services.db.getAgentSetting('owner_name');
                        if (nameSetting && nameSetting.value) {
                            ownerName = nameSetting.value.toLowerCase();
                        }
                        const dryRunSetting = services.db.getAgentSetting('communication_dry_run');
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
                    if (services.db && services.db.searchPeople) {
                        originalSearch = target;
                        const matches = services.db.searchPeople(target);
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
                    const isVerified = services.db.isVerifiedContact(svc, cleanTo);
                    const contactName = foundPerson ? foundPerson.name : to;

                    if (!isVerified && !approved) {
                        console.log(`[CommunicationExecutor] Blocked first-time message to ${cleanTo} (no owner approval)`);
                        // The guard normally pauses this call before it gets here; this is the last line.
                        return {
                            success: false,
                            error: `SAFETY BLOCKED: first message to ${contactName} (${cleanTo}) needs the owner's approval. ` +
                                `The call resumes on its own once approved. Do not retry it and do not look for another way to send it.`
                        };
                    }

                    if (!isVerified && approved) {
                        services.db.verifyContact(svc, cleanTo);

                        // Auto-Save Alias if we found a person via search
                        if (foundPerson && originalSearch) {
                            const newNote = `\nAlias: ${originalSearch}`;
                            // Avoid duplicates
                            if (!foundPerson.notes || !foundPerson.notes.toLowerCase().includes(originalSearch.toLowerCase())) {
                                const updatedNotes = (foundPerson.notes || '') + newNote;
                                services.db.updatePerson(foundPerson.id, { notes: updatedNotes });
                                console.log(`[Communication] Added alias '${originalSearch}' to ${foundPerson.name}`);
                            }
                        }
                    }
                }

                // Construct metadata
                // WhatsApp JID format: [digits]@s.whatsapp.net. Keep an explicit
                // "@lid" suffix: LID-only contacts have no phone JID, so
                // rebuilding "@s.whatsapp.net" from their digits targets nobody.
                const jidDomain = svc === 'whatsapp' && /@lid$/i.test(target) ? 'lid' : 's.whatsapp.net';
                const metadata = {
                    chatId: `${cleanTo}@${jidDomain}`,
                    session: session || 'assistant'
                };

                let resolvedContent = content;
                let caption = null;
                if (imagePath && (type === 'image' || type === 'audio')) {
                    // Resolve through symlinks and pin to DATA_DIR. Without realpath,
                    // a symlink inside the allowed dir could point at any file on disk.
                    const dataRoot = process.env.DATA_DIR
                        || ((fs.existsSync('/app') && process.platform !== 'darwin') ? '/app/data' : path.join(process.cwd(), 'data'));
                    if (!path.isAbsolute(imagePath) || imagePath.includes('..')) {
                        return { success: false, info: `Invalid imagePath: must be an absolute path without '..' segments.` };
                    }
                    if (!fs.existsSync(imagePath)) {
                        return { success: false, info: `imagePath not found: ${imagePath}` };
                    }
                    let realPath;
                    try {
                        realPath = fs.realpathSync(imagePath);
                    } catch (e) {
                        return { success: false, info: `imagePath not readable: ${e.message}` };
                    }
                    const realRoot = fs.realpathSync(dataRoot);
                    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
                        return { success: false, info: `imagePath must resolve inside DATA_DIR (${realRoot}).` };
                    }
                    let stat;
                    try {
                        stat = fs.statSync(realPath);
                    } catch (e) {
                        return { success: false, info: `imagePath stat failed: ${e.message}` };
                    }
                    if (!stat.isFile()) {
                        return { success: false, info: `imagePath is not a regular file.` };
                    }
                    try {
                        resolvedContent = fs.readFileSync(realPath).toString('base64');
                    } catch (e) {
                        return { success: false, info: `Failed to read imagePath: ${e.message}` };
                    }
                    // When imagePath is supplied, treat the caller's `content` as an optional caption.
                    caption = typeof content === 'string' && content.length > 0 ? content : null;
                }

                const payload = {
                    source: svc,
                    content: resolvedContent,
                    metadata: metadata,
                    type: type || 'text',
                    caption: caption
                };

                // Use the interface service if available to send
                if (services.interface && services.interface.send) {
                    if (dryRun) {
                        console.log(`[CommunicationExecutor] Dry Run: Message would have been sent to ${cleanTo} (${svc})`);
                        console.log(`[CommunicationExecutor] Content: "${content}"`);
                        return { success: true, info: `Success (Dry Run): Message to ${cleanTo} skipped. Content: "${content.substring(0, 50)}..."` };
                    }
                    const logPreview = imagePath ? `[image: ${imagePath}${caption ? `; caption: "${caption}"` : ''}]` : `"${content}"`;
                    console.log(`[CommunicationExecutor] Sending to ${cleanTo} (${svc}): ${logPreview}`);

                    // A message to the owner goes through the delivery ledger,
                    // like every other owner notification: it retries with
                    // backoff and tries his other channel. A job sends its
                    // briefing here and then answers [SILENT], so a send that
                    // failed quietly was a briefing lost without a trace.
                    //
                    // The texts below are read by the model and, after an
                    // approved send, by the owner word for word. They state
                    // facts and give no orders.
                    const delivery = services.agent?.delivery;
                    const toOwner = !!(delivery && typeof delivery.deliver === 'function'
                        && typeof delivery.isOwnerTarget === 'function' && delivery.isOwnerTarget(svc, metadata.chatId));
                    const kind = message?.source === 'scheduler' ? 'job_notification' : 'reply';
                    // Every send the model asks for goes out, even an equal text.
                    // Only a copy still waiting in the queue is not queued twice.
                    const ledgerOpts = { origin: message?.metadata?.jobName ? `job:${message.metadata.jobName}` : 'sendMessage', dedupe: 'pending' };
                    const queuedText = (what) => `${what} is queued and will be retried, so it should not be sent again.`;
                    const isMedia = payload.type === 'image' || payload.type === 'audio';

                    if (toOwner && !isMedia) {
                        const outcome = await delivery.deliver(kind, svc, metadata.chatId,
                            { content: resolvedContent, type: 'text', metadata: { session: metadata.session } }, ledgerOpts);
                        if (!outcome.delivered && outcome.queued) {
                            return { success: true, status: 'queued', queued: true, info: `Not delivered to ${cleanTo} yet: the messaging service did not take it. ${queuedText('It')}` };
                        }
                        if (!outcome.delivered) {
                            return { success: false, error: `Not delivered to ${cleanTo} (${outcome.error || outcome.status || 'unknown reason'}), and nothing is queued.` };
                        }
                    } else {
                        // One direct try. A contact gets no retry: a message
                        // that arrives hours late can be worse than none. A
                        // picture or a voice note stays out of the ledger too:
                        // its row would hold megabytes, and his other channel
                        // would drop the caption.
                        const sent = await services.interface.send(payload);
                        if (sent === false && toOwner && caption) {
                            // The words matter more than the picture: they go
                            // through the ledger as text, so they still arrive.
                            const outcome = await delivery.deliver(kind, svc, metadata.chatId,
                                { content: caption, type: 'text', metadata: { session: metadata.session } }, ledgerOpts);
                            if (outcome.delivered) {
                                return { success: true, status: 'partial', info: `The picture to ${cleanTo} was not delivered. Its text went out without the picture, so it should not be sent again.` };
                            }
                            if (outcome.queued) {
                                return { success: true, status: 'queued', queued: true, info: `The picture to ${cleanTo} was not delivered. ${queuedText('Its text')}` };
                            }
                            return { success: false, error: `Neither the picture nor its text reached ${cleanTo} (${outcome.error || outcome.status || 'unknown reason'}), and nothing is queued.` };
                        }
                        if (sent !== false && toOwner && caption) {
                            // An earlier try may have queued these words as
                            // text. They have arrived now, under the picture.
                            delivery?.retirePending?.(kind, svc, metadata.chatId, caption);
                        }
                        if (sent === false) {
                            // A refusal and a timeout look the same from here, so
                            // it may have landed. Not queued, and not to be
                            // repeated blindly: a contact must not get it twice.
                            return { success: false, error: `The message to ${cleanTo} may not have been delivered: the messaging service refused it or did not answer in time. It was not queued. It should not be sent again before checking.` };
                        }
                    }

                    // Verification handled above: an approved call marks the contact verified, verified contacts skip the check
                    // Owner-chat mirroring is handled by the agent-level interface.send wrapper
                    // (apps/agent/src/agent.js _installInterfaceMirror).

                } else {
                    throw new Error('Interface service not available');
                }

                // Active Learning Intercept
                try {
                    if (services.agent && services.agent.impersonationService) {
                        // metadata.chatId is constructed above (e.g. 123@s.whatsapp.net)
                        const pendingDraft = services.agent.impersonationService.getPendingDraft(metadata.chatId);
                        if (pendingDraft) {
                            // Mark as handled
                            services.agent.impersonationService.markDraftCompleted(pendingDraft.id, 'approved'); // or 'corrected'

                            // Trigger Learning (Fire & Forget)
                            services.agent.impersonationService.learnFromCorrection(metadata.chatId, pendingDraft.content, content)
                                .catch(err => console.error('[Communication] Active Learning Error:', err.message));
                        }
                    }
                } catch (learningErr) {
                    console.warn('[Communication] Active Learning Hook Failed:', learningErr.message);
                }

                return { success: true, info: `Message sent to ${cleanTo}` };
            }

            case 'addWatcher': {
                const { contactString, condition, instruction } = args;
                console.log(`[CommunicationExecutor] Adding watcher for '${contactString}'`);
                // A tainted run's watcher keeps the taint: its runs ask before outward actions.
                const { taintSources } = taintPayloadFields(context?.untrustedTaint);
                const result = services.db.createWatcher({
                    contactString,
                    condition,
                    instruction,
                    status: 'active',
                    ...(taintSources ? { taintSources } : {})
                });
                return { success: true, info: `Watcher added. ID: ${result.lastInsertRowid}` };
            }

            case 'readChatHistory': {
                const { contact, limit, session } = args;
                console.log(`[CommunicationExecutor] reading history for ${contact}`);

                // Resolve Contact Alias First?
                // Reuse alias resolution logic? For now, assume phone or resolving inside agent if tool caller did it.
                // Assuming contact is phone number or JID.
                let jid;
                if (contact.includes('@')) {
                    jid = contact;
                } else {
                    const cleanContact = contact.replace(/[^0-9]/g, '');
                    jid = `${cleanContact}@s.whatsapp.net`;
                }

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
