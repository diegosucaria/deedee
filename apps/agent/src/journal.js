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
    read(date) {
        // date: YYYY-MM-DD
        const filename = `${date}.md`;
        const filePath = path.join(this.journalDir, filename);

        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
        return null;
    }

    search(query) {
        // Naive text search across all markdown files
        // Returns array of { date, content } chunks
        const results = [];
        const files = fs.readdirSync(this.journalDir).filter(f => f.endsWith('.md'));

        for (const file of files) {
            const content = fs.readFileSync(path.join(this.journalDir, file), 'utf8');
            if (content.toLowerCase().includes(query.toLowerCase())) {
                // Find the specific line or context
                const lines = content.split('\n');
                const matchingLines = lines.filter(l => l.toLowerCase().includes(query.toLowerCase()));

                results.push({
                    date: file.replace('.md', ''),
                    matches: matchingLines
                });
            }
        }
        return results;
    }
    getStats() {
        const files = fs.readdirSync(this.journalDir).filter(f => f.endsWith('.md'));
        let totalEntries = 0;
        let last7DaysEntries = 0;

        const now = new Date();
        const sevenDaysAgo = new Date(now.setDate(now.getDate() - 7));

        for (const file of files) {
            const content = fs.readFileSync(path.join(this.journalDir, file), 'utf8');
            // Count lines starting with - [
            const entries = content.split('\n').filter(l => l.trim().match(/^-\s*\[\d{2}:\d{2}\]/)).length;
            totalEntries += entries;

            // Check date for last 7 days
            const fileDateStr = file.replace('.md', '');
            const fileDate = new Date(fileDateStr);
            if (fileDate >= sevenDaysAgo) {
                last7DaysEntries += entries;
            }
        }

        return {
            totalFiles: files.length,
            totalEntries,
            last7DaysEntries
        };
    }
}

module.exports = { JournalManager };
