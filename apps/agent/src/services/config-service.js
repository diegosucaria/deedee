
// Env var that overrides each model role. Balena device/fleet variables win over
// docker-compose.yml, so this is also the rollback path (see docs/models.md).
const MODEL_ENV_VARS = {
    FLASH: 'WORKER_FLASH',
    LITE: 'WORKER_LITE',
    PRO: 'WORKER_PRO',
    IMAGE: 'GEMINI_IMAGE_MODEL',
    TTS: 'GEMINI_TTS_MODEL',
    ROUTER: 'ROUTER_MODEL',
    SEARCH: 'WORKER_GOOGLE_SEARCH',
    LIVE: 'WORKER_LIVE',
    EMBEDDING: 'GEMINI_EMBEDDING_MODEL',
};

const CONSTANTS = {
    MODEL_ENV_VARS,
    MODELS: {
        FLASH: process.env.WORKER_FLASH || 'gemini-3.6-flash',
        LITE: process.env.WORKER_LITE || 'gemini-3.1-flash-lite',
        PRO: process.env.WORKER_PRO || 'gemini-3.1-pro-preview',
        IMAGE: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
        TTS: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        ROUTER: process.env.ROUTER_MODEL || 'gemini-3.1-flash-lite',
        SEARCH: process.env.WORKER_GOOGLE_SEARCH || 'gemini-3.6-flash',
        LIVE: process.env.WORKER_LIVE || 'gemini-3.8-live',
        EMBEDDING: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
    },
    // Pricing per 1M tokens (USD) - Updated September 2026
    // Source: https://ai.google.dev/gemini-api/docs/pricing
    // Notes:
    // - Flash/Lite models have FLAT pricing (no context-length tiers). Only Pro
    //   models have <=200k / >200k tiers.
    // - Cached input is charged at 10% of the input rate (calculateCost).
    // - Audio input costs more but we do not split by modality here (text rates).
    // - Image models: `output` is the IMAGE output rate; `outputText` is the text
    //   output rate. logUsageFromResponse splits the two when the API reports
    //   candidatesTokensDetails; otherwise all output is billed at the image rate.
    PRICING: {
        // --- Flash models (flat pricing, no context tiers) ---
        'gemini-3.6-flash': { tier1: { input: 0.75, output: 3.75 }, tier2: { input: 0.75, output: 3.75 } }, // price doubles 2027-01-01
        'gemini-3.7-flash': { tier1: { input: 0.75, output: 3.75 }, tier2: { input: 0.75, output: 3.75 } },
        'gemini-3.8-flash': { tier1: { input: 0.75, output: 3.75 }, tier2: { input: 0.75, output: 3.75 } },
        'gemini-3-flash-preview': { tier1: { input: 0.50, output: 3.00 }, tier2: { input: 0.50, output: 3.00 } },
        'gemini-2.5-flash': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
        'gemini-2.0-flash': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } }, // retired June 2026
        'gemini-2.0-flash-exp': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } }, // retired June 2026
        // --- Flash-Lite models (flat pricing) ---
        'gemini-3.1-flash-lite': { tier1: { input: 0.25, output: 1.50 }, tier2: { input: 0.25, output: 1.50 } },
        'gemini-3.5-flash-lite': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
        'gemini-3.1-flash-lite-preview': { tier1: { input: 0.25, output: 1.50 }, tier2: { input: 0.25, output: 1.50 } }, // retired May 2026
        'gemini-2.5-flash-lite': { tier1: { input: 0.10, output: 0.40 }, tier2: { input: 0.10, output: 0.40 } },
        'gemini-2.0-flash-lite': { tier1: { input: 0.075, output: 0.30 }, tier2: { input: 0.075, output: 0.30 } }, // retired June 2026
        // --- Pro models (tiered: <=200k / >200k) ---
        'gemini-3.1-pro-preview': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        'gemini-3-pro-preview': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        'gemini-2.5-pro': { threshold: 200000, tier1: { input: 1.25, output: 10.00 }, tier2: { input: 2.50, output: 15.00 } },
        // --- Image models (output = image rate, outputText = text rate) ---
        'gemini-3.1-flash-image': { tier1: { input: 0.50, output: 60.00, outputText: 3.00 }, tier2: { input: 0.50, output: 60.00, outputText: 3.00 } },
        'gemini-3.1-flash-image-preview': { tier1: { input: 0.50, output: 60.00, outputText: 3.00 }, tier2: { input: 0.50, output: 60.00, outputText: 3.00 } },
        'gemini-3-pro-image': { tier1: { input: 2.00, output: 120.00, outputText: 12.00 }, tier2: { input: 2.00, output: 120.00, outputText: 12.00 } },
        'gemini-3-pro-image-preview': { tier1: { input: 2.00, output: 120.00, outputText: 12.00 }, tier2: { input: 2.00, output: 120.00, outputText: 12.00 } }, // retired June 2026
        'gemini-2.5-flash-image': { tier1: { input: 0.30, output: 30.00, outputText: 2.50 }, tier2: { input: 0.30, output: 30.00, outputText: 2.50 } },
        // --- TTS models (flat pricing) ---
        'gemini-2.5-flash-preview-tts': { tier1: { input: 0.50, output: 10.00 }, tier2: { input: 0.50, output: 10.00 } },
        'gemini-2.5-pro-preview-tts': { tier1: { input: 1.00, output: 20.00 }, tier2: { input: 1.00, output: 20.00 } },
        'gemini-3.1-flash-tts-preview': { tier1: { input: 1.00, output: 20.00 }, tier2: { input: 1.00, output: 20.00 } },
        // --- Live models ---
        // gemini-3.8-live bills text at 0.75 in / 4.50 out and audio at 3.00 in / 12.00 out.
        // Live sessions are voice, so the AUDIO rates are used here. Text-only turns are
        // over-counted (4x in, 2.7x out) until usage is split by modality.
        'gemini-3.8-live': { tier1: { input: 3.00, output: 12.00 }, tier2: { input: 3.00, output: 12.00 } },
        'gemini-2.5-flash-native-audio-preview-12-2025': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } }, // approximated as flash text
        // --- Embedding models (input only, no output) ---
        'gemini-embedding-2': { tier1: { input: 0.20, output: 0 }, tier2: { input: 0.20, output: 0 } },
        'gemini-embedding-2-preview': { tier1: { input: 0.20, output: 0 }, tier2: { input: 0.20, output: 0 } }, // retired Aug 2026
        'gemini-embedding-001': { tier1: { input: 0.15, output: 0 }, tier2: { input: 0.15, output: 0 } },
        'text-embedding-004': { tier1: { input: 0.10, output: 0 }, tier2: { input: 0.10, output: 0 } },
        // --- Grok/xAI models (OpenAI-compatible) ---
        'grok-3': { tier1: { input: 3.00, output: 15.00 }, tier2: { input: 3.00, output: 15.00 } },
        'grok-3-mini': { tier1: { input: 0.30, output: 0.50 }, tier2: { input: 0.30, output: 0.50 } },
        // --- Defaults for unknown models (matched by name heuristic) ---
        'FLASH_DEFAULT': { tier1: { input: 0.75, output: 3.75 }, tier2: { input: 0.75, output: 3.75 } },
        'LITE_DEFAULT': { tier1: { input: 0.30, output: 2.50 }, tier2: { input: 0.30, output: 2.50 } },
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
     * Env var that overrides a model role (e.g. FLASH -> WORKER_FLASH).
     * @param {string} type
     * @returns {string|undefined}
     */
    getModelEnvVar(type) {
        return MODEL_ENV_VARS[type];
    }

    /**
     * Resolve the pricing row for a model id. Exact match first, then a name
     * heuristic for ids not in the table. Exposed so tests and the smoke script
     * can report which row an id lands on.
     * @param {string} model
     * @returns {object} pricing row ({ tier1, tier2, threshold? })
     */
    getPricing(model) {
        const exact = CONSTANTS.PRICING[model];
        if (exact) return exact;
        const lower = String(model || '').toLowerCase();
        if (lower.includes('tts')) return CONSTANTS.PRICING['gemini-2.5-flash-preview-tts'];
        if (lower.includes('embedding')) return CONSTANTS.PRICING['gemini-embedding-2'];
        if (lower.includes('image')) {
            return lower.includes('pro') ? CONSTANTS.PRICING['gemini-3-pro-image'] : CONSTANTS.PRICING['gemini-3.1-flash-image'];
        }
        if (lower.includes('live') || lower.includes('native-audio')) return CONSTANTS.PRICING['gemini-3.8-live'];
        if (lower.includes('pro')) return CONSTANTS.PRICING['PRO_DEFAULT'];
        if (lower.includes('lite')) return CONSTANTS.PRICING['LITE_DEFAULT'];
        return CONSTANTS.PRICING['FLASH_DEFAULT'];
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
        const imageOutputTokens = this._imageOutputTokens(meta);
        const cost = this.calculateCost(model, promptTokens, candidateTokens, cachedTokens, thoughtsTokens, imageOutputTokens);

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
     * Image output tokens from usageMetadata.candidatesTokensDetails, or null
     * when the API did not report a per-modality split.
     * @param {object} meta
     * @returns {number|null}
     */
    _imageOutputTokens(meta) {
        const details = meta?.candidatesTokensDetails;
        if (!Array.isArray(details) || details.length === 0) return null;
        return details
            .filter(d => String(d.modality || '').toUpperCase() === 'IMAGE')
            .reduce((sum, d) => sum + (d.tokenCount || 0), 0);
    }

    /**
     * Calculate cost for an API call, accounting for implicit caching and thinking tokens.
     * - cachedTokens are part of promptTokens, charged at 10% of input rate (90% discount)
     * - thoughtsTokens are charged at the output rate (same as candidates)
     * - imageOutputTokens (image models only) are charged at `output`; the rest of the
     *   output at `outputText`. When null, all output is charged at `output`.
     * @param {string} model - Model name
     * @param {number} inputTokens - Total input/prompt tokens (includes cached)
     * @param {number} outputTokens - Candidate output tokens (may or may not include thinking depending on API version)
     * @param {number} [cachedTokens=0] - Cached input tokens (subset of inputTokens)
     * @param {number} [thoughtsTokens=0] - Thinking tokens (if separate from outputTokens)
     * @param {number|null} [imageOutputTokens=null] - Image output tokens (subset of outputTokens)
     */
    calculateCost(model, inputTokens, outputTokens, cachedTokens = 0, thoughtsTokens = 0, imageOutputTokens = null) {
        const pricing = this.getPricing(model);

        // Guard against bad data from API
        inputTokens = Math.max(0, inputTokens || 0);
        outputTokens = Math.max(0, outputTokens || 0);
        cachedTokens = Math.min(Math.max(0, cachedTokens || 0), inputTokens);
        thoughtsTokens = Math.max(0, thoughtsTokens || 0);

        const limit = pricing.threshold || 128000;
        const tier = inputTokens <= limit ? pricing.tier1 : pricing.tier2;

        // Cached tokens get 90% discount on input rate
        const uncachedInput = inputTokens - cachedTokens;
        const inputCost = (uncachedInput / 1_000_000) * tier.input + (cachedTokens / 1_000_000) * tier.input * 0.1;

        let outputCost;
        if (tier.outputText !== undefined && imageOutputTokens !== null && imageOutputTokens !== undefined) {
            const imageTokens = Math.min(Math.max(0, imageOutputTokens || 0), outputTokens);
            const textTokens = outputTokens - imageTokens;
            outputCost = (imageTokens / 1_000_000) * tier.output
                + ((textTokens + thoughtsTokens) / 1_000_000) * tier.outputText;
        } else {
            // Thinking tokens charged at output rate (same as candidates)
            outputCost = ((outputTokens + thoughtsTokens) / 1_000_000) * tier.output;
        }

        return inputCost + outputCost;
    }
}

module.exports = { ConfigService, CONSTANTS, MODEL_ENV_VARS };
