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
        expect(service._isAllowed('12345')).toBe(false);
        expect(service._isAllowed('67890')).toBe(false);
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

    test('a forwarded message reaches the agent marked as untrusted', async () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345';
        service = new TelegramService('fake-token', 'http://agent:3000');
        axios.post.mockResolvedValue({ data: { ok: true } });

        await service.handleMessage({ message: { text: 'Pay this now', forward_origin: { type: 'user' } }, from: { id: '12345' }, chat: { id: 'chat1' }, reply: jest.fn() });
        await service.handleMessage({ message: { text: 'Pay this now' }, from: { id: '12345' }, chat: { id: 'chat1' }, reply: jest.fn() });

        const [forwarded, typed] = axios.post.mock.calls.slice(-2).map(c => c[1]);
        expect(forwarded.metadata.untrustedTaint).toEqual(['a forwarded message (telegram)']);
        expect(typed.metadata.untrustedTaint).toBeUndefined();
    });

    test('a forwarded voice note or photo is marked untrusted too', async () => {
        process.env.ALLOWED_TELEGRAM_IDS = '12345';
        service = new TelegramService('fake-token', 'http://agent:3000');
        axios.post.mockResolvedValue({ data: { ok: true } });
        axios.get = jest.fn().mockResolvedValue({ data: Buffer.from('x') });

        const base = {
            from: { id: '12345' }, chat: { id: 'chat1' }, reply: jest.fn(), replyWithChatAction: jest.fn(),
            telegram: { getFileLink: jest.fn().mockResolvedValue({ href: 'https://example.test/file' }) }
        };
        await service.handleVoice({ ...base, message: { voice: { file_id: 'v1', mime_type: 'audio/ogg' }, forward_origin: { type: 'user' } } });
        await service.handlePhoto({ ...base, message: { photo: [{ file_id: 'p1' }], caption: 'look', forward_date: 1700000000 } });
        await service.handlePhoto({ ...base, message: { photo: [{ file_id: 'p2' }], caption: 'mine' } });

        const sent = axios.post.mock.calls.filter(c => String(c[0]).endsWith('/webhook')).map(c => c[1]);
        expect(sent).toHaveLength(3);
        expect(sent[0].metadata.untrustedTaint).toEqual(['a forwarded message (telegram)']);
        expect(sent[1].metadata.untrustedTaint).toEqual(['a forwarded message (telegram)']);
        expect(sent[2].metadata.untrustedTaint).toBeUndefined();
    });

    test('sendMessage skips a repeat of the same message id and forgets a failed one', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        service = new TelegramService('fake-token', 'http://agent:3000');
        const tg = service.bot.telegram;
        tg.sendMessage.mockResolvedValue({});

        expect(await service.sendMessage('42', 'hello', { id: 'msg-1' })).toEqual({ duplicate: false });
        expect(await service.sendMessage('42', 'hello', { id: 'msg-1' })).toEqual({ duplicate: true });
        expect(tg.sendMessage).toHaveBeenCalledTimes(1);

        // Without an id nothing is deduped.
        await service.sendMessage('42', 'hello');
        await service.sendMessage('42', 'hello');
        expect(tg.sendMessage).toHaveBeenCalledTimes(3);

        // HTML and plain text both fail: the id is not marked, the retry goes out.
        tg.sendMessage.mockRejectedValueOnce(new Error('HTML')).mockRejectedValueOnce(new Error('network'));
        await expect(service.sendMessage('42', 'hello', { id: 'msg-2' })).rejects.toThrow('network');
        expect(await service.sendMessage('42', 'hello', { id: 'msg-2' })).toEqual({ duplicate: false });
    });
});
