// Basic helper to clean up common Log/LLM JSON artifacts
export const safeParse = (input) => {
    if (typeof input !== 'string') return null;

    // 1. Try standard parse
    try {
        const parsed = JSON.parse(input);
        // [MODIFIED] Allow returning strings/primitives to support double-serialization unwrapping
        // e.g. "{\"a\":1}" -> "{\"a\":1}" -> {a:1}
        if (parsed !== null && parsed !== undefined) return parsed;
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

    // 4. Try fixing invalid escape sequences (e.g. \}, \[, or just \a)
    try {
        // Replace backslash followed by any character that isn't a valid JSON escape char
        // Valid: " \ / b f n r t u
        const fixed = input.replace(/\\([^"\\/bfnrtu])/g, '$1');
        const parsed = JSON.parse(fixed);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (e) {
        // Failed
    }

    // [DEBUG] Log failure if it looked like JSON
    if (input && typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            console.error('[JSON Parse Failed] Input looks like JSON but all strategies failed:', input.substring(0, 200));
        }
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
