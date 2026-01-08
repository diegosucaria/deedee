const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Configure Multer for file uploads
const upload = multer({
    dest: '/tmp/uploads/', // Temporary storage
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

module.exports = (agent) => {
    // Middleware to ensure VaultManager is ready
    const ensureVaults = (req, res, next) => {
        if (!agent.vaults) {
            return res.status(503).json({ error: 'Vault Manager not initialized' });
        }
        next();
    };

    router.use(ensureVaults);

    // GET /v1/vaults - List all vaults
    router.get('/', async (req, res) => {
        try {
            const vaults = await agent.vaults.listVaults();
            res.json(vaults);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // POST /v1/vaults - Create a new vault
    router.post('/', async (req, res) => {
        const { topic } = req.body;
        if (!topic) return res.status(400).json({ error: 'Topic is required' });

        try {
            const id = await agent.vaults.createVault(topic);
            res.json({ id, message: 'Vault created' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // DELETE /v1/vaults/:id - Delete a vault
    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        try {
            await agent.vaults.deleteVault(id);
            res.json({ success: true, message: 'Vault deleted' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /v1/vaults/:id - Get vault details (index + files)
    router.get('/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const wiki = await agent.vaults.readVaultPage(id, 'index.md');
            const files = await agent.vaults.listVaultFiles(id);

            // Check if vault exists (implied by success of above, but good to be explicit if wrapper throws)
            if (wiki === null && files.length === 0) {
                // Verify if directory actually exists or if it's just empty
                // For now, if both fail, we assume 404 or empty.
                // Let's assume 200 but empty if valid folder Check is hard without direct FS access here.
                // But listVaultFiles returns [] if error/empty.
            }

            res.json({
                id,
                wiki: wiki || '',
                files: files || []
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // POST /v1/vaults/:id/files - Upload a file
    router.post('/:id/files', upload.single('file'), async (req, res) => {
        const { id } = req.params;
        const { file } = req;

        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        try {
            // Move from temp to vault
            // We use originalname, but should sanitize. VaultManager.addToVault does sanitize filename via path.basename
            // But we should probably rely on VaultManager to handle the "move" logic from the temp path.

            const targetPath = await agent.vaults.addToVault(id, file.path, file.originalname);

            // Clean up temp file (addToVault usually copies, so we delete source)
            fs.unlink(file.path, (err) => { if (err) console.error("Failed to delete temp upload:", err); });

            res.json({ success: true, path: targetPath });
        } catch (error) {
            // Cleanup temp on error too
            fs.unlink(file.path, () => { });
            res.status(500).json({ error: error.message });
        }
    });

    // GET /v1/vaults/:id/files/:filename - Download file
    router.get('/:id/files/:filename', async (req, res) => {
        const { id, filename } = req.params;

        // Security: Validate ID and Filename are safe (alphanumericish)
        // VaultManager handles path construction safely, but here we construct the path to sendFile.
        // Better to ask VaultManager for the full path.

        // We don't have a "getFilePath" method exposed in VaultExecutor/Manager specifically for this,
        // but we can construct it if we trust the inputs or duplicate the logic.
        // START SAFE PATH CONSTRUCTION
        const safeTopic = id.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const safeFilename = path.basename(filename);

        const filePath = path.join(agent.vaults.vaultsDir, safeTopic, 'files', safeFilename);

        // Verify existence
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.download(filePath);
    });

    // POST /v1/vaults/:id/wiki - Update Wiki Page
    router.post('/:id/wiki', async (req, res) => {
        const { id } = req.params;
        const { content, page } = req.body;

        const pageName = page || 'index.md';

        if (content === undefined) return res.status(400).json({ error: 'Content is required' });

        try {
            await agent.vaults.updateVaultPage(id, pageName, content);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
