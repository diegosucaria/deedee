/**
 * Tests for Browser V2 — Network Monitor
 */

const { installNetworkMonitor, getNetworkLog, getResponseBody, clearNetworkLog } = require('../src/network');

describe('Network Monitor', () => {
    let mockPage;
    let listeners;

    beforeEach(() => {
        clearNetworkLog();
        listeners = {};
        mockPage = {
            on: jest.fn((event, handler) => {
                listeners[event] = handler;
            }),
        };
        installNetworkMonitor(mockPage);
    });

    test('should install request, response, and requestfailed listeners', () => {
        expect(mockPage.on).toHaveBeenCalledWith('request', expect.any(Function));
        expect(mockPage.on).toHaveBeenCalledWith('response', expect.any(Function));
        expect(mockPage.on).toHaveBeenCalledWith('requestfailed', expect.any(Function));
    });

    test('should capture network responses', async () => {
        const request = {
            resourceType: () => 'xhr',
            url: () => 'https://api.example.com/data',
            method: () => 'GET',
        };

        // Simulate request event
        listeners.request(request);

        // Simulate response event
        await listeners.response({
            request: () => request,
            status: () => 200,
            headers: () => ({}),
            text: () => Promise.resolve('{"result": "ok"}'),
        });

        const log = getNetworkLog();
        expect(log).toHaveLength(1);
        expect(log[0].method).toBe('GET');
        expect(log[0].url).toBe('https://api.example.com/data');
        expect(log[0].status).toBe(200);
        expect(log[0].bodyPreview).toBe('{"result": "ok"}');
    });

    test('should filter by URL', async () => {
        const req1 = { resourceType: () => 'xhr', url: () => 'https://api.com/flights', method: () => 'GET' };
        const req2 = { resourceType: () => 'document', url: () => 'https://example.com/page', method: () => 'GET' };

        listeners.request(req1);
        await listeners.response({ request: () => req1, status: () => 200, headers: () => ({}), text: () => Promise.resolve('') });
        listeners.request(req2);
        await listeners.response({ request: () => req2, status: () => 200, headers: () => ({}), text: () => Promise.resolve('') });

        const filtered = getNetworkLog({ urlFilter: 'flights' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].url).toContain('flights');
    });

    test('should get response body by URL pattern', async () => {
        const request = { resourceType: () => 'fetch', url: () => 'https://api.com/prices', method: () => 'POST' };
        listeners.request(request);
        await listeners.response({
            request: () => request,
            status: () => 200,
            headers: () => ({}),
            text: () => Promise.resolve('{"price": 599}'),
        });

        const body = getResponseBody('prices');
        expect(body).not.toBeNull();
        expect(body.body).toBe('{"price": 599}');
        expect(body.status).toBe(200);
    });

    test('should return null for non-matching pattern', () => {
        expect(getResponseBody('nonexistent')).toBeNull();
    });

    test('should capture request failures', () => {
        const request = {
            method: () => 'GET',
            url: () => 'https://broken.com/fail',
            resourceType: () => 'xhr',
            failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
        };

        listeners.requestfailed(request);

        const log = getNetworkLog();
        expect(log).toHaveLength(1);
        expect(log[0].status).toBe(0);
        expect(log[0].error).toContain('ERR_CONNECTION_REFUSED');
    });

    test('should clear network log', async () => {
        const request = { resourceType: () => 'xhr', url: () => 'https://api.com/x', method: () => 'GET' };
        listeners.request(request);
        await listeners.response({ request: () => request, status: () => 200, headers: () => ({}), text: () => Promise.resolve('') });

        expect(getNetworkLog()).toHaveLength(1);
        clearNetworkLog();
        expect(getNetworkLog()).toHaveLength(0);
    });
});
