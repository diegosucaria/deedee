const { CommunicationExecutor } = require('../src/executors/communication');

describe('CommunicationExecutor', () => {
    let executor;
    let mockInterfaceService;
    let mockServices;

    beforeEach(() => {
        mockInterfaceService = {
            send: jest.fn().mockResolvedValue({ success: true })
        };
        const services = {
            interface: mockInterfaceService,
            db: {
                isVerifiedContact: jest.fn().mockReturnValue(true), // Default to verified for tests
                verifyContact: jest.fn()
            }
        };
        executor = new CommunicationExecutor(services);
    });

    test('sendMessage should default to assistant session and text type', async () => {
        const args = {
            to: '12345',
            content: 'Hello'
        };
        const context = { message: {} };

        await executor.execute('sendMessage', args, context);

        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            source: 'whatsapp',
            content: 'Hello',
            type: 'text',
            metadata: expect.objectContaining({
                chatId: '12345@s.whatsapp.net',
                session: 'assistant'
            })
        }));
    });

    test('sendMessage should correctly route to user session', async () => {
        const args = {
            to: '12345',
            content: 'Impersonated message',
            session: 'user'
        };
        const context = { message: {} };

        await executor.execute('sendMessage', args, context);

        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                session: 'user'
            })
        }));
    });

    test('sendMessage should handle image type', async () => {
        const args = {
            to: '12345',
            content: 'base64image',
            type: 'image'
        };
        const context = { message: {} };

        await executor.execute('sendMessage', args, context);

        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            type: 'image',
            content: 'base64image'
        }));
    });

    test('sendMessage should handle existing JID', async () => {
        const args = {
            to: '12345@s.whatsapp.net',
            content: 'Hello'
        };
        const context = { message: {} };

        await executor.execute('sendMessage', args, context);

        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                chatId: '12345@s.whatsapp.net'
            })
        }));
    });
});
