
const CONSTANTS = {
    MODELS: {
        FLASH: process.env.WORKER_FLASH || 'gemini-3-flash-preview',
        LITE: process.env.WORKER_LITE || 'gemini-3.1-flash-lite-preview',
        PRO: process.env.WORKER_PRO || 'gemini-3.1-pro-preview',
        IMAGE: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
        TTS: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        ROUTER: process.env.ROUTER_MODEL || 'gemini-3.1-flash-lite-preview',
        SEARCH: process.env.WORKER_GOOGLE_SEARCH || 'gemini-2.5-pro',
        LIVE: process.env.WORKER_LIVE || 'gemini-2.5-flash-native-audio-preview-12-2025',
        EMBEDDING: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
    },
    // Pricing per 1M tokens (USD) - Updated March 2026
    // Source: https://ai.google.dev/gemini-api/docs/pricing
    // Note: Flash/Lite models have FLAT pricing (no context-length tiers).
    //       Only Pro models have ≤200k / >200k tiers.
    //       Audio input costs more but we don't distinguish modality here (text rates used).
    PRICING: {
        // --- Flash models (flat pricing, no context tiers) ---
        'gemini-2.5-flash': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
        'gemini-3-flash-preview': { tier1: { input: 0.50, output: 3.00 }, tier2: { input: 0.50, output: 3.00 } },
        'gemini-2.0-flash': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } }, // deprecated June 2026
        'gemini-2.0-flash-exp': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } }, // deprecated June 2026
        // --- Flash-Lite models (flat pricing) ---
        'gemini-2.5-flash-lite': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } },
        'gemini-3.1-flash-lite-preview': { tier1: { input: 0.25, output: 1.50 }, tier2: { input: 0.25, output: 1.50 } },
        'gemini-2.0-flash-lite': { tier1: { input: 0.075, output: 0.30 }, tier2: { input: 0.075, output: 0.30 } }, // deprecated June 2026
        // --- Pro models (tiered: ≤200k / >200k) ---
        'gemini-2.5-pro': { threshold: 200000, tier1: { input: 1.25, output: 10.00 }, tier2: { input: 2.50, output: 15.00 } },
        'gemini-3-pro-preview': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        'gemini-3.1-pro-preview': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        // --- Image models (text output $12, image output $120/M) ---
        'gemini-3-pro-image-preview': { tier1: { input: 2.00, output: 120.00 }, tier2: { input: 2.00, output: 120.00 } },
        'gemini-3.1-flash-image-preview': { tier1: { input: 0.50, output: 60.00 }, tier2: { input: 0.50, output: 60.00 } },
        'gemini-2.5-flash-image': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
        // --- TTS models (flat pricing) ---
        'gemini-2.5-flash-preview-tts': { tier1: { input: 0.50, output: 10.00 }, tier2: { input: 0.50, output: 10.00 } },
        'gemini-2.5-pro-preview-tts': { tier1: { input: 1.00, output: 20.00 }, tier2: { input: 1.00, output: 20.00 } },
        // --- Live/Audio models (flat, approximate as flash) ---
        'gemini-2.5-flash-native-audio-preview-12-2025': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
        // --- Embedding models (input only, no output) ---
        'text-embedding-004': { tier1: { input: 0.10, output: 0 }, tier2: { input: 0.10, output: 0 } },
        'gemini-embedding-001': { tier1: { input: 0.15, output: 0 }, tier2: { input: 0.15, output: 0 } },
        'gemini-embedding-002': { tier1: { input: 0.20, output: 0 }, tier2: { input: 0.20, output: 0 } },
        // --- Grok/xAI models (OpenAI-compatible) ---
        'grok-3': { tier1: { input: 3.00, output: 15.00 }, tier2: { input: 3.00, output: 15.00 } },
        'grok-3-mini': { tier1: { input: 0.30, output: 0.50 }, tier2: { input: 0.30, output: 0.50 } },
        // --- Defaults for unknown models (matched by name heuristic) ---
        'FLASH_DEFAULT': { tier1: { input: 0.50, output: 3.00 }, tier2: { input: 0.50, output: 3.00 } },
        'LITE_DEFAULT': { tier1: { input: 0.25, output: 1.50 }, tier2: { input: 0.25, output: 1.50 } },
        'PRO_DEFAULT': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } }
    }
};

