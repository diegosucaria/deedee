/**
 * Telegram used to cover a picture it could not send with a "sorry" text and
 * report success. It now reports the failure, so generateImage must say the
 * image did not arrive, not "sent to user".
 */
const { MediaExecutor } = require('../src/executors/media');

describe('generateImage', () => {
    let spies;
    beforeEach(() => { spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(() => { })); });
    afterEach(() => spies.forEach(s => s.mockRestore()));

    const services = () => ({
        client: { models: { generateContent: jest.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cG5n' } }] } }] }) } },
        agent: { configService: { getModel: () => 'image-model' } },
        db: { logTokenUsage: jest.fn() },
    });
    const run = (sendCallback) => {
        const svc = services();
        return new MediaExecutor(svc).execute('generateImage', { prompt: 'a lighthouse' },
            { message: { source: 'telegram', metadata: { chatId: '4200' } }, sendCallback }, svc);
    };

    test('a picture the channel refused is reported as not delivered', async () => {
        const sendCallback = jest.fn().mockResolvedValue(false);
        const out = await run(sendCallback);
        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0]).toMatchObject({ type: 'image', metadata: { chatId: '4200' } });
        expect(out).toEqual({ success: false, error: 'The image was generated, but the messaging service did not deliver it.' });
    });

    test('a picture that went out is reported as sent', async () => {
        const out = await run(jest.fn().mockResolvedValue(true));
        expect(out).toMatchObject({ success: true, info: 'Image generated and sent to user.' });
    });

    test('a callback that answers nothing (a web chat) still counts as sent', async () => {
        const out = await run(jest.fn().mockResolvedValue(undefined));
        expect(out.success).toBe(true);
    });
});
