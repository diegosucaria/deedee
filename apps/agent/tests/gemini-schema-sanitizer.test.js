const {
    sanitizeGeminiSchema,
    sanitizeFunctionDeclarations,
} = require('../src/utils/gemini-schema-sanitizer');

// Collect every key present anywhere in a (possibly nested) schema.
function collectKeys(node, acc = new Set()) {
    if (Array.isArray(node)) {
        node.forEach(n => collectKeys(n, acc));
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            acc.add(k);
            collectKeys(v, acc);
        }
    }
    return acc;
}

describe('sanitizeGeminiSchema', () => {
    // Mirrors the production 400: function_declarations[127] had a union
    // property whose branch carried `propertyNames`, and [149] had a numeric
    // property with `exclusiveMinimum`.
    test('strips the exact keywords Gemini rejected in production', () => {
        const schema = {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
                filters: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'object', propertyNames: { type: 'string' }, additionalProperties: true },
                    ],
                },
                maxResults: {
                    type: 'integer',
                    exclusiveMinimum: 0,
                },
            },
        };

        const out = sanitizeGeminiSchema(schema);
        const keys = collectKeys(out);

        expect(keys.has('propertyNames')).toBe(false);
        expect(keys.has('additionalProperties')).toBe(false);
        expect(keys.has('exclusiveMinimum')).toBe(false);
        expect(keys.has('$schema')).toBe(false);

        // exclusiveMinimum is converted to the closest supported bound.
        expect(out.properties.maxResults.minimum).toBe(0);
        // The union is preserved (Gemini supports anyOf), minus the bad keyword.
        expect(out.properties.filters.anyOf).toHaveLength(2);
    });

    test('folds a `null` union branch into nullable and collapses the single remaining branch', () => {
        // Pydantic `Optional[str]` shape.
        const schema = { anyOf: [{ type: 'string' }, { type: 'null' }] };
        const out = sanitizeGeminiSchema(schema);
        expect(out.anyOf).toBeUndefined();
        expect(out.type).toBe('string');
        expect(out.nullable).toBe(true);
    });

    test('normalizes a JSON-Schema type array to type + nullable', () => {
        const out = sanitizeGeminiSchema({ type: ['string', 'null'] });
        expect(out.type).toBe('string');
        expect(out.nullable).toBe(true);
    });

    test('converts const to a single-value enum', () => {
        const out = sanitizeGeminiSchema({ const: 'fixed' });
        expect(out.enum).toEqual(['fixed']);
        expect(out.const).toBeUndefined();
    });

    test('maps oneOf to anyOf', () => {
        const out = sanitizeGeminiSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] });
        expect(out.oneOf).toBeUndefined();
        expect(out.anyOf).toHaveLength(2);
    });

    test('drops unsupported format values but keeps supported ones', () => {
        expect(sanitizeGeminiSchema({ type: 'string', format: 'email' }).format).toBeUndefined();
        expect(sanitizeGeminiSchema({ type: 'string', format: 'date-time' }).format).toBe('date-time');
    });

    test('does not mutate the input', () => {
        const schema = { type: 'object', properties: { n: { type: 'integer', exclusiveMinimum: 1 } } };
        const snapshot = JSON.parse(JSON.stringify(schema));
        sanitizeGeminiSchema(schema);
        expect(schema).toEqual(snapshot);
    });

    test('passes a clean schema through unchanged', () => {
        const clean = {
            type: 'object',
            properties: { name: { type: 'string', description: 'a name' } },
            required: ['name'],
        };
        expect(sanitizeGeminiSchema(clean)).toEqual(clean);
    });
});

describe('sanitizeFunctionDeclarations', () => {
    test('sanitizes each declaration parameters and leaves names/descriptions intact', () => {
        const decls = [
            { name: 'a', description: 'd', parameters: { type: 'object', additionalProperties: false } },
            { name: 'b' }, // no parameters — left as-is
        ];
        const out = sanitizeFunctionDeclarations(decls);
        expect(out[0].name).toBe('a');
        expect(out[0].description).toBe('d');
        expect(out[0].parameters.additionalProperties).toBeUndefined();
        expect(out[1]).toEqual({ name: 'b' });
    });
});
