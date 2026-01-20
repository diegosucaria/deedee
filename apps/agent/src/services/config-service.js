
const CONSTANTS = {
    MODELS: {
        FLASH: process.env.WORKER_FLASH || 'gemini-2.5-flash',
        PRO: process.env.WORKER_PRO || 'gemini-3-pro-preview',
        IMAGE: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
        TTS: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        ROUTER: process.env.ROUTER_MODEL || 'gemini-2.5-flash-lite',
        SEARCH: process.env.WORKER_GOOGLE_SEARCH || 'gemini-2.5-pro',
        LIVE: process.env.WORKER_LIVE || 'gemini-2.5-flash-native-audio-preview-12-2025',
        EMBEDDING: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004',
    },
    PRICING: {
        'gemini-2.5-flash': { threshold: 128000, tier1: { input: 0.30, output: 0.60 }, tier2: { input: 1.0, output: 2.5 } },
        'gemini-2.0-flash-exp': { threshold: 128000, tier1: { input: 0.15, output: 0.60 }, tier2: { input: 0.30, output: 1.20 } },
        'gemini-3-pro-preview': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        'gemini-2.5-pro': { threshold: 200000, tier1: { input: 2.00, output: 12.00 }, tier2: { input: 4.00, output: 18.00 } },
        'FLASH_DEFAULT': { threshold: 128000, tier1: { input: 0.15, output: 0.60 }, tier2: { input: 0.30, output: 1.20 } },
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

    calculateCost(model, inputTokens, outputTokens) {
        let pricing = CONSTANTS.PRICING[model];
        if (!pricing) {
            const lower = model.toLowerCase();
            if (lower.includes('pro')) pricing = CONSTANTS.PRICING['PRO_DEFAULT'];
            else pricing = CONSTANTS.PRICING['FLASH_DEFAULT'];
        }

        const limit = pricing.threshold || 128000;
        const tier = inputTokens <= limit ? pricing.tier1 : pricing.tier2;

        const inputCost = (inputTokens / 1_000_000) * tier.input;
        const outputCost = (outputTokens / 1_000_000) * tier.output;

        return inputCost + outputCost;
    }
}

module.exports = { ConfigService, CONSTANTS };
