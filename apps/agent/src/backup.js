const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

class BackupManager {
    constructor(agent) {
        this.agent = agent;
        this.storage = new Storage(); // Auto-loads credentials from env
        this.bucketName = process.env.GCS_BACKUP_BUCKET ? process.env.GCS_BACKUP_BUCKET.trim() : null;
        // Default to 'backups' if not specified. Remove trailing slash if present.
        this.backupPath = (process.env.GCS_BACKUP_PATH || 'backups').replace(/\/$/, '');

        console.log('[BackupManager] Initialized.',
            this.bucketName ? `Bucket: ${this.bucketName}` : 'WARNING: GCS_BACKUP_BUCKET not set.',
            `Path: ${this.backupPath}`
        );
    }

    async performBackup() {
        if (!this.bucketName) {
            console.error('[BackupManager] Skipped: GCS_BACKUP_BUCKET not set.');
            return { error: 'GCS_BACKUP_BUCKET not set' };
        }

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DD-HH-mm
        const backupName = `backup-${dateStr}.zip`;
        const outputPath = path.join('/tmp', backupName);

        // Use the actual data directory from the Agent's DB instance
        // Use the actual data directory from the Agent's DB instance, with fallback for tests
        const dbPath = this.agent.db?.dbPath || '/app/data/agent.db';
        const sourceDir = path.dirname(dbPath);

        console.log(`[BackupManager] Starting backup: ${backupName}`);

        try {
            // 1. Create Zip
            await this.createZip(sourceDir, outputPath);
            console.log(`[BackupManager] Zip created at ${outputPath}`);

            // 2. Upload to GCS
            const bucket = this.storage.bucket(this.bucketName);
            const destination = `${this.backupPath}/${backupName}`;

            await bucket.upload(outputPath, {
                destination: destination,
                metadata: {
                    contentType: 'application/zip',
                },
            });
            console.log(`[BackupManager] Uploaded to gs://${this.bucketName}/${destination}`);

            // 3. Cleanup Local
            fs.unlinkSync(outputPath);

            // 4. Rotate Backups (Retention Policy)
            await this.rotateBackups(bucket);

            return { success: true, file: destination };

        } catch (err) {
            console.error('[BackupManager] Backup failed:', err);
            return { error: err.message };
        }
    }

    async createZip(source, out) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(out);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve());
            archive.on('error', (err) => reject(err));

            archive.pipe(output);
            archive.directory(source, false);
            archive.finalize();
        });
    }

    async rotateBackups(bucket) {
        // Keep 30 days
        const RETENTION_DAYS = 30;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

        const prefix = `${this.backupPath}/`;

        try {
            const [files] = await bucket.getFiles({ prefix: prefix });

            for (const file of files) {
                // Parse date from "path/backup-YYYY-MM-DD-HH-mm.zip"
                const match = file.name.match(/backup-(\d{4}-\d{2}-\d{2})/);
                if (match) {
                    const fileDate = new Date(match[1]);
                    if (fileDate < cutoffDate) {
                        console.log(`[BackupManager] Deleting old backup: ${file.name}`);
                        await file.delete();
                    }
                }
            }
        } catch (err) {
            console.warn('[BackupManager] Rotation failed (non-critical):', err.message);
        }
    }

    async getBackups() {
        if (!this.bucketName) return { error: 'GCS_BACKUP_BUCKET not set' };

        try {
            const bucket = this.storage.bucket(this.bucketName);
            const prefix = `${this.backupPath}/`;
            const [files] = await bucket.getFiles({ prefix: prefix });

            return files
                .filter(f => f.name.endsWith('.zip'))
                .map(f => ({
                    name: path.basename(f.name),
                    size: parseInt(f.metadata.size),
                    updated: f.metadata.updated
                }))
                .sort((a, b) => new Date(b.updated) - new Date(a.updated));
        } catch (e) {
            console.error('[BackupManager] Failed to list backups:', e);
            return [];
        }
    }
}

module.exports = { BackupManager };
