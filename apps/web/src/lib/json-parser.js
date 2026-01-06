// Basic helper to clean up common Log/LLM JSON artifacts
export const safeParse = (input) => {
    if (typeof input !== 'string') return null;

    // 1. Try standard parse
    try {
        const parsed = JSON.parse(input);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (e) {
        // Fallback below
    }

    // 2. Try handling escaped newlines (e.g. log output)
    try {
        const sanitized = input.replace(/\n/g, '\\n');
        const parsed = JSON.parse(sanitized);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (e) {
        // Fallback below
    }

    // 3. Try handling Python-style dicts (common in Pydantic/Python logs)
    try {
        const pySanitized = input
            .replace(/'/g, '"')          // Replace single quotes with double
            .replace(/None/g, 'null')    // Python None -> null
            .replace(/True/g, 'true')    // Python True -> true
            .replace(/False/g, 'false')  // Python False -> false
            .replace(/\(/g, '[')         // Tuples -> Arrays
            .replace(/\)/g, ']')
            .replace(/\\n/g, "\\\\n");   // Fix double escapes if needed

        const parsed = JSON.parse(pySanitized);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (e) {
        // Failed
    }

    return null;
};

// Recursively parse strings inside objects
export const deepParse = (input) => {
    if (typeof input === 'string') {
        const parsed = safeParse(input);
        if (parsed) {
            return deepParse(parsed);
        }
        return input;
    }

    if (typeof input === 'object' && input !== null) {
        if (Array.isArray(input)) {
            return input.map(deepParse);
        }
        const newObj = {};
        for (const key in input) {
            newObj[key] = deepParse(input[key]);
        }
        return newObj;
    }

    return input;
};
