// Login rate limiter: per-IP bucket, global failure bucket, and the
// X-Forwarded-For keying.
function req(headers = {}) {
    return { headers: new Headers(headers) };
}

describe('login rate limit', () => {
    let rl;

    beforeEach(() => {
        jest.resetModules();
        rl = require('../src/lib/auth/rate-limit.js');
    });

    describe('clientIp', () => {
        test('uses the LAST X-Forwarded-For entry, the one the proxy added', () => {
            expect(rl.clientIp(req({ 'x-forwarded-for': 'client-claimed, proxy-hop' }))).toBe('proxy-hop');
            expect(rl.clientIp(req({ 'x-forwarded-for': 'a, b, c' }))).toBe('c');
        });

        test('trims whitespace and skips empty entries', () => {
            expect(rl.clientIp(req({ 'x-forwarded-for': ' single ' }))).toBe('single');
            expect(rl.clientIp(req({ 'x-forwarded-for': 'a, b, ' }))).toBe('b');
        });

        test('falls back to x-real-ip, then unknown', () => {
            expect(rl.clientIp(req({ 'x-real-ip': 'real' }))).toBe('real');
            expect(rl.clientIp(req())).toBe('unknown');
        });
    });

    describe('per-IP bucket', () => {
        test('allows 5 attempts then blocks with a Retry-After', () => {
            for (let i = 0; i < 5; i++) expect(rl.rateLimitLogin('ip-a').allowed).toBe(true);
            const blocked = rl.rateLimitLogin('ip-a');
            expect(blocked.allowed).toBe(false);
            expect(blocked.retryAfter).toBeGreaterThan(0);
        });

        test('does not affect other IPs', () => {
            for (let i = 0; i < 6; i++) rl.rateLimitLogin('ip-a');
            expect(rl.rateLimitLogin('ip-b').allowed).toBe(true);
        });

        test('resetRateLimit clears the bucket', () => {
            for (let i = 0; i < 6; i++) rl.rateLimitLogin('ip-a');
            rl.resetRateLimit('ip-a');
            expect(rl.rateLimitLogin('ip-a').allowed).toBe(true);
        });
    });

    describe('global failure bucket', () => {
        test('49 failures leave fresh IPs allowed', () => {
            for (let i = 0; i < 49; i++) rl.recordLoginFailure();
            expect(rl.rateLimitLogin('fresh-1').allowed).toBe(true);
        });

        test('50 failures block every IP, even ones never seen', () => {
            for (let i = 0; i < 50; i++) rl.recordLoginFailure();
            const blocked = rl.rateLimitLogin('never-seen');
            expect(blocked.allowed).toBe(false);
            expect(blocked.retryAfter).toBeGreaterThan(0);
            expect(blocked.retryAfter).toBeLessThanOrEqual(600);
        });

        test('the global window expires after 10 minutes', () => {
            const start = Date.now();
            const spy = jest.spyOn(Date, 'now').mockReturnValue(start);
            for (let i = 0; i < 50; i++) rl.recordLoginFailure();
            expect(rl.rateLimitLogin('x').allowed).toBe(false);
            spy.mockReturnValue(start + 10 * 60 * 1000 + 1);
            expect(rl.rateLimitLogin('y').allowed).toBe(true);
            spy.mockRestore();
        });
    });
});
