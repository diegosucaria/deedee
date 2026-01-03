const fs = require('fs');
const path = require('path');
const os = require('os');

class JournalManager {
    constructor(dataDir) {
        // Determine data directory (similar to DB)
        if (!dataDir) {
            if (process.env.DATA_DIR) {
                dataDir = process.env.DATA_DIR;
            } else if (fs.existsSync('/app') && process.platform !== 'darwin') {
                dataDir = '/app/data';
            } else {
                dataDir = path.join(process.cwd(), 'data');
            }
        }

        this.journalDir = path.join(dataDir, 'journal');
        if (!fs.existsSync(this.journalDir)) {
            try {
                fs.mkdirSync(this.journalDir, { recursive: true });
            } catch (e) {
                console.error(`[Journal] Failed to create dir ${this.journalDir}, falling back to tmp.`);
                this.journalDir = path.join(os.tmpdir(), 'deedee_journal');
                fs.mkdirSync(this.journalDir, { recursive: true });
            }
        }
    }

    log(content) {
        const now = new Date();
        // YYYY-MM-DD
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM

        const filename = `${dateStr}.md`;
        const filePath = path.join(this.journalDir, filename);

        const logEntry = `\n- [${timeStr}] ${content}`;

        fs.appendFileSync(filePath, logEntry, 'utf8');
        return filePath;
    }
}

module.exports = { JournalManager };
