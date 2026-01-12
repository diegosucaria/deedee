
const request = require('supertest');
const express = require('express');
const { createInternalRouter } = require('../src/routes/internal');

describe('Internal Router - Session Reuse', () => {
    let app;
    let mockAgent;

    beforeEach(() => {
        mockAgent = {
            db: {
                getLatestEmptySession: jest.fn(),
                createSession: jest.fn().mockReturnValue({ id: 'new-uuid', title: 'New Chat' })
            },
            journal: {},
            scheduler: {},
            backupManager: {}
        };

        app = express();
        app.use(express.json());
        app.use('/internal', createInternalRouter(mockAgent));
    });

    test('should reuse empty session if it is NOT a WhatsApp ID', async () => {
        const webSession = { id: 'uuid-1234', title: 'New Chat' };
        mockAgent.db.getLatestEmptySession.mockReturnValue(webSession);

        const res = await request(app)
            .post('/internal/sessions')
            .send({ reuseEmpty: true });

        expect(res.body.id).toBe('uuid-1234');
        expect(mockAgent.db.createSession).not.toHaveBeenCalled();
    });

    test('should NOT reuse empty session if it IS a WhatsApp ID', async () => {
        const waSession = { id: '12345678@s.whatsapp.net', title: 'New Chat' };
        mockAgent.db.getLatestEmptySession.mockReturnValue(waSession);

        const res = await request(app)
            .post('/internal/sessions')
            .send({ reuseEmpty: true });

        expect(res.body.id).toBe('new-uuid');
        // Because the found empty session was rejected, it should create a new one
        expect(mockAgent.db.createSession).toHaveBeenCalled();
    });

    test('should create new session if no empty session exists', async () => {
        mockAgent.db.getLatestEmptySession.mockReturnValue(null);

        const res = await request(app)
            .post('/internal/sessions')
            .send({ reuseEmpty: true });

        expect(res.body.id).toBe('new-uuid');
        expect(mockAgent.db.createSession).toHaveBeenCalled();
    });
});
