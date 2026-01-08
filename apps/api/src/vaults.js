const express = require('express');
const axios = require('axios');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Multer for handling file uploads in the Gateway
const upload = multer({
    dest: '/tmp/uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Helper for proxying
const proxyRequest = async (req, res, method, path, data, headers = {}) => {
    try {
        const url = `${AGENT_URL}${path}`;
        const config = { method, url, params: req.query, headers };

        if (data) config.data = data;

        const response = await axios(config);

        // Forward content-type if it's a file download
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        // If it's a stream (download), pipe it? Axios default is json/text unless specified.
        // For simple JSON API:
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Vault Proxy Error (${method} ${path}):`, error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Agent unavailable' };
        res.status(status).json(data);
    }
};

// GET /v1/vaults
router.get('/', (req, res) => proxyRequest(req, res, 'GET', '/v1/vaults'));

// POST /v1/vaults
router.post('/', (req, res) => proxyRequest(req, res, 'POST', '/v1/vaults', req.body));

// DELETE /v1/vaults/:id
router.delete('/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/v1/vaults/${req.params.id}`));

// GET /v1/vaults/:id
router.get('/:id', (req, res) => proxyRequest(req, res, 'GET', `/v1/vaults/${req.params.id}`));

// POST /v1/vaults/:id/wiki
router.post('/:id/wiki', (req, res) => proxyRequest(req, res, 'POST', `/v1/vaults/${req.params.id}/wiki`, req.body));

// POST /v1/vaults/:id/files (Upload)
router.post('/:id/files', upload.single('file'), async (req, res) => {
    // Handling Multipart Proxying manually with axios + form-data
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(req.file.path), req.file.originalname);

        const url = `${AGENT_URL}/v1/vaults/${req.params.id}/files`;

        const response = await axios.post(url, form, {
            headers: {
                ...form.getHeaders()
            }
        });

        // Cleanup temp file
        fs.unlink(req.file.path, () => { });
        res.json(response.data);
    } catch (error) {
        fs.unlink(req.file.path, () => { });
        console.error('[API] Vault Upload Proxy Error:', error.message);
        res.status(502).json({ error: 'Upload failed' });
    }
});

// GET /v1/vaults/:id/files/:filename (Download)
router.get('/:id/files/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const url = `${AGENT_URL}/v1/vaults/${id}/files/${filename}`;

    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        response.data.pipe(res);
    } catch (error) {
        console.error('[API] Vault Download Proxy Error:', error.message);
        res.status(502).json({ error: 'Download failed' });
    }
});

module.exports = router;
