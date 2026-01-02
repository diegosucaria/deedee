const { GoogleGenAI } = require('@google/genai');

class Router {
    constructor(apiKey) {
        this.client = new GoogleGenAI({ apiKey });
        // Use a fast model for routing
        this.model = process.env.ROUTER_MODEL || 'gemini-2.0-flash-exp';
    }

    async route(userMessage) {
        try {
            const prompt = `
        You are the Router for a personal assistant bot. Your only job is to analyze the user's input and select the best model to handle the request.
        
        Output a JSON object: {"model": "FLASH" | "PRO", "reason": "brief explanation"}
        
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
        
        User Input: "${userMessage}"
      `;

            const response = await this.client.chats.create({
                model: this.model,
                config: {
                    responseMimeType: 'application/json',
                    temperature: 0.0,
                }
            }).sendMessage({ message: prompt });

            const text = response.text || '{}';
            const decision = JSON.parse(text);

            console.log(`[Router] Decision: ${decision.model} (${decision.reason})`);
            return decision;

        } catch (error) {
            console.error('[Router] Routing failed, defaulting to PRO:', error.message);
            return { model: 'PRO', reason: 'Error in router' };
        }
    }
}

module.exports = { Router };
