const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Configure Multer for Generic Uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // We use a temporary staging area or direct to data/uploads
        // Plan says: data/uploads/{chatId}
        // But we don't know chatId in the middleware setup easily unless we pass it.
        // Let's use a temp global dir and move it in the handler to ensure safety.
        const uploadDir = path.join(process.cwd(), 'data', 'uploads', 'temp');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Sanitize filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        cb(null, name + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

module.exports = (agent) => {

    // POST /v1/chat/:id/files
    router.post('/:id/files', upload.single('file'), async (req, res) => {
        const { id: chatId } = req.params;
        const { file } = req;

        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        try {
            // Move from temp to data/uploads/{chatId}/
            const targetDir = path.join(process.cwd(), 'data', 'uploads', chatId);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetPath = path.join(targetDir, file.originalname); // Restoring original name? 
            // Better to keep the safe unique name OR original name?
            // User spec: "keep some metadata and add some smart title... original filename"
            // Let's use original name if it doesn't exist, else append counter.

            // Simple approach: Use the generated unique filename, but store original name in metadata
            // Actually, for "files.js", we usually want to refer to them by a stable path.
            // Let's move the temp file to the final destination.

            const finalFilename = file.filename; // Uses the sanitized unique name
            const finalPath = path.join(targetDir, finalFilename);

            fs.renameSync(file.path, finalPath);

            res.json({
                success: true,
                path: finalPath,
                filename: finalFilename,
                originalName: file.originalname,
                mimeType: file.mimetype,
                size: file.size
            });

        } catch (error) {
            // Cleanup on error
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
