const axios = require('axios');
const { ConfigService } = require('./config-service');

class ImpersonationService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
        this._config = new ConfigService();
        this.messageBuffers = new Map(); // Store buffered messages by chatId
    }

    getOwnerName() {
        try {
            const row = this.db.db.prepare("SELECT value FROM agent_settings WHERE key = 'owner_name'").get();
            if (row && row.value) return row.value;
            // Fallback
            const userRow = this.db.db.prepare("SELECT value FROM agent_settings WHERE key = 'user_name'").get();
            return userRow ? userRow.value : 'Diego';
        } catch (e) {
            return 'Diego';
        }
    }

    /**
     * Get the global style profile from settings
     */
    getStyleProfile() {
        const row = this.db.db.prepare("SELECT value FROM agent_settings WHERE key = 'user_style_profile'").get();
        if (!row) return null;
        try {
            return JSON.parse(row.value).profile;
        } catch (e) {
            return null;
        }
    }

    /**
     * Save the global style profile
     */
    saveStyleProfile(profileText) {
        const value = JSON.stringify({ profile: profileText });
        this.db.db.prepare(`
            INSERT INTO agent_settings (key, value, category) VALUES ('user_style_profile', ?, 'autopilot')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(value);
    }

    /**
     * Analyze global history to generate a style profile
     */
    async analyzeGlobalStyle() {
        console.warn('[Impersonation] Global Style Analysis is DISABLED in Autopilot 2.0. Please use Manual Global Instructions.');
        return "Global Analysis Disabled. Use Manual Instructions.";
    }

    /**
     * Get style profile for a specific contact
     */
    getContactStyle(contactIdOrPhone) {
        // Try strict ID first, then phone match
        let person = this.db.getPerson(contactIdOrPhone);
        if (!person && contactIdOrPhone.includes('@')) {
            // It's a JID, try to find by phone (remove suffix)
            const phone = contactIdOrPhone.split('@')[0];
            // Fuzzy verify? or just try getPerson again if getPerson handles phone numbers (it does)
            person = this.db.getPerson(phone);
        }

        if (!person) return null;

        let styleProfile = null;
        if (person.metadata) {
            try {
                // db.getPerson already parses JSON, but if used raw it might be string.
                let meta = typeof person.metadata === 'string' ? JSON.parse(person.metadata) : person.metadata;

                // Handle double-encoded legacy data
                if (typeof meta === 'string') {
                    try { meta = JSON.parse(meta); } catch (e) { }
                }
                styleProfile = meta.style_profile || null;
            } catch (e) {
                // parsing error
            }
        }

        return styleProfile;
    }

    getPersonRelationship(contactIdOrPhone) {
        let person = this.db.getPerson(contactIdOrPhone);
        if (!person && contactIdOrPhone.includes('@')) {
            const phone = contactIdOrPhone.split('@')[0];
            person = this.db.getPerson(phone);
        }
        return person ? (person.relationship || null) : null;
    }

    /**
     * Save style profile for a specific contact
     */
    saveContactStyle(contactIdOrPhone, profileText) {
        let person = this.db.getPerson(contactIdOrPhone);

        // If searching by JID failed, try stripped phone
        if (!person && contactIdOrPhone.includes('@')) {
            person = this.db.getPerson(contactIdOrPhone.split('@')[0]);
        }

        if (!person) throw new Error("Person not found");

        let meta = {};
        try {
            const rawMeta = person.metadata || {};
            meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
            // Handle double-encoded legacy data
            if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch (e) { }
            }
        } catch (e) { }

        // Ensure meta is an object
        if (typeof meta !== 'object' || meta === null) meta = {};

        meta.style_profile = profileText;

        // Pass OBJECT, do not stringify (DB layer handles it)
        this.db.updatePerson(person.id, { metadata: meta });
    }

    /**
     * Analyze style for a specific contact chat
     */
    async analyzeContactStyle(contactIdentifier) {
        console.log(`[Impersonation] Analyzing style for contact ${contactIdentifier}...`);

        // Resolve JID/Phone from Identifier (which could be UUID)
        let chatId = contactIdentifier;
        // Simple check if it's a UUID (no @, no spaces, length > 20)
        if (!chatId.includes('@') && chatId.length > 20) {
            const person = this.db.getPerson(contactIdentifier);
            if (person && person.phone) {
                chatId = person.phone;
                // Ensure JID format if it looks like a clean number (digits only, length 10-15)
                if (/^\d{10,15}$/.test(chatId)) {
                    chatId = `${chatId}@s.whatsapp.net`;
                }
            }
        }

        let corpus = "";
        try {
            // Internal URL for Interfaces Service
            const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
            const headers = { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` };

            const res = await axios.get(`${interfacesUrl}/whatsapp/history?jid=${encodeURIComponent(chatId)}&limit=500`, { headers });
            const messages = res.data.filter(m => m.role === 'assistant'); // Sent by me (fromMe=true maps to 'assistant' in getChatHistory)

            if (messages.length < 3) return "Not enough history with this contact.";
            corpus = messages.map(m => m.content).join('\n');

        } catch (e) {
            console.error(`[Impersonation] Failed to fetch contact history for ${chatId} from Interfaces:`, e.message);
            throw new Error(`Unable to fetch chat history for ${chatId}. Ensure WhatsApp is connected. Error: ${e.message}`);
        }

        if (!corpus || corpus.length < 50) return "Not enough history.";

        // 2. Prompt Gemini
        const ownerName = this.getOwnerName();
        const prompt = `
You are an expert linguist. Analyze the following messages sent by "${ownerName}" TO a specific contact.
Create a "Relationship Style Profile". How does ${ownerName} talk to THIS person specifically?

Focus on:
- Level of formality/intimacy
- Specific jargon or inside jokes (generalize patterns)
- Sentence length and enthusiasm compared to normal
- Language used (English/Spanish?)

Sample:
"""
${corpus}
"""

Output a concise list of rules for this specific relationship.
`;
        try {
            const analyzeModel = process.env.WORKER_PRO || 'gemini-1.5-pro-exp';
            const result = await this.agent.client.models.generateContent({
                model: analyzeModel,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            this._config.logUsageFromResponse(this.db, analyzeModel, result, contactIdentifier, 'impersonation_analyze');

            let profile = "";
            if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                profile = result.response.candidates[0].content.parts[0].text.trim();
            } else if (result.candidates && result.candidates.length > 0) {
                profile = result.candidates[0].content.parts[0].text.trim();
            } else {
                throw new Error("No candidates in GenAI response");
            }

            try {
                this.saveContactStyle(contactIdentifier, profile);
            } catch (saveErr) {
                console.warn("Could not save contact style (contact might not exist in people DB yet):", saveErr.message);
            }
            return profile;
        } catch (e) {
            console.error('[Impersonation] Contact Analysis failed:', e);
            throw e;
        }
    }

    /**
     * Transcribe audio part using Gemini
     */
    async transcribeAudio(part) {
        try {
            const transcribeModel = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
            const result = await this.agent.client.models.generateContent({
                model: transcribeModel,
                contents: [{
                    role: 'user',
                    parts: [
                        part, // The audio part
                        { text: "Transcribe this audio EXACTLY. Return only the text. If it is empty or noise, return nothing." }
                    ]
                }]
            });

            this._config.logUsageFromResponse(this.db, transcribeModel, result, null, 'transcribe');

            // Robust response handling
            if (result.response && typeof result.response.text === 'function') {
                return result.response.text().trim();
            } else if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                return result.response.candidates[0].content.parts[0].text.trim();
            } else if (result.candidates && result.candidates.length > 0) {
                return result.candidates[0].content.parts[0].text.trim();
            }

            return null;
        } catch (e) {
            console.error('[Impersonation] Audio transcription failed:', e.message);
            return null;
        }
    }

    /**
     * Handle incoming message with buffering (Debounce)
     */
    async handleMessage(chatId, message, contactString) {
        // 1. Check Status
        // Pass phone/username if available in metadata for better lookup
        const autopilotStatus = this.getAutopilotStatus(contactString, message.metadata?.username);

        if (autopilotStatus === 'off') {
            // console.log(`[Impersonation Debug] Ignored message from ${contactString} (Status: off)`);
            return;
        }

        console.log(`[Impersonation] Buffering message for ${contactString} (Status: ${autopilotStatus})`);

        // 1.5 Transcribe Audio if present
        if (message.parts && message.parts.length > 0) {
            for (const part of message.parts) {
                if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                    console.log(`[Impersonation] Transcribing audio message...`);
                    const transcript = await this.transcribeAudio(part);
                    if (transcript) {
                        console.log(`[Impersonation] Transcription result: "${transcript.substring(0, 50)}..."`);
                        message.content = (message.content ? message.content + '\n' : '') + `[Voice Message]: "${transcript}"`;
                    } else {
                        console.log(`[Impersonation] Transcription returned empty/null.`);
                    }
                }
            }
        }

        // 2. Initialize Buffer if needed
        if (!this.messageBuffers.has(chatId)) {
            this.messageBuffers.set(chatId, {
                content: [],
                timer: null,
                metadata: message.metadata,
                source: message.source
            });
        }

        const buffer = this.messageBuffers.get(chatId);

        // Reset Timer
        if (buffer.timer) clearTimeout(buffer.timer);

        // Append Content
        buffer.content.push(message.content || '[Media/Empty]');
        buffer.metadata = { ...buffer.metadata, ...message.metadata }; // Update metadata with latest

        // Set New Timer (15s)
        buffer.timer = setTimeout(async () => {
            await this.processBufferedMessage(chatId, contactString);
        }, 15000);
    }

    /**
     * Handle presence updates (e.g. 'composing') to extend buffer
     */
    handlePresenceUpdate(chatId, status) {
        const buffer = this.messageBuffers.get(chatId);
        if (!buffer) return;

        // If user is typing, extend the timer
        if (status === 'composing') {
            console.log(`[Impersonation] User is typing in ${chatId}. Extending buffer timer...`);
            if (buffer.timer) clearTimeout(buffer.timer);

            // Extend by another 10s (refreshing as long as they type)
            buffer.timer = setTimeout(async () => {
                // Use stored contact info or fallback to chatId
                const contactStr = buffer.metadata?.phoneNumber || (chatId.includes('@') ? chatId.split('@')[0] : chatId);
                await this.processBufferedMessage(chatId, contactStr);
            }, 10000);
        }
    }

    /**
     * Process the buffered messages and generate a draft
     */
    async processBufferedMessage(chatId, contactString) {
        const buffer = this.messageBuffers.get(chatId);
        if (!buffer) return;

        // Clean up immediately to prevent race conditions
        this.messageBuffers.delete(chatId);

        const fullContent = buffer.content.join('\n\n');

        // Resolve Contact Name for better context
        let contactName = contactString;
        try {
            // Try resolving by strict ID (phone/jid)
            // contactString might be a phone number or JID
            const cleanId = contactString.includes('@') ? contactString.split('@')[0] : contactString;
            const person = this.db.getPerson(cleanId);
            if (person && person.name) {
                contactName = person.name;
            } else if (buffer.metadata && buffer.metadata.notifyName) {
                contactName = buffer.metadata.notifyName; // GitHub issue said 'username' but WA uses notifyName often
            }
        } catch (e) {
            console.warn('[Impersonation] Name resolution failed:', e.message);
        }

        console.log(`[Impersonation] Processing buffered messages for ${contactName} (${contactString}): ${buffer.content.length} messages.`);

        // Call generateDraft with combined context
        // We simulate a 'message' object structure for compatibility
        const combinedMessage = {
            content: fullContent,
            metadata: buffer.metadata,
            source: buffer.source
        };

        const result = await this.generateDraft(chatId, combinedMessage, contactName, fullContent, contactString);

        if (result && result.text) {
            const { text: draftText, cost } = result;
            const saved = this.saveDraft(chatId, contactString, draftText, fullContent, cost);

            // Autonomous Mode Check
            // Re-fetch status to be sure
            const status = this.getAutopilotStatus(contactString);
            if (status === 'full') {
                console.log(`[Impersonation] Autonomous Mode: Auto-sending reply to ${contactString}`);
                try {
                    const messages = draftText.split(/\[\s*SPLIT\s*\]/i).map(m => m.trim()).filter(m => m);

                    for (const msgContent of messages) {
                        const payload = {
                            source: buffer.source || 'whatsapp',
                            content: msgContent,
                            metadata: { chatId, session: 'assistant' },
                            type: 'text'
                        };
                        await this.agent.interface.send(payload);
                        // Small delay between messages for natural feel
                        if (messages.length > 1) await new Promise(r => setTimeout(r, 800));
                    }

                    this.markDraftCompleted(saved.lastInsertRowid, 'approved');
                    console.log(`[Impersonation] Auto-sent ${messages.length} messages successfully.`);
                } catch (e) {
                    console.error('[Impersonation] Auto-send failed:', e.message);
                }
            } else {
                console.log(`[Impersonation] Draft saved for ${contactName}. Waiting for approval.`);
            }
        } else {
            // Null or invalid draft
        }
    }


    async generateDraft(chatId, incomingMessage, contactName, contextContent = '', contactIdentifier = null) {
        console.log(`[Impersonation] Generating draft for chat ${chatId} from ${contactName}`);

        // 1. Fetch Context: Full conversation history (both sides)
        let history = [];
        const candidateJids = [];

        // Determine Candidate JIDs
        // Logic: Try Phone JID first (more likely specific), then the ChatID itself (LID or whatever was passed)
        if (contactIdentifier) {
            const phone = contactIdentifier.replace(/[^0-9]/g, '');
            if (phone.length > 5) candidateJids.push(`${phone}@s.whatsapp.net`);
        }
        candidateJids.push(chatId); // Always try the original ID as fallback

        // Remove duplicates
        const uniqueJids = [...new Set(candidateJids)];

        // Strategy: Use WhatsApp Source of Truth (Remote Fetch)
        if (chatId.includes('@s.whatsapp.net') || chatId.includes('@g.us') || chatId.includes('@lid')) {
            const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';

            for (const jid of uniqueJids) {
                if (!jid.includes('@s.whatsapp.net') && !jid.includes('@g.us') && !jid.includes('@lid')) continue;

                try {
                    console.log(`[Impersonation] Fetching remote history for ${jid}...`);
                    // Fetch 100 messages to ensure we have enough sent examples
                    const res = await axios.get(`${interfacesUrl}/whatsapp/history`, {
                        params: { jid: jid, limit: 100, session: 'user' },
                        headers: { Authorization: `Bearer ${process.env.DEEDEE_API_TOKEN}` },
                        timeout: 3000
                    });

                    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                        history = res.data;
                        console.log(`[Impersonation] History found for ${jid} (${history.length} msgs)`);
                        break; // Stop if we found history
                    }
                } catch (e) {
                    console.warn(`[Impersonation] Failed to fetch history for ${jid}: ${e.message}`);
                }
            }
        }

        // Validation: If no remote history, warn
        if (history.length === 0) console.warn('[Impersonation] No remote history found for any candidate JID.');

        // Fallback to Local DB if remote failed or not a WhatsApp chat
        if (history.length === 0) {
            history = this.db.db.prepare(`
                SELECT role, content FROM messages 
                WHERE chat_id = ? AND content IS NOT NULL AND content != ''
                ORDER BY timestamp DESC LIMIT 100
            `).all(chatId).reverse();
        }

        console.log(`[Impersonation] Transcript Gen: ChatID=${chatId}, HistoryLen=${history.length}`);

        // --- 1.5 THE MIRROR: Extract Recent Sent Messages ---
        // Filter for messages sent by 'assistant' (The User)
        const sentMessages = history.filter(m => m.role === 'assistant' && m.content && m.content.length > 2);
        // Take the last 30 examples
        const styleExamples = sentMessages.slice(-30).map(m => `"${m.content}"`).join('\n');

        // Prepare Transcript (Last 20 messages for Context)
        const recentHistory = history.slice(-20);

        // Format as transcript: "Name: Content"
        // In our mirroring logic: 
        // role='assistant' -> The Agent (acting as Owner/Me)
        // role='user' -> The Contact (Them)
        const ownerName = this.getOwnerName();

        const transcript = recentHistory.map(m => {
            const sender = m.role === 'assistant' ? ownerName : contactName;
            return `${sender}: ${m.content}`;
        }).join('\n');

        // 2. Fetch Styles
        const globalStyle = this.getStyleProfile();
        const contactStyle = this.getContactStyle(chatId);
        const relationship = this.getPersonRelationship(chatId);

        // 3. Build Prompt
        const prompt = `
You are an AI acting as the user "${ownerName}". Your goal is to draft a reply to the incoming message(s) that sounds EXACTLY like ${ownerName}.
Do not sound like a helpful AI. Sound like a human. 

${globalStyle ? `### GLOBAL INSTRUCTIONS (Manual Override):\n${globalStyle}\n` : ''}

