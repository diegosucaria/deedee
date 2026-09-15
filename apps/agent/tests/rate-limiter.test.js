const { RateLimiter } = require('../src/rate-limiter');

describe('RateLimiter', () => {
    let db;
    let iface;
    let limiter;

    beforeEach(() => {
        db = { checkLimit: jest.fn().mockReturnValue(0), logUsage: jest.fn() };
        iface = { send: jest.fn().mockResolvedValue(true) };
        limiter = new RateLimiter(db);
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => jest.restoreAllMocks());

    test.each(['scheduler', 'subagent', 'system'])('skips count and reply for source %s', async (source) => {
        const ok = await limiter.check({ source, content: 'run', metadata: { chatId: 'c1' } }, iface);
        expect(ok).toBe(true);
        expect(db.checkLimit).not.toHaveBeenCalled();
        expect(db.logUsage).not.toHaveBeenCalled();
        expect(iface.send).not.toHaveBeenCalled();
    });

    test('skips sub-agent runs flagged in metadata', async () => {
        const ok = await limiter.check({ source: 'web', content: 'x', metadata: { isSubAgent: true } }, iface);
        expect(ok).toBe(true);
        expect(db.logUsage).not.toHaveBeenCalled();
    });

    test('skips watcher runs', async () => {
        const ok = await limiter.check({ source: 'whatsapp:user', content: 'SYSTEM_WATCHER_ALERT: x', metadata: {} }, iface);
        expect(ok).toBe(true);
        expect(db.logUsage).not.toHaveBeenCalled();
    });

    test.each(['web', 'whatsapp:assistant', 'telegram', 'slack', 'ios'])('counts source %s', async (source) => {
        const ok = await limiter.check({ source, content: 'hi', metadata: { chatId: 'c1' } }, iface);
        expect(ok).toBe(true);
        expect(db.logUsage).toHaveBeenCalledTimes(1);
    });

    test('replies and blocks a human source over the limit', async () => {
        db.checkLimit.mockReturnValue(999);
        const ok = await limiter.check({ source: 'web', content: 'hi', metadata: { chatId: 'c1' } }, iface);
        expect(ok).toBe(false);
        expect(db.logUsage).not.toHaveBeenCalled();
        expect(iface.send).toHaveBeenCalledWith(expect.objectContaining({ source: 'web', metadata: { chatId: 'c1' } }));
    });

    test('does not reply to an internal source even when over the limit', async () => {
        db.checkLimit.mockReturnValue(999);
        const ok = await limiter.check({ source: 'scheduler', content: 'job', metadata: { chatId: 'scheduled_x' } }, iface);
        expect(ok).toBe(true);
        expect(iface.send).not.toHaveBeenCalled();
    });
});
