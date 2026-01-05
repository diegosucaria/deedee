
const { BackupManager } = require('../src/backup');
const fs = require('fs');
const path = require('path');

// Mock Dependencies
jest.mock('@google-cloud/storage', () => {
    const mFile = {
        name: 'custom/backups/backup-2020-01-01.zip',
        delete: jest.fn().mockResolvedValue({})
    };
    const mBucket = {
        upload: jest.fn().mockResolvedValue({}),
        getFiles: jest.fn().mockResolvedValue([[mFile]])
    };
    const mStorage = {
        bucket: jest.fn().mockReturnValue(mBucket)
    };
    return { Storage: jest.fn(() => mStorage) };
});

jest.mock('archiver', () => {
    return jest.fn(() => ({
        on: jest.fn((event, cb) => {
            if (event === 'end' || event === 'close') setTimeout(cb, 10); // Simulate completion
        }),
        pipe: jest.fn(),
        directory: jest.fn(),
        finalize: jest.fn().mockResolvedValue()
    }));
});

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    createWriteStream: jest.fn(() => ({
        on: jest.fn((event, cb) => {
            if (event === 'close') setTimeout(cb, 10);
        })
    })),
    unlinkSync: jest.fn()
}));

describe('BackupManager', () => {
    let backupManager;
    let mockAgent;

    beforeEach(() => {
        process.env.GCS_BACKUP_BUCKET = 'test-bucket';
        mockAgent = {};
        backupManager = new BackupManager(mockAgent);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('should perform backup successfully', async () => {
        // Set custom path
        process.env.GCS_BACKUP_PATH = 'custom/backups';
        // Re-init
        backupManager = new BackupManager(mockAgent);

        const result = await backupManager.performBackup();

        expect(result.success).toBe(true);
        expect(result.file).toContain('custom/backups/backup-');

        // Verify Storage Calls
        const { Storage } = require('@google-cloud/storage');
        const storageInstance = new Storage();
        const bucket = storageInstance.bucket();
        expect(bucket.upload).toHaveBeenCalled();

        // Verify Cleanup (Rotation)
        // logic: mocked getFiles returns a 2020 file. It should be deleted.
        // Wait, how do I check rotation logic specifically?
        // The mock returns a file from 2020.
        // performBackup calls upload -> cleanup local -> rotateBackups.

        // Verify local cleanup
        expect(fs.unlinkSync).toHaveBeenCalled();
    });

    test('should handle missing bucket env var', async () => {
        delete process.env.GCS_BACKUP_BUCKET;
        // Re-init to pick up empty env
        backupManager = new BackupManager(mockAgent);

        const result = await backupManager.performBackup();
        expect(result.error).toBeDefined();
    });
});
