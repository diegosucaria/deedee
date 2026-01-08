const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { AgentDB } = require('../src/db');

// Set Env BEFORE requiring anything that uses it
process.env.GOOGLE_API_KEY = 'test_key';

// Mock MCP Manager
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        callTool: jest.fn(),
        close: jest.fn()
    }))
}));

const { app, agent } = require('../src/server');

const TEST_DB_PATH = path.join(__dirname, 'test_people.db');

describe('People Feature Integration', () => {
    let db;

    beforeAll(async () => {
        // Init separate DB
        if (fs.existsSync(TEST_DB_PATH)) {
            try { fs.unlinkSync(TEST_DB_PATH); } catch (e) { }
        }
        db = new AgentDB(TEST_DB_PATH);
        db.init();

        // Inject this DB into the running Agent instance
        if (agent) {
            if (agent.db && agent.db.db) {
                try { agent.db.db.close(); } catch (e) { }
            }
            agent.db = db;
        } else {
            console.warn('Agent instance not found in server export. Routes might not be mounted.');
        }
    });

    afterAll(async () => {
        if (db && db.db) {
            try { db.db.close(); } catch (e) { }
        }

        // Stop agent to close server handles if any
        if (agent && agent.db && agent.db.db) {
            // Redundant if we swapped it, but just in case
            try { agent.db.db.close(); } catch (e) { }
        }

        // Give it a moment to release locks
        await new Promise(r => setTimeout(r, 500));

        if (fs.existsSync(TEST_DB_PATH)) {
            try { fs.unlinkSync(TEST_DB_PATH); } catch (e) { console.error('Failed to unlink test db:', e.message); }
        }
    });

    test('POST /internal/people creates a person', async () => {
        const payload = {
            name: 'John Doe',
            phone: '1234567890',
            relationship: 'Friend',
            notes: 'Test note',
            source: 'test'
        };

        const res = await request(app)
            .post('/internal/people')
            .send(payload);

        if (res.statusCode === 404) {
            console.error('Got 404. Routes available:', app._router.stack.filter(r => r.route).map(r => r.route.path));
        }

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('id');

        const person = db.getPerson(res.body.id);
        expect(person.name).toBe('John Doe');
    });

    test('GET /internal/people lists people', async () => {
        const res = await request(app).get('/internal/people');
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThan(0);
        const john = res.body.find(p => p.name === 'John Doe');
        expect(john).toBeDefined();
        expect(john.name).toBe('John Doe');
    });

    test('GET /internal/people/:id gets a person', async () => {
        const id = db.createPerson({ name: 'Jane' });
        const res = await request(app).get(`/internal/people/${id}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.name).toBe('Jane');
    });

    test('PUT /internal/people/:id updates a person', async () => {
        const id = db.createPerson({ name: 'Bob' });
        const res = await request(app)
            .put(`/internal/people/${id}`)
            .send({ relationship: 'Colleague' });

        expect(res.statusCode).toBe(200);
        const updated = db.getPerson(id);
        expect(updated.relationship).toBe('Colleague');
    });

    test('DELETE /internal/people/:id deletes a person', async () => {
        const id = db.createPerson({ name: 'Delete Me' });
        const res = await request(app).delete(`/internal/people/${id}`);
        expect(res.statusCode).toBe(200);
        const check = db.getPerson(id);
        expect(check).toBeUndefined();
    });

    test('DB Search People', () => {
        db.createPerson({ name: 'Alice Wonderland', notes: 'Found in hole' });
        const results = db.searchPeople('hole');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe('Alice Wonderland');
    });
});
