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
        // Use local time consistently (getParsedJournal also uses local time)
        const YYYY = now.getFullYear();
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const DD = String(now.getDate()).padStart(2, '0');
        const dateStr = `${YYYY}-${MM}-${DD}`;
        const timeStr = now.toTimeString().split(' ')[0].substring(0, 5); // HH:MM

        const filename = `${dateStr}.md`;
        const filePath = path.join(this.journalDir, filename);

        const logEntry = `\n- [${timeStr}] ${content}`;

        fs.appendFileSync(filePath, logEntry, 'utf8');
        return filePath;
    }

    getParsedJournal(dateInput = new Date()) {
        let dateStr;
        if (typeof dateInput === 'string') {
            dateStr = dateInput;
        } else {
            const YYYY = dateInput.getFullYear();
            const MM = String(dateInput.getMonth() + 1).padStart(2, '0');
            const DD = String(dateInput.getDate()).padStart(2, '0');
            dateStr = `${YYYY}-${MM}-${DD}`;
        }
        const content = this.read(dateStr);

        if (!content) return null;

        // Parse simplistic structure for now
        // Assuming lines start with "- [HH:MM] "
        const interactions = content.split('\n')
            .filter(line => line.trim().startsWith('- ['))
            .map(line => {
                const match = line.match(/-\s*\[(\d{2}:\d{2})\]\s*(.*)/);
                if (match) {
                    return { timestamp: match[1], content: match[2] };
                }
                return null;
            })
            .filter(Boolean);

        return { date: dateStr, interactions };
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

    setRagService(ragService) {
        this.ragService = ragService;
    }

    async search(query) {
        // Use RAG service for semantic+keyword search if available
        if (this.ragService) {
            try {
                const results = await this.ragService.search(query, 'journal', 10, 0.2);
                return results.map(r => ({
                    date: r.filename ? r.filename.replace('.md', '') : 'unknown',
                    matches: [r.content],
                    score: r.score
                }));
            } catch (e) {
                console.warn('[Journal] RAG search failed, falling back to naive:', e.message);
            }
        }
        return this._naiveSearch(query);
    }

    _naiveSearch(query) {
        const results = [];
        const files = fs.readdirSync(this.journalDir).filter(f => f.endsWith('.md'));

        for (const file of files) {
            const content = fs.readFileSync(path.join(this.journalDir, file), 'utf8');
            if (content.toLowerCase().includes(query.toLowerCase())) {
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
    async syncFactsToMemory(facts) {
        // facts: array of { key, value }
        // We overwrite MEMORY.md with a structured view
        const memoryPath = path.join(path.dirname(this.journalDir), 'MEMORY.md'); // data/MEMORY.md

        const header = '# Durable Memory\n\nThis file is auto-generated from the Agent Brain (Facts). Do not edit manually, use the Dashboard.\n\n';
        const content = facts.map(f => {
            let val = f.value;
            try {
                // Attempt to parse if it's a JSON string
                const parsed = JSON.parse(f.value);
                if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
                    val = parsed;
                } else {
                    // For objects/arrays, keep JSON or format nicely?
                    // Let's keep JSON for complex types but simple for primitives
                    val = JSON.stringify(parsed);
                }
            } catch (e) { }
            return `- **${f.key}**: ${val}`;
        }).join('\n');

        fs.writeFileSync(memoryPath, header + content, 'utf8');
        console.log(`[Journal] Synced ${facts.length} facts to MEMORY.md`);
        return memoryPath;
    }
}

module.exports = { JournalManager };