${contactStyle ? `### CONTACT-SPECIFIC STYLE (Override/Nuance for this person):\n${contactStyle}\n` : ''}

${relationship ? `### RELATIONSHIP CONTEXT (GUARDRAILS):
The user's relationship with this person is: "${relationship}".
Infer the appropriate social distance and tone from this relationship.
- If it implies authority (e.g. Boss, Client), use a FORMAL, polite tone. No slang.
- If it implies closeness (e.g. Friend, Partner), use a CASUAL tone. Slang permitted if consistent with examples.
` : ''}

### REAL WORLD EXAMPLES (THE MIRROR)
Here are the last ${sentMessages.length > 30 ? 30 : sentMessages.length} messages ${ownerName} sent to this person.
Mimic the TONE, LENGTH, and VOCABULARY exactly.
If they are formal, be formal. If they are slang-heavy, use slang.

${styleExamples}

### Conversation History (Context):
${transcript}

### Incoming Message(s) from ${contactName}:
"${incomingMessage.content}"

### Instructions:
- Draft a reply in ${ownerName}'s style based on the EXAMPLES above.
- Keep it relevant to the conversation.
- If the incoming message is short, keep the reply short, single line.
- If the incoming message is a conversation closure (e.g. "ok", "thanks", "listo", "perfecto") and requires no response, output exactly: [NO_REPLY]
- Return ONLY the drafted reply text. No quotes.
- If multiple messages are appropriate (e.g. short sequential thoughts), separate them with exactly: [SPLIT]
- CRITICAL: maintain the same language as the incoming message.
- CRITICAL: Do not use multi-line messages unless strictly necessary. Always prefer short answers.

