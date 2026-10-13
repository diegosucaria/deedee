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

    describe('sendPhoto', () => {
        let tg;
        const png = Buffer.from('png-bytes').toString('base64');
        beforeEach(() => {
            jest.spyOn(console, 'log').mockImplementation(() => { });
            jest.spyOn(console, 'error').mockImplementation(() => { });
            jest.spyOn(console, 'warn').mockImplementation(() => { });
            service = new TelegramService('fake-token', 'http://agent:3000');
            tg = service.bot.telegram;
            tg.sendPhoto = jest.fn().mockResolvedValue({});
            tg.sendMessage.mockResolvedValue({});
        });

        test('a picture keeps its words as the caption, formatted like a text message', async () => {
            await service.sendPhoto('42', png, 'Good morning! **WEATHER:** 12 < 18');
            expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
            expect(tg.sendPhoto).toHaveBeenCalledWith('42', { source: Buffer.from('png-bytes') },
                { caption: 'Good morning! <b>WEATHER:</b> 12 &lt; 18', parse_mode: 'HTML' });
            expect(tg.sendMessage).not.toHaveBeenCalled();
        });

        test('a caption Telegram cannot parse goes again as plain words', async () => {
            tg.sendPhoto.mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities: unsupported start tag"));
            await service.sendPhoto('42', png, 'the [odd](words');
            expect(tg.sendPhoto).toHaveBeenCalledTimes(2);
            expect(tg.sendPhoto.mock.calls[1][2]).toEqual({ caption: 'the [odd](words' });
        });

        test('any other failure is not retried: the picture may have gone out', async () => {
            tg.sendPhoto.mockRejectedValueOnce(new Error('socket hang up'));
            await expect(service.sendPhoto('42', png, 'the words')).rejects.toThrow('socket hang up');
            expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
        });

        test('a picture that went out is not reported lost when its long text fails', async () => {
            // Reported lost, the caller queued the words and a retry sent the picture twice.
            tg.sendMessage.mockRejectedValue(new Error('network'));
            await expect(service.sendPhoto('42', png, 'word '.repeat(300).trim())).resolves.toBeUndefined();
            expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
        });

        test('words too long for a caption follow the picture as a message', async () => {
            const long = 'word '.repeat(300).trim();
            await service.sendPhoto('42', png, long);
            expect(tg.sendPhoto).toHaveBeenCalledWith('42', { source: Buffer.from('png-bytes') });
            expect(tg.sendMessage).toHaveBeenCalledTimes(1);
            expect(tg.sendMessage.mock.calls[0][1]).toBe(long);
        });

        test('a picture that fails throws, and no "sorry" text pretends it went out', async () => {
            tg.sendPhoto.mockRejectedValue(new Error('Bad Request: IMAGE_PROCESS_FAILED'));
            await expect(service.sendPhoto('42', png, 'the words')).rejects.toThrow('IMAGE_PROCESS_FAILED');
            expect(tg.sendMessage).not.toHaveBeenCalled();
        });
    });
});
