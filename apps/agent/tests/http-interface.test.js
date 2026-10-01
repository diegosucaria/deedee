const { HttpInterface, SEND_TIMEOUT_MS } = require('../src/http-interface');
const axios = require('axios');

jest.mock('axios');

describe('HttpInterface', () => {
    let httpInterface;
    const mockUrl = 'http://interfaces:5000';
    const mockToken = 'test-token';

    beforeEach(() => {
        httpInterface = new HttpInterface(mockUrl, mockToken);
        jest.clearAllMocks();
    });

    test('send() should include Authorization header and log content', async () => {
        axios.post.mockResolvedValue({ data: {} });
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        await httpInterface.send({
            source: 'telegram',
            content: 'hello',
            metadata: { chatId: '123' }
        });

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Preview: "hello"'));

        expect(axios.post).toHaveBeenCalledWith(
            `${mockUrl}/send`,
            expect.objectContaining({ content: 'hello' }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Authorization': `Bearer ${mockToken}`
                })
            })
        );
        consoleSpy.mockRestore();
    });

    test('send() puts the WhatsApp id of what went out on the caller\'s object and still returns true', async () => {
        axios.post.mockResolvedValue({ data: { success: true, messageId: 'WAID-3' } });
        jest.spyOn(console, 'log').mockImplementation(() => { });
        const payload = { source: 'whatsapp', content: 'hola', metadata: { chatId: '15550100@s.whatsapp.net', session: 'user' } };
        await expect(httpInterface.send(payload)).resolves.toBe(true);
        expect(payload.sentMessageId).toBe('WAID-3');
        const plain = { source: 'telegram', content: 'hi', metadata: { chatId: '1' } };
        axios.post.mockResolvedValue({ data: { success: true } });
        await httpInterface.send(plain);
        expect(plain.sentMessageId).toBeUndefined();
        console.log.mockRestore();
    });

    test('send() should include platform and isNotification in payload', async () => {
        axios.post.mockResolvedValue({ data: {} });
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        await httpInterface.send({
            source: 'scheduler',
            content: 'notification text',
            isNotification: true,
            platform: 'whatsapp',
            metadata: { chatId: '123' }
        });

        expect(axios.post).toHaveBeenCalledWith(
            `${mockUrl}/send`,
            expect.objectContaining({
                source: 'scheduler',
                content: 'notification text',
                isNotification: true,
                platform: 'whatsapp'
            }),
            expect.anything()
        );
        consoleSpy.mockRestore();
    });

    test('send() forwards the message id and bounds the call with a timeout', async () => {
        axios.post.mockResolvedValue({ data: {} });
        jest.spyOn(console, 'log').mockImplementation(() => { });

        await httpInterface.send({ id: 'msg-1', source: 'whatsapp:assistant', content: 'hi', metadata: { chatId: 'c1' } });

        expect(axios.post).toHaveBeenCalledWith(
            `${mockUrl}/send`,
            expect.objectContaining({ id: 'msg-1', source: 'whatsapp', metadata: { chatId: 'c1', session: 'assistant' } }),
            expect.objectContaining({ timeout: SEND_TIMEOUT_MS })
        );
        expect(SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);

        // A message without an id still goes out; the id is null on the wire.
        await httpInterface.send({ source: 'telegram', content: 'hi', metadata: { chatId: '1' } });
        expect(axios.post.mock.calls[1][1].id).toBeNull();
    });

    test('send() returns false when the call times out', async () => {
        axios.post.mockRejectedValue(Object.assign(new Error('timeout of 120000ms exceeded'), { code: 'ECONNABORTED' }));
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        await expect(httpInterface.send({ id: 'msg-2', source: 'telegram', content: 'hi', metadata: { chatId: '1' } })).resolves.toBe(false);
    });

    test('sendProgress() should include Authorization header', async () => {
        axios.post.mockResolvedValue({ data: {} });

        await httpInterface.sendProgress('123', 'Thinking...');

        expect(axios.post).toHaveBeenCalledWith(
            `${mockUrl}/progress`,
            expect.anything(),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Authorization': `Bearer ${mockToken}`
                })
            })
        );
    });
});
