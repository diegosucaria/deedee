class Router {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = null;
        // Use a fast model for routing
        this.model = process.env.ROUTER_MODEL || 'gemini-2.0-flash-exp';
    }

    async _loadClientLibrary() {
        return import('@google/genai');
    }

    async _ensureClient() {
        if (!this.client) {
            const { GoogleGenAI } = await this._loadClientLibrary();
            this.client = new GoogleGenAI({ apiKey: this.apiKey });
        }
    }

    async route(userMessage, history = []) {
        await this._ensureClient();
        try {
            // Format recent history for context
            const historyText = history.slice(-3).map(msg => {
                const role = msg.role === 'model' ? 'Assistant' : 'User';
                const content = msg.parts.map(p => p.text).join(' ');
                return `${role}: ${content}`;
            }).join('\n');

            const instructionText = `
        You are the Router for a personal assistant bot. Your only job is to analyze the user's input and select the best model to handle the request.
        
        Output a JSON object: {"model": "FLASH" | "PRO", "reason": "brief explanation", "transcription": "transcription of user input if audio, otherwise null"}
        
        ### ROUTING LOGIC
        
        **TARGET: FLASH (Low Latency, Tools)**
        * **Home Automation:** "Turn on lights", "What's the temperature?", "Lock the door".
        * **Simple Queries:** Weather, currency conversion, definition of terms, short translations.
        * **Casual Chat:** Greetings, "How are you?", "Tell me a joke".
        * **Fact Retrieval:** Questions with a single factual answer.
        
        **TARGET: PRO (Deep Reasoning, "Thinking")**
        * **Coding & Architecture:** Terraform, GCP, Kubernetes, Python debugging, System Design.
        * **Complex Planning:** Travel itineraries (e.g., "Trip to Milan"), flight search strategies, project planning.
        * **Creative Writing:** Emails, blog posts, essays.
        * **Analysis:** Summarizing long text, analyzing logs, comparing options.
        
        ### RECENT CONTEXT
        ${historyText}
      `;

            let routerPrompt;
            if (Array.isArray(userMessage)) {
                // Multimodal: Send instructions + user content parts
                routerPrompt = [
                    { text: instructionText + "\nUser Input (See Multimodal Content Below):" },
                    ...userMessage
                ];
            } else {
                // Text-only
                routerPrompt = instructionText + `\nUser Input: "${userMessage}"`;
            }

            const response = await this.client.chats.create({
                model: this.model,
                config: {
                    responseMimeType: 'application/json',
                    temperature: 0.0,
                }
            }).sendMessage({ message: routerPrompt });


            let text = '{}';
            console.log('[Router] Raw Response:', response ? (typeof response) : 'undefined');

            if (!response) {
                throw new Error('Received undefined response from LLM');
            }

            if (typeof response.text === 'function') {
                text = response.text();
            } else if (response.text) {
                text = response.text;
            } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
                text = response.candidates[0].content.parts[0].text;
            }

            // Cleanup potential markdown blocks if the model wrapped JSON
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();

            const decision = JSON.parse(text);

            if (decision.transcription) {
                console.log(`[Router] Transcription: "${decision.transcription}"`);
            }
            console.log(`[Router] Decision: ${decision.model} (${decision.reason})`);
            return decision;

        } catch (error) {
            console.error('[Router] Routing failed, defaulting to PRO:', error.message);
            return { model: 'PRO', reason: 'Error in router' };
        }
    }
}

module.exports = { Router };
