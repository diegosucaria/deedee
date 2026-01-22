const { ImpersonationService } = require('../src/services/impersonation');

describe('Impersonation Guardrails', () => {
    let service;
    let mockDb;
    let mockAgent;

    beforeEach(() => {
        mockDb = {
            getPerson: jest.fn(),
            updatePerson: jest.fn(),
            db: { prepare: jest.fn() }
        };
        mockAgent = {
            db: mockDb,
            client: {}
        };
        service = new ImpersonationService(mockAgent);
    });

    test('should return null if person not found', () => {
        mockDb.getPerson.mockReturnValue(null);
        expect(service.getContactStyle('123')).toBeNull();
    });

    test('should return plain style profile if no relationship set', () => {
        mockDb.getPerson.mockReturnValue({
            id: '123',
            metadata: JSON.stringify({ style_profile: 'Original Style.' }),
            relationship: null
        });
        const style = service.getContactStyle('123');
        expect(style).toBe('Original Style.');
    });

    test('should append Professional constraint for "Boss"', () => {
        mockDb.getPerson.mockReturnValue({
            id: '123',
            metadata: { style_profile: 'Original Style.' },
            relationship: 'My Boss'
        });
        const style = service.getContactStyle('123');
        expect(style).toContain('Original Style.');
        expect(style).toContain('Professional relationship');
        expect(style).toContain('NO slang');
    });

    test('should append Professional constraint for "Client"', () => {
        mockDb.getPerson.mockReturnValue({
            id: '123',
            relationship: 'Important Client'
        });
        const style = service.getContactStyle('123');
        expect(style).toContain('Professional relationship');
    });

    test('should append Casual constraint for "Friend"', () => {
        mockDb.getPerson.mockReturnValue({
            id: '456',
            metadata: { style_profile: 'Standard.' },
            relationship: 'Best Friend'
        });
        const style = service.getContactStyle('456');
        expect(style).toContain('Standard.');
        expect(style).toContain('Personal relationship');
        expect(style).toContain('Slang allowed');
    });

    test('should append Casual constraint for "Cousin"', () => {
        mockDb.getPerson.mockReturnValue({
            id: '456',
            relationship: 'Cousin Vinny'
        });
        const style = service.getContactStyle('456');
        expect(style).toContain('Personal relationship');
    });

    test('should handle JID lookup fallback', () => {
        // Mock getPerson returning null for JID, but success for Phone
        mockDb.getPerson
            .mockReturnValueOnce(null) // JID fail
            .mockReturnValueOnce({ relationship: 'Boss' }); // Phone success

        const style = service.getContactStyle('123456@s.whatsapp.net');
        expect(mockDb.getPerson).toHaveBeenCalledTimes(2);
        expect(style).toContain('Professional relationship');
    });
});
