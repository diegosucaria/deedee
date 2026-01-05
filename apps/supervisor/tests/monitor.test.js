const { Monitor } = require('../src/monitor');
const fs = require('fs');
const path = require('path');

jest.mock('fs');

describe('Monitor', () => {
    let monitor;
    let mockGit;
    let mockFetch;

    beforeEach(() => {
        mockGit = {
            run: jest.fn(),
            workDir: '/tmp'
        };
        mockFetch = jest.fn(() => Promise.resolve({ ok: true }));
        global.fetch = mockFetch;
        monitor = new Monitor(mockGit);
        monitor.slackWebhookUrl = 'http://slack';
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('notifyStartup: sends alert and saves hash on first run (no file)', async () => {
        mockGit.run.mockResolvedValue('hash123|feat: test commit');
        fs.existsSync.mockReturnValue(false);
        fs.writeFileSync.mockImplementation(() => {});

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe('http://slack');
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (New Update)');
        expect(body.text).toContain('feat: test commit');
        expect(body.text).toContain('hash123');

        expect(fs.writeFileSync).toHaveBeenCalledWith(path.join('/tmp', '.last_boot_commit'), 'hash123');
    });

    test('notifyStartup: sends alert and saves hash on new commit', async () => {
        mockGit.run.mockResolvedValue('hash456|fix: bug');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('hash123');
        fs.writeFileSync.mockImplementation(() => {});

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (New Update)');
        expect(body.text).toContain('fix: bug');
        expect(body.text).toContain('hash456');

        expect(fs.writeFileSync).toHaveBeenCalledWith(path.join('/tmp', '.last_boot_commit'), 'hash456');
    });

    test('notifyStartup: sends simple alert on same commit', async () => {
        mockGit.run.mockResolvedValue('hash123|feat: test commit');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('hash123');

        await monitor.notifyStartup();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.text).toContain('*Deedee Rebooted* (No Changes)');
        expect(body.text).toContain('back online');

        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
});
