
const { ConfigService } = require('./services/config-service');

class Router {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = null;
        this.config = new ConfigService();
        // Use a fast model for routing
        this.model = this.config.getModel('ROUTER');
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

    async route(userMessage, history = [], lastModel = null) {
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
        
        Output a JSON object: {"model": "FLASH" | "PRO" | "IMAGE", "toolMode": "SEARCH" | "STANDARD", "reason": "brief explanation", "transcription": "transcription of user input if audio, otherwise null"}
        
        ### ROUTING LOGIC
        
        **TARGET: FLASH (Low Latency)**
        **toolMode: SEARCH**
        * **External Facts:** "Weather in Tokyo", "Who won the game?", "Stock price of AAPL", "Latest news on AI".
        * **NOTE:** Do NOT use this for internal history or personal memory.
        
        **toolMode: STANDARD**
        * **Home Automation:** "Turn on lights", "What's the temperature?".
        * **Casual Chat:** Greetings, "How are you?".
        * **Internal Tools:** "Remember this fact", "Set a timer".
        * **Complex Logic / Conditionals:** "Check the weather AND if it rains, send a message", "Find stocks AND notify me if...", "Use this tool to...".
        * **Explicit Overrides:** "Use STANDARD tools", "Use Agent mode".

        **TARGET: IMAGE (Direct Tool Call)**
        **toolMode: STANDARD**
        * **Generation:** "Generate an image of...", "Draw a...".
        
        **TARGET: PRO (Deep Reasoning)**
        **toolMode: STANDARD**
        * **Coding & Architecture:** Terraform, GCP, Kubernetes.
        * **Complex Planning:** Travel itineraries.
        * **Analysis:** Summarizing long text.
        * **Memory & History:** "Search my conversation with...", "What did I say yesterday?", "Find the message about..." (Requires internal tools, NOT Google).
        
        ### STICKY ROUTING (CRITICAL)
        * **Last Used Model:** ${lastModel || 'NONE'}
        * **Rule:** If the Last Used Model was **PRO**, and the current user input is a **continuation**, **confirmation** ("Yes", "Proceed", "Ok"), or **short follow-up** related to the previous PRO context, **YOU MUST STAY ON PRO**.
        * **Exception:** Only switch back to FLASH if the user clearly changes the topic to a simple task (Home Automation, Weather, Greeting).

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
            if (!response) {
                throw new Error('Received undefined response from LLM');
            }

            try {
                if (typeof response.text === 'function') {
                    text = response.text();
                } else if (response.text) {
                    text = response.text;
                }
            } catch (e) { /* ignore */ }

            if (!text || text === '{}') {
                if (response.candidates && response.candidates[0] && response.candidates[0].content) {
                    text = response.candidates[0].content.parts[0].text;
                }
            }

            console.log('[Router] Raw Text:', text);

            // Advanced JSON extraction
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                text = jsonMatch[0];
            } else {
                // Remove markdown and trim as fallback
                text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            }

            const decision = JSON.parse(text);

            if (decision.transcription) {
                console.log(`[Router] Transcription: "${decision.transcription}"`);
            }
            console.log(`[Router] Decision: ${decision.model} (${decision.reason})`);
            return decision;

        } catch (error) {
            console.error('[Router] Routing failed, defaulting to PRO:', error.message);
            return { model: 'PRO', toolMode: 'STANDARD', reason: 'Error in router' };
        }
    }
}

module.exports = { Router };
