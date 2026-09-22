/**
 * The vault chat pane was dead: it emitted `message` and waited for
 * `message`, names the socket server never used. This drives the real
 * server with a real client, sending exactly what the pane sends, and
 * checks the question reaches the agent with the vault as context and the
 * answer comes back.
 */
const { io: ioClient } = require('socket.io-client');
const {
    VAULT_CHAT_SEND, VAULT_CHAT_REPLY, VAULT_CHAT_THINKING, VAULT_CHAT_ACK,
    vaultChatId, vaultChatPayload
} = require('../../web/src/lib/vault-chat.js');

const TOKEN = 'socket-test-token';

describe('a question typed in a vault pane reaches the agent and comes back', () => {
    let server, io, url, client, posts, postReply;

    beforeAll(async () => {
        jest.resetModules();
        process.env.DEEDEE_API_TOKEN = TOKEN;
        process.env.TELEGRAM_TOKEN = '';
        process.env.ENABLE_WHATSAPP = 'false';
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        posts = [];
        postReply = { data: { replies: [{ content: 'Your policy renews in March.', type: 'text', timestamp: '2026-09-22T10:00:00.000Z' }] } };
        jest.doMock('axios', () => ({
            post: jest.fn(async (target, body) => { posts.push({ target, body }); return postReply; }),
            get: jest.fn(async () => ({ data: {} })),
            put: jest.fn(async () => ({ data: {} })),
            delete: jest.fn(async () => ({ data: {} })),
            isAxiosError: () => false,
            defaults: { headers: { common: {} } },
            create: () => ({ get: jest.fn(), post: jest.fn(), interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } })
        }));

        ({ server, io } = require('../src/server'));
        await new Promise(resolve => server.listen(0, resolve));
        url = `http://localhost:${server.address().port}`;
    });

    afterAll(async () => {
        if (client) client.disconnect();
        io.close();
        await new Promise(resolve => server.close(resolve));
        jest.restoreAllMocks();
    });

    const connect = (chatId) => new Promise((resolve, reject) => {
        const socket = ioClient(url, { transports: ['websocket'], query: { chatId, token: TOKEN } });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
    });

    const waitFor = (socket, event) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event} within 5s`)), 5000);
        socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
    });

    test('the pane\'s event names and payload reach the agent with the vault as context', async () => {
        const vaultId = 'insurance';
        client = await connect(vaultChatId(vaultId));

        const reply = waitFor(client, VAULT_CHAT_REPLY);
        const ack = waitFor(client, VAULT_CHAT_ACK);
        client.emit(VAULT_CHAT_SEND, vaultChatPayload({ vaultId, text: 'When does the policy renew?' }));

        expect((await reply).content).toBe('Your policy renews in March.');
        await ack;

        expect(posts).toHaveLength(1);
        expect(posts[0].target).toMatch(/\/chat$/);
        expect(posts[0].body.content).toBe('When does the policy renew?');
        expect(posts[0].body.metadata.chatId).toBe('vault-insurance');
        expect(posts[0].body.metadata.vaultId).toBe('insurance');
    });

    test('a progress line reaches the pane on the name it listens for', async () => {
        const vaultId = 'insurance';
        const thinking = waitFor(client, VAULT_CHAT_THINKING);
        io.to(vaultChatId(vaultId)).emit(VAULT_CHAT_THINKING, { status: 'Searching documents...' });
        expect((await thinking).status).toBe('Searching documents...');
    });
});
