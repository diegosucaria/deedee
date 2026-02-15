
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JournalManager } = require('../src/journal');

describe('JournalManager', () => {
    let journal;
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
        journal = new JournalManager(testDir);
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('should log and retrieve today\'s journal', () => {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

        journal.log('Test Entry 1');
        journal.log('Test Entry 2');

        const today = journal.getParsedJournal(now);

        expect(today).not.toBeNull();
        expect(today.date).toBe(now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'));
        expect(today.interactions).toHaveLength(2);
        expect(today.interactions[0].content).toContain('Test Entry 1');
        expect(today.interactions[0].timestamp).toMatch(/\d{2}:\d{2}/);
    });

    test('should return null if no journal for today', () => {
        // We override read to return null simulation
        jest.spyOn(journal, 'read').mockReturnValue(null);
        const today = journal.getParsedJournal();
        expect(today).toBeNull();
    });
});
