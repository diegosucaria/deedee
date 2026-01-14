const { NodeREDClient } = require('../src/client');
const axios = require('axios');

jest.mock('axios');

describe('NodeREDClient', () => {
    let client;
    const mockAxiosInstance = {
        post: jest.fn(),
        get: jest.fn(),
        put: jest.fn(),
        defaults: { headers: {} }
    };

    beforeEach(() => {
        axios.create.mockReturnValue(mockAxiosInstance);
        client = new NodeREDClient('http://localhost:1880', 'user', 'pass');
        jest.clearAllMocks();
    });

    test('authenticate should get token', async () => {
        mockAxiosInstance.post.mockResolvedValue({
            status: 200,
            data: { access_token: 'fake-token' }
        });

        await client.authenticate();

        expect(mockAxiosInstance.post).toHaveBeenCalledWith('/auth/token', expect.objectContaining({
            username: 'user',
            password: 'pass'
        }));
        expect(client.token).toBe('fake-token');
    });

    test('listFlows should call /flows', async () => {
        mockAxiosInstance.get.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: [{ id: 'flow1', type: 'tab' }]
        });
        client.token = 'fake-token';

        const flows = await client.listFlows();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/flows', expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer fake-token' })
        }));
        expect(flows).toHaveLength(1);
    });
});
