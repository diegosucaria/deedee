const { HttpInterface } = require('../src/http-interface');
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
