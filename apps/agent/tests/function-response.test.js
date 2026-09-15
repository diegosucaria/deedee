const { buildFunctionResponseParts, stripInlineParts, imagesAsUserContent, isPartsRejection, splitImages } = require('../src/utils/function-response');

const PNG = 'iVBORw0KGgo=';

describe('buildFunctionResponseParts', () => {
    test('no images: model and DB carry the same plain functionResponse', () => {
        const { model, db } = buildFunctionResponseParts({ name: 'browser_snapshot' }, { output: 'tree' }, []);
        expect(model).toEqual({ functionResponse: { name: 'browser_snapshot', response: { output: 'tree' } } });
        expect(db).toEqual(model);
        expect(model.functionResponse.parts).toBeUndefined();
    });

    test('images go to the model as inlineData and to the DB as a count', () => {
        const images = [{ mimeType: 'image/jpeg', data: PNG }, { data: PNG }];
        const { model, db } = buildFunctionResponseParts({ name: 'browser_take_screenshot' }, { output: 'ok' }, images);
        expect(model.functionResponse.parts).toEqual([
            { inlineData: { mimeType: 'image/jpeg', data: PNG } },
            { inlineData: { mimeType: 'image/png', data: PNG } },
        ]);
        expect(model.functionResponse.response).toEqual({ output: 'ok' });
        expect(db.functionResponse.parts).toBeUndefined();
        expect(db.functionResponse.response).toEqual({ output: 'ok', _images: '2 image(s) sent to model' });
        expect(JSON.stringify(db)).not.toContain(PNG);
    });

    test('images without data are dropped', () => {
        const { model } = buildFunctionResponseParts({ name: 'x' }, { output: 'o' }, [{ mimeType: 'image/png' }, null]);
        expect(model.functionResponse.parts).toBeUndefined();
    });
});

describe('fallback helpers', () => {
    const withImage = buildFunctionResponseParts({ name: 'browser_take_screenshot' }, { output: 'ok' }, [{ data: PNG }]).model;
    const plain = buildFunctionResponseParts({ name: 'browser_snapshot' }, { output: 'tree' }).model;

    test('stripInlineParts removes only functionResponse.parts', () => {
        const stripped = stripInlineParts([withImage, plain]);
        expect(stripped[0].functionResponse.parts).toBeUndefined();
        expect(stripped[0].functionResponse.response).toEqual({ output: 'ok' });
        expect(stripped[1]).toBe(plain);
    });

    test('imagesAsUserContent builds one user content with all images', () => {
        const c = imagesAsUserContent([withImage, plain]);
        expect(c.role).toBe('user');
        expect(c.parts[0].text).toContain('browser_take_screenshot');
        expect(c.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } });
        expect(imagesAsUserContent([plain])).toBeNull();
    });

    test('isPartsRejection matches a 400 that mentions parts', () => {
        expect(isPartsRejection({ status: 400, message: 'Invalid value at functionResponse.parts' })).toBe(true);
        expect(isPartsRejection(new Error('[400 Bad Request] Unknown name "parts"'))).toBe(true);
        expect(isPartsRejection({ status: 400, message: 'other' })).toBe(false);
        expect(isPartsRejection({ status: 503, message: 'parts overloaded' })).toBe(false);
    });

    test('splitImages strips _images and normalizes them', () => {
        const r = splitImages({ output: 'x', _images: [{ data: PNG }] });
        expect(r.result).toEqual({ output: 'x' });
        expect(r.images).toEqual([{ mimeType: 'image/png', data: PNG }]);
        expect(splitImages('text')).toEqual({ result: 'text', images: [] });
        expect(splitImages(null)).toEqual({ result: null, images: [] });
    });
});
