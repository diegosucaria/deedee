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

    test('send() should include Authorization header', async () => {
        axios.post.mockResolvedValue({ data: {} });

        await httpInterface.send({
            source: 'telegram',
            content: 'hello',
            metadata: { chatId: '123' }
        });

        expect(axios.post).toHaveBeenCalledWith(
            `${mockUrl}/send`,
            expect.objectContaining({ content: 'hello' }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Authorization': `Bearer ${mockToken}`
                })
            })
        );
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
