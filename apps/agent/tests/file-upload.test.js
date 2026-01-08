const { describe, expect, test, beforeEach, afterEach } = require('@jest/globals');
const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const createFilesRouter = require('../src/routes/files');

// Mock Agent
const mockAgent = {
    // Add any required deps
};

const TEST_UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads', 'test-chat');

describe('File Upload API', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use('/v1/chat', createFilesRouter(mockAgent));
        // Clean up test dir
        if (fs.existsSync(TEST_UPLOAD_DIR)) {
            fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(TEST_UPLOAD_DIR)) {
            fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
        }
    });

    test('POST /v1/chat/:id/files uploads a file', async () => {
        const chatId = 'test-chat';
        // Create dummy file
        const dummyPath = path.join(__dirname, 'dummy.txt');
        fs.writeFileSync(dummyPath, 'This is a test file.');

        const res = await request(app)
            .post(`/v1/chat/${chatId}/files`)
            .attach('file', dummyPath);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.originalName).toBe('dummy.txt');

        // Verify it exists in correct path
        const uploadedPath = res.body.path;
        expect(fs.existsSync(uploadedPath)).toBe(true);
        // Should be in data/uploads/test-chat/...
        expect(uploadedPath).toContain(`data/uploads/${chatId}`);

        // Clean dummy
        fs.unlinkSync(dummyPath);
    });

    test('POST /v1/chat/:id/files fails without file', async () => {
        const res = await request(app).post('/v1/chat/test-chat/files');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No file uploaded');
    });
});
