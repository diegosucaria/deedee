const { TelegramService } = require('../src/telegram');
const axios = require('axios');

// Mock Dependencies
jest.mock('telegraf', () => {
    return {
        Telegraf: jest.fn().mockImplementation(() => ({
            on: jest.fn(),
            launch: jest.fn(),
            stop: jest.fn(),
            telegram: {
                sendMessage: jest.fn(),
                getFileLink: jest.fn(),
                sendChatAction: jest.fn().mockResolvedValue(true)
            }
        }))
    };
});
jest.mock('axios', () => {
    const mockAxios = {
        post: jest.fn(),
        get: jest.fn(),
        create: jest.fn().mockReturnThis()
    };
    const axiosFn = jest.fn(() => mockAxios);
    Object.assign(axiosFn, mockAxios);
    return axiosFn;
});

describe('TelegramService Security', () => {
    let service;
    const mockMsgHandler = jest.fn();
    const mockVoiceHandler = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.ALLOWED_TELEGRAM_IDS = ''; // Reset env
    });

    test('should ALLOW all when ALLOWED_TELEGRAM_IDS is empty', () => {
        service = new TelegramService('fake-token', 'http://agent:3000');
        expect(service._isAllowed('12345')).toBe(true);
        expect(service._isAllowed('67890')).toBe(true);
    });

    test('should ALLOW specific IDs when ALLOWED_TELEGRAM_IDS is set', () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345, 99999';
        service = new TelegramService('fake-token', 'http://agent:3000');

        expect(service._isAllowed('12345')).toBe(true);
        expect(service._isAllowed('99999')).toBe(true);
    });

    test('should BLOCK unauthorized IDs when ALLOWED_TELEGRAM_IDS is set', () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345';
        service = new TelegramService('fake-token', 'http://agent:3000');

        expect(service._isAllowed('67890')).toBe(false);
    });

    test('should BLOCK logic within handleMessage', async () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345';
        service = new TelegramService('fake-token', 'http://agent:3000');

        const ctx = {
            message: { text: 'Hello' },
            from: { id: '67890' }, // Unauthorized
            chat: { id: 'chat1' },
            reply: jest.fn()
        };

        await service.handleMessage(ctx);

        // Axios should NOT be called
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('should ALLOW logic within handleMessage', async () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345';
        service = new TelegramService('fake-token', 'http://agent:3000');

        const ctx = {
            message: { text: 'Hello' },
            from: { id: '12345' }, // Authorized
            chat: { id: 'chat1' },
            reply: jest.fn()
        };

        axios.post.mockResolvedValue({ data: { ok: true } });

        await service.handleMessage(ctx);

        // Axios SHOULD be called
        expect(axios.post).toHaveBeenCalled();
    });
});