`;
        // 4. Call LLM
        try {
            console.log('Prompt:', JSON.stringify({ prompt }));
            const modelName = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';

            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            // Handle both New SDK (@google/genai) and Old SDK structure
            const response = result.response || result;
            const metadata = response.usageMetadata || result.usageMetadata;

            if (!metadata) {
                console.warn('[Impersonation] Warning: No usageMetadata in GenAI response. Cost will be 0. Keys:', Object.keys(response || {}));
            } else {
                // Debug: Confirm metadata received
                console.log('[Impersonation] Metadata received. Tokens:', metadata.totalTokenCount);
            }

            let draftText = "";
            let cost = 0;

            if (response) {
                if (response.candidates && response.candidates.length > 0) {
                    draftText = response.candidates[0].content.parts[0].text.trim();
                }

                // COST TRACKING
                if (metadata) {
                    const { promptTokenCount, candidatesTokenCount, totalTokenCount } = metadata;
                    const config = new ConfigService();
                    cost = config.calculateCost(modelName, promptTokenCount, candidatesTokenCount);

                    console.log(`[Impersonation] Draft Cost: $${cost.toFixed(6)} (${totalTokenCount} tokens)`);

                    // Log to DB Stats
                    this.agent.db.logTokenUsage({
                        model: modelName,
                        promptTokens: promptTokenCount,
                        candidateTokens: candidatesTokenCount,
                        totalTokens: totalTokenCount,
                        chatId: chatId,
                        estimatedCost: cost,
                        tag: 'autopilot'
                    });
                }
            } else if (result.candidates && result.candidates.length > 0) {
                // Fallback for older SDK structure (unlikely to have usageMetadata here usually)
                draftText = result.candidates[0].content.parts[0].text.trim();
            } else {
                throw new Error("No candidates in GenAI response");
            }

            // Check for NO_REPLY
            if (draftText.includes('[NO_REPLY]')) {
                console.log(`[Impersonation] Skipped draft (Conversation closure detected).`);
                return null;
            }

            // Clean Quotes if present (User Feedback)
            draftText = draftText.replace(/^"|"$/g, '').trim();

            return { text: draftText, cost }; // Return Object now
        } catch (error) {
            console.error('[Impersonation] Generation failed:', error);
            return null;
        }
    }

    /**
     * Get Autopilot status for a contact (by ID or Phone)
     */
    getAutopilotStatus(contactIdentifier, contactName) {
        if (!contactIdentifier) return 'off';

        // Clean ID (remove @s.whatsapp.net, etc) to match DB 'id' or 'phone' which are usually numeric
        const cleanId = contactIdentifier.includes('@') ? contactIdentifier.split('@')[0] : contactIdentifier;

        // console.log(`[Autopilot Debug] Checking status for raw='${contactIdentifier}', clean='${cleanId}', name='${contactName}'`);

        // 1. Try finding person by CLEAN ID directly
        // console.log(`[Autopilot Debug] Checking status for raw='${contactIdentifier}', clean='${cleanId}'`);
        let person = this.db.db.prepare('SELECT id, autopilot_status, autopilot_expires_at FROM people WHERE id = ?').get(cleanId);

        // 2. If not found, try by phone/metadata match (using both clean and raw to be safe)
        if (!person) {
            // console.log(`[Autopilot Debug] Not found by ID. Trying fallback query...`);
            person = this.db.db.prepare('SELECT id, autopilot_status, autopilot_expires_at FROM people WHERE phone = ? OR id = ?').get(cleanId, contactIdentifier);
        }

        if (!person) {
            // console.log(`[Autopilot Debug] Person NOT found in DB. Defaulting to 'off'.`);
            return 'off';
        }

        let status = person.autopilot_status || 'off';
        // console.log(`[Autopilot Debug] Found Person: ${person.id}, Status: ${status}`);

        // Check expiration
        if (person.autopilot_expires_at) {
            const expiry = new Date(person.autopilot_expires_at);
            if (expiry < new Date()) {
                console.log(`[Impersonation] Autopilot expired for ${contactIdentifier}. Reverting to 'off'.`);
                this.db.updatePerson(person.id, { autopilot_status: 'off', autopilot_expires_at: null });
                return 'off';
            }
        }

        return status;
    }


    /**
     * Get the latest pending draft for a chat
     */
    getPendingDraft(chatId) {
        return this.db.db.prepare(`
            SELECT * FROM autopilot_drafts 
            WHERE chat_id = ? AND status = 'pending' 
            ORDER BY created_at DESC LIMIT 1
        `).get(chatId);
    }

    /**
     * Mark a draft as handled (completed/rejected)
     */
    markDraftCompleted(id, status = 'completed') {
        this.db.db.prepare('UPDATE autopilot_drafts SET status = ? WHERE id = ?').run(status, id);
    }

    /**
     * Active Learning: Analyze the difference between Draft and Final Sent Message
     */
    async learnFromCorrection(chatId, draftContent, finalContent) {
        if (!draftContent || !finalContent) return;

        // simple normalization
        const draft = draftContent.trim();
        const final = finalContent.trim();

        if (draft === final) return; // No correction made

        console.log(`[Impersonation] Active Learning: User corrected draft. Analyzing diff...`);
        console.log(`Draft: "${draft}"`);
        console.log(`Final: "${final}"`);

        // 1. Prompt LLM to extract the lesson
        const prompt = `
