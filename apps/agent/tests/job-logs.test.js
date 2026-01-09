const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Job Logs Persistence', () => {
    let db;
    let tmpDir;

    beforeEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-test-'));
        db = new AgentDB(tmpDir);
    });

    afterEach(() => {
        if (db) db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('should log job execution', () => {
        db.logJobExecution('test_job', 'success', 'Result: OK', 150);

        const { logs } = db.getJobLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0].job_name).toBe('test_job');
        expect(logs[0].status).toBe('success');
        expect(logs[0].output).toBe('Result: OK');
    });

    test('should filter logs by job name', () => {
        db.logJobExecution('job_a', 'success', 'OK', 100);
        db.logJobExecution('job_b', 'success', 'OK', 100);

        const logsA = db.getJobLogs(50, 0, 'job_a').logs; // Pass offset 0
        expect(logsA).toHaveLength(1);
        expect(logsA[0].job_name).toBe('job_a');

        const logsB = db.getJobLogs(50, 0, 'job_b').logs;
        expect(logsB).toHaveLength(1);
        expect(logsB[0].job_name).toBe('job_b');
    });

    test('should cleanup old logs', () => {
        // Mock time would be better, but for now just rely on DB logic
        const now = Date.now();
        const oldTime = new Date(now - 1000 * 60 * 60 * 24 * 60); // 60 days ago

        // Use direct insert to bypass timestamp default
        db.db.prepare('INSERT INTO job_logs (job_name, status, timestamp) VALUES (?, ?, ?)').run('old_job', 'success', oldTime.toISOString());
        db.logJobExecution('new_job', 'success', 'OK', 100);

        const beforeCount = db.getJobLogs(100).logs.length;
        expect(beforeCount).toBe(2);

        const deleted = db.cleanupJobLogs(30);
        expect(deleted).toBe(1);

        const afterLogs = db.getJobLogs(100).logs;
        expect(afterLogs).toHaveLength(1);
        expect(afterLogs[0].job_name).toBe('new_job');
    });
});
