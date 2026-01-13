const { GSuiteService } = require('../src/services/gsuite-service');

// Mock googleapis
jest.mock('googleapis', () => {
    const mCalendar = {
        events: {
            list: jest.fn(),
            insert: jest.fn(),
        },
    };
    return {
        google: {
            calendar: jest.fn(() => mCalendar),
            auth: {
                GoogleAuth: jest.fn(),
            },
        },
    };
});

describe('GSuiteService', () => {
    let service;
    let mockAgent;
    let processEnvBackup;
    const { google } = require('googleapis');

    beforeEach(() => {
        mockAgent = {};
        processEnvBackup = { ...process.env };
        process.env.GOOGLE_CALENDAR_ID = 'test-calendar-id';
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = processEnvBackup;
    });

    it('should initialize with file path credentials', () => {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = './credentials.json';
        service = new GSuiteService(mockAgent);

        expect(google.auth.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
            keyFile: './credentials.json'
        }));
        expect(service.calendar).toBeTruthy();
    });

    it('should initialize with base64 credentials', () => {
        const fakeCreds = JSON.stringify({ project_id: 'p', client_email: 'e' });
        const base64Creds = Buffer.from(fakeCreds).toString('base64');
        process.env.GOOGLE_APPLICATION_CREDENTIALS = base64Creds;

        service = new GSuiteService(mockAgent);

        expect(google.auth.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
            credentials: expect.objectContaining({ project_id: 'p' })
        }));
    });

    it('should return error if not initialized', async () => {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        service = new GSuiteService(mockAgent); // fails init silently but logs error

        const res = await service.listEvents({});
        expect(res).toEqual({ error: 'GSuite credentials not configured.' });
    });

    describe('listEvents', () => {
        beforeEach(() => {
            process.env.GOOGLE_APPLICATION_CREDENTIALS = './credentials.json';
            service = new GSuiteService(mockAgent);
        });

        it('should return list of events', async () => {
            const mockEvents = [
                { summary: 'Meeting 1', start: { dateTime: '2023-01-01T10:00:00Z' }, status: 'confirmed' }
            ];
            // Access the mock instance returned by google.calendar()
            const mCalendar = google.calendar();
            mCalendar.events.list.mockResolvedValue({ data: { items: mockEvents } });

            const result = await service.listEvents({ timeMin: '2023-01-01T00:00:00Z' });
            expect(result).toContain('1. [2023-01-01T10:00:00Z] Meeting 1 (confirmed)');
        });

        it('should handle empty list', async () => {
            const mCalendar = google.calendar();
            mCalendar.events.list.mockResolvedValue({ data: { items: [] } });

            const result = await service.listEvents({});
            expect(result).toBe('No upcoming events found.');
        });
    });

    describe('createEvent', () => {
        beforeEach(() => {
            process.env.GOOGLE_APPLICATION_CREDENTIALS = './credentials.json';
            service = new GSuiteService(mockAgent);
        });

        it('should require summary, startTime, endTime', async () => {
            const res = await service.createEvent({ summary: 'Test' });
            expect(res.error).toContain('Missing required fields');
        });

        it('should call insert and return link', async () => {
            const mCalendar = google.calendar();
            mCalendar.events.insert.mockResolvedValue({ data: { htmlLink: 'http://event-link' } });

            const args = {
                summary: 'Test Event',
                description: 'Desc',
                startTime: '2023-01-01T10:00:00Z',
                endTime: '2023-01-01T11:00:00Z'
            };

            const result = await service.createEvent(args);
            expect(result).toBe('Event created: http://event-link');

            expect(mCalendar.events.insert).toHaveBeenCalledWith({
                calendarId: 'test-calendar-id',
                resource: expect.objectContaining({
                    summary: 'Test Event',
                    start: { dateTime: args.startTime, timeZone: 'UTC' }
                })
            });
        });
    });
});