You are an expert style analyst. The user corrected an AI-generated draft.
Analyze the change to understand the user's preferred style.

Draft: "${draft}"
User Correction: "${final}"

What specific style rule can we learn from this? 
Examples: "Prefers shorter sentences", "Uses lowercase for 'lol'", "More enthusiastic", "Don't apologize".
Return a SINGLE, concise rule (max 10 words).
`;

        try {
            const learnModel = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
            const result = await this.agent.client.models.generateContent({
                model: learnModel,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            this._config.logUsageFromResponse(this.db, learnModel, result, chatId, 'impersonation_learn');

            let rule = "";
            if (result.response) rule = result.response.text().trim();
            else if (result.candidates) rule = result.candidates[0].content.parts[0].text.trim();

            if (rule) {
                console.log(`[Impersonation] Learned Rule: "${rule}"`);

                // 2. Append to Contact Style Profile
                // Append as a learned preference bullet to existing profile
                let currentProfile = this.getContactStyle(chatId) || "";

                // Avoid duplicates if simple
                if (currentProfile.includes(rule)) return;

                const newProfile = currentProfile
                    ? `${currentProfile}\n- [LEARNED] ${rule}`
                    : `- [LEARNED] ${rule}`;

                this.saveContactStyle(chatId, newProfile);
                console.log(`[Impersonation] Updated style profile for ${chatId}`);
            }
        } catch (e) {
            console.error('[Impersonation] Active Learning failed:', e.message);
        }
    }
    /**
     * Save a generated draft
     */
    saveDraft(chatId, contactId, content, contextContent = null, cost = 0) {
        const options = JSON.stringify({ cost });

        const stmt = this.db.db.prepare(`
            INSERT INTO autopilot_drafts(chat_id, contact_id, content, context_content, options, status)
            VALUES(?, ?, ?, ?, ?, 'pending')
        `);
        const result = stmt.run(chatId, contactId, content, contextContent, options);

        // NOTIFY FRONTEND via Socket (Broadcast)
        if (this.agent && this.agent.interface) {
            this.agent.interface.broadcast('autopilot:update', {
                type: 'draft_created',
                chatId,
                cost
            });
        }

        return result;
    }
}

module.exports = { ImpersonationService };
