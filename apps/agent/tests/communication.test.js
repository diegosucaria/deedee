const { CommunicationExecutor } = require('../src/executors/communication');

describe('CommunicationExecutor', () => {
    let executor;
    let mockInterfaceService;
    let mockServices;

    beforeEach(() => {
        mockInterfaceService = {
            send: jest.fn().mockResolvedValue({ success: true })
        };
        mockServices = { // Assign to outer variable
            interface: mockInterfaceService,
            db: {
                isVerifiedContact: jest.fn().mockReturnValue(true),
                verifyContact: jest.fn(),
                searchPeople: jest.fn() // Initialize mock
            }
        };
        executor = new CommunicationExecutor(mockServices);
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

        // Ensure searchPeople returns empty or handles JID without error
        mockServices.db.searchPeople = jest.fn().mockReturnValue([]);

        await executor.execute('sendMessage', args, context);

        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                chatId: '12345@s.whatsapp.net'
            })
        }));
    });
    test('sendMessage should resolve contact name using searchPeople', async () => {
        const args = {
            to: 'Mom',
            content: 'Hello'
        };
        const context = { message: {} };

        mockServices.db.searchPeople = jest.fn().mockReturnValue([
            { name: 'Mom', phone: '5551234567' }
        ]);

        await executor.execute('sendMessage', args, context);

        expect(mockServices.db.searchPeople).toHaveBeenCalledWith('Mom');
        expect(mockInterfaceService.send).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                chatId: '5551234567@s.whatsapp.net'
            })
        }));
    });

    test('sendMessage should fail gracefully if contact name not found', async () => {
        const args = {
            to: 'Unknown Person',
            content: 'Hello'
        };
        const context = { message: {} };

        mockServices.db.searchPeople = jest.fn().mockReturnValue([]);

        const result = await executor.execute('sendMessage', args, context);

        expect(result.success).toBe(false);
        expect(result.info).toContain('Could not find contact');
    });

    test('sendMessage should ask for clarification if multiple contacts found', async () => {
        const args = {
            to: 'Diego',
            content: 'Hello'
        };
        const context = { message: {} };

        mockServices.db.searchPeople = jest.fn().mockReturnValue([
            { name: 'Diego Sucaria', phone: '555111' },
            { name: 'Diego Other', phone: '555222' }
        ]);

        const result = await executor.execute('sendMessage', args, context);

        expect(result.success).toBe(false);
        expect(result.info).toContain('Found multiple contacts');
    });

    test('sendMessage should respect communication_dry_run setting', async () => {
        const args = {
            to: '12345',
            content: 'Dry Run Message'
        };
        const context = { message: {} };

        // Mock DB getAgentSetting
        mockServices.db.getAgentSetting = jest.fn().mockImplementation((key) => {
            if (key === 'communication_dry_run') return { value: true };
            if (key === 'owner_name') return { value: 'Diego' };
            if (key === 'owner_phone') return { value: '123456' };
            return null;
        });

        const result = await executor.execute('sendMessage', args, context);

        // Should return success but NOT call interface.send
        expect(result.success).toBe(true);
        expect(result.info).toContain('Dry Run');
        expect(mockInterfaceService.send).not.toHaveBeenCalled();
    });
});
