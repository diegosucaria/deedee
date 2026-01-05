const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Job Logs Persistence', () => {
    let db;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-test-'));
        db = new AgentDB(tmpDir);
    });

    afterEach(() => {
        if (db.db && db.db.open) db.db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('should log job execution', () => {
        db.logJobExecution('test_job', 'success', 'Result: OK', 150);

        const logs = db.getJobLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0].job_name).toBe('test_job');
        expect(logs[0].status).toBe('success');
        expect(logs[0].output).toBe('Result: OK');
        expect(logs[0].duration_ms).toBe(150);
    });

    test('should filter logs by job name', () => {
        db.logJobExecution('job1', 'success', 'A', 10);
        db.logJobExecution('job2', 'failure', 'B', 20);
        db.logJobExecution('job1', 'success', 'C', 12);

        const logs1 = db.getJobLogs(50, 'job1');
        expect(logs1).toHaveLength(2);
        expect(logs1[0].job_name).toBe('job1');
        expect(logs1[1].job_name).toBe('job1');

        const logs2 = db.getJobLogs(50, 'job2');
        expect(logs2).toHaveLength(1);
        expect(logs2[0].job_name).toBe('job2');
    });

    test('should cleanup old logs', () => {
        // Insert old log manually
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 31);

        db.db.prepare(`
            INSERT INTO job_logs (job_name, status, output, duration_ms, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `).run('old_job', 'success', 'old', 100, oldDate.toISOString());

        // Insert new log
        db.logJobExecution('new_job', 'success', 'new', 100);

        const beforeCount = db.getJobLogs(100).length;
        expect(beforeCount).toBe(2);

        const deleted = db.cleanupJobLogs(30);
        expect(deleted).toBe(1);

        const afterLogs = db.getJobLogs(100);
        expect(afterLogs).toHaveLength(1);
        expect(afterLogs[0].job_name).toBe('new_job');
    });
});