class ConfigService {
    constructor() { }

    get(key) {
        return CONSTANTS[key];
    }

    getModel(type) {
        return CONSTANTS.MODELS[type] || CONSTANTS.MODELS.FLASH;
    }

    /**
     * Log token usage from a Gemini API response.
     * Call after any generateContent/embedContent call to track costs.
     * @param {object} db - AgentDB instance
     * @param {string} model - Model name used
     * @param {object} result - Raw response from generateContent
     * @param {string} [chatId] - Chat ID for attribution
     * @param {string} [tag] - Optional tag (e.g. 'title', 'tts', 'dream')
     * @returns {{ cost: number, tokens: number }} cost and total tokens
     */
    logUsageFromResponse(db, model, result, chatId, tag) {
        const meta = result?.usageMetadata;
        if (!meta || !db) return { cost: 0, tokens: 0 };

        const promptTokens = meta.promptTokenCount || 0;
        const candidateTokens = meta.candidatesTokenCount || 0;
        const cachedTokens = meta.cachedContentTokenCount || 0;
        const thoughtsTokens = meta.thoughtsTokenCount || 0;
        const totalTokens = meta.totalTokenCount || (promptTokens + candidateTokens);
        const cost = this.calculateCost(model, promptTokens, candidateTokens, cachedTokens, thoughtsTokens);

        db.logTokenUsage({
            model,
            promptTokens,
            candidateTokens,
            totalTokens,
            chatId: chatId || null,
            estimatedCost: cost,
            tag: tag || null,
            cachedTokens,
            thoughtsTokens
        });

        return { cost, tokens: totalTokens };
    }

    /**
     * Calculate cost for an API call, accounting for implicit caching and thinking tokens.
     * - cachedTokens are part of promptTokens, charged at 10% of input rate (90% discount)
     * - thoughtsTokens are charged at the output rate (same as candidates)
     * @param {string} model - Model name
     * @param {number} inputTokens - Total input/prompt tokens (includes cached)
     * @param {number} outputTokens - Candidate output tokens (may or may not include thinking depending on API version)
     * @param {number} [cachedTokens=0] - Cached input tokens (subset of inputTokens)
     * @param {number} [thoughtsTokens=0] - Thinking tokens (if separate from outputTokens)
     */
    calculateCost(model, inputTokens, outputTokens, cachedTokens = 0, thoughtsTokens = 0) {
        let pricing = CONSTANTS.PRICING[model];
        if (!pricing) {
            const lower = model.toLowerCase();
            if (lower.includes('tts')) pricing = CONSTANTS.PRICING['gemini-2.5-flash-preview-tts'];
            else if (lower.includes('embedding')) pricing = CONSTANTS.PRICING['text-embedding-004'];
            else if (lower.includes('image')) pricing = CONSTANTS.PRICING['gemini-3-pro-image-preview'];
            else if (lower.includes('pro')) pricing = CONSTANTS.PRICING['PRO_DEFAULT'];
            else if (lower.includes('lite')) pricing = CONSTANTS.PRICING['LITE_DEFAULT'];
            else pricing = CONSTANTS.PRICING['FLASH_DEFAULT'];
        }

        const limit = pricing.threshold || 128000;
        const tier = inputTokens <= limit ? pricing.tier1 : pricing.tier2;

        // Cached tokens get 90% discount on input rate
        const uncachedInput = inputTokens - cachedTokens;
        const inputCost = (uncachedInput / 1_000_000) * tier.input + (cachedTokens / 1_000_000) * tier.input * 0.1;
        // Thinking tokens charged at output rate (same as candidates)
        const outputCost = ((outputTokens + thoughtsTokens) / 1_000_000) * tier.output;

        return inputCost + outputCost;
    }
}

module.exports = { ConfigService, CONSTANTS };

