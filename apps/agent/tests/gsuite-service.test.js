
const { GSuiteService } = require('../src/services/gsuite-service');

// Mock googleapis
jest.mock('googleapis', () => {
    const mOAuth2Client = {
        generateAuthUrl: jest.fn(),
        getToken: jest.fn(),
        setCredentials: jest.fn(),
    };

    // Mock class constructor
    const OAuth2 = jest.fn(() => mOAuth2Client);

    const mCalendar = {
        events: {
            list: jest.fn(),
            insert: jest.fn(),
        },
    };

    const mUserinfo = {
        get: jest.fn()
    };

    return {
        google: {
            auth: {
                OAuth2: OAuth2
            },
            calendar: jest.fn(() => mCalendar),
            oauth2: jest.fn(() => ({ userinfo: mUserinfo }))
        },
        _mOAuth2Client: mOAuth2Client,
        _mCalendar: mCalendar,
        _mUserinfo: mUserinfo
    };
});

describe('GSuiteService OAuth', () => {
    let service;
    let mockAgent;
    let processEnvBackup;
    const { google, _mOAuth2Client, _mCalendar, _mUserinfo } = require('googleapis');

    beforeEach(() => {
        // Mock DB
        mockAgent = {
            db: {
                db: {
                    prepare: jest.fn(() => ({
                        get: jest.fn(),
                        run: jest.fn()
                    }))
                }
            }
        };

        processEnvBackup = { ...process.env };
        process.env.GOOGLE_CLIENT_ID = 'cid';
        process.env.GOOGLE_CLIENT_SECRET = 'csec';

        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = processEnvBackup;
    });

    it('should initialize and load clients from DB', async () => {
        // Setup DB mock to return tokens
        const tokens = [
            { email: 'test@gmail.com', tokens: { access_token: 'at' } }
        ];

        const mGet = jest.fn().mockReturnValue({ value: JSON.stringify(tokens) });
        mockAgent.db.db.prepare.mockReturnValue({ get: mGet });

        service = new GSuiteService(mockAgent);

        // Wait for async init (it's fire and forget in constructor, but we can await it via _loadClients if we access it, 
        // or just wait for next tick)
        await service._loadClients();

        expect(google.auth.OAuth2).toHaveBeenCalledWith('cid', 'csec', expect.anything());
        expect(_mOAuth2Client.setCredentials).toHaveBeenCalledWith(tokens[0].tokens);
        expect(service.clients.size).toBe(1);
    });

    it('getAuthUrl should return URL', async () => {
        service = new GSuiteService(mockAgent);
        _mOAuth2Client.generateAuthUrl.mockReturnValue('http://auth-url');

        const url = await service.getAuthUrl();
        expect(url).toBe('http://auth-url');
        expect(google.auth.OAuth2).toHaveBeenCalled();
    });

    it('authenticate should exchange code and save tokens', async () => {
        service = new GSuiteService(mockAgent);

        // Mock getToken response
        _mOAuth2Client.getToken.mockResolvedValue({ tokens: { access_token: 'new_at' } });
        // Mock userinfo response
        _mUserinfo.get.mockResolvedValue({ data: { email: 'new@gmail.com' } });

        // Mock DB Save
        const mRun = jest.fn();
        const mGet = jest.fn().mockReturnValue(undefined); // No existing tokens
        mockAgent.db.db.prepare.mockImplementation((sql) => {
            if (sql.includes('SELECT')) return { get: mGet };
            if (sql.includes('INSERT')) return { run: mRun };
            return {};
        });

        const res = await service.authenticate('code123');

        expect(res).toContain('Authentication successful');
        expect(_mOAuth2Client.getToken).toHaveBeenCalledWith('code123');
        expect(_mUserinfo.get).toHaveBeenCalled();

        // Verify DB save
        expect(mRun).toHaveBeenCalledWith('google_tokens', expect.stringContaining('new@gmail.com'));
        expect(service.clients.has('new@gmail.com')).toBe(true);
    });

    it('listEvents should merge events and show status', async () => {
        service = new GSuiteService(mockAgent);
        service.ready = true;
        const mockAuth = { _label: 'work' };
        service.clients.set('b@gmail.com', mockAuth);

        _mCalendar.events.list
            .mockResolvedValueOnce({
                data: {
                    items: [{
                        summary: 'Meeting',
                        start: { dateTime: '2023-01-01T09:00:00Z' },
                        attendees: [{ email: 'b@gmail.com', responseStatus: 'accepted' }] // 'me' is attendee
                    }]
                }
            });

        const res = await service.listEvents({});

        expect(res).toContain('[work]'); // Label usage
        expect(res).toContain('(accepted)'); // Status usage
    });

    it('setAccountLabel should update label', async () => {
        service = new GSuiteService(mockAgent);

        // Mock existing DB state
        const tokens = [{ email: 'test@gmail.com', tokens: {}, label: null }];
        mockAgent.db.db.prepare.mockReturnValue({
            get: jest.fn().mockReturnValue({ value: JSON.stringify(tokens) }),
            run: jest.fn()
        });

        // Mock loadClients call inside setAccountLabel
        service._loadClients = jest.fn();

        const res = await service.setAccountLabel('test@gmail.com', 'personal');

        expect(res).toContain('is now labeled as \'personal\'');
        // Check DB save call? It's hard to spy on private helper, but we spy on DB prepare
        // The implementation calls _saveTokensToDB which calls db.prepare(INSERT...)
    });
});
