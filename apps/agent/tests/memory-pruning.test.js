const { MemoryPruningService } = require('../src/services/memory-pruning');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The nightly verdict runs on FLASH, so the guards live in code: a cap per
// run, a protected-fact filter, a backup file and a notification.
describe('MemoryPruningService LLM guards', () => {
    let dir;
    let agent;
    let service;
    let deleted;
    let deleteKeys;

    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

    function fact(key, extra = {}) {
        return {
            key,
            value: `value of ${key}`,
            category: 'general',
            confidence: 'inferred',
            source: 'system',
            created_at: iso(90),
            updated_at: iso(90),
            pinned: 0,
            ...extra
        };
    }

    function setup(facts) {
        deleted = [];
        agent = {
            db: {
                dbPath: path.join(dir, 'agent.db'),
                getAllFacts: jest.fn().mockReturnValue(facts),
                deleteFact: jest.fn(key => { deleted.push(key); }),
                logTokenUsage: jest.fn()
            },
            configService: { getModel: jest.fn().mockReturnValue('gemini-3.6-flash') },
            client: {
                models: {
                    generateContent: jest.fn().mockImplementation(async () => ({
                        candidates: [{ content: { parts: [{ text: JSON.stringify({ delete_keys: deleteKeys }) }] } }]
                    }))
                }
            },
            journal: { syncFactsToMemory: jest.fn().mockResolvedValue(path.join(dir, 'memory.md')) },
            ragService: { ingestDocument: jest.fn().mockResolvedValue(true) },
            notifications: { create: jest.fn() }
        };
        service = new MemoryPruningService(agent);
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
        delete process.env.MEMORY_PRUNE_MAX_DELETES;
        deleteKeys = [];
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.MEMORY_PRUNE_MAX_DELETES;
    });

    test('never deletes a protected fact, whatever the model returns', async () => {
        const facts = [
            fact('user_home_city', { confidence: 'user_explicit' }),
            fact('user_favorite_food', { category: 'preference' }),
            fact('relationship_sister_name', { category: 'relationship' }),
            fact('pinned_thing', { pinned: 1 }),
            fact('note_from_yesterday', { updated_at: iso(1) }),
            fact('temp_context_weather_alert')
        ];
        setup(facts);
        deleteKeys = facts.map(f => f.key);

        const out = await service.prune();

        expect(deleted).toEqual(['temp_context_weather_alert']);
        expect(out.prunedCount).toBe(1);
    });

    test('caps one run at MEMORY_PRUNE_MAX_DELETES keys', async () => {
        const facts = Array.from({ length: 30 }, (_, i) => fact(`stale_item_${i}`));
        setup(facts);
        deleteKeys = facts.map(f => f.key);

        const out = await service.prune();

        expect(out.prunedCount).toBe(10);
        expect(deleted).toHaveLength(10);
    });

    test('MEMORY_PRUNE_MAX_DELETES=0 stops the model deleting anything', async () => {
        process.env.MEMORY_PRUNE_MAX_DELETES = '0';
        const facts = [fact('stale_one'), fact('stale_two')];
        setup(facts);
        deleteKeys = facts.map(f => f.key);

        const out = await service.prune();

        expect(out.prunedCount).toBe(0);
        expect(deleted).toEqual([]);
    });

    test('backs up the values and tells the owner which keys went', async () => {
        const facts = [fact('stale_one'), fact('stale_two')];
        setup(facts);
        deleteKeys = ['stale_one'];

        await service.prune();

        const backup = JSON.parse(fs.readFileSync(path.join(dir, 'pruned_memories.json'), 'utf8'));
        expect(backup.map(b => b.key)).toEqual(['stale_one']);
        expect(backup[0].value).toBe('value of stale_one');
        expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'memory_pruned',
            metadata: expect.objectContaining({ keys: ['stale_one'] })
        }));
    });

    test('the prompt carries each fact\'s updated date so the 7-day rule is checkable', async () => {
        setup([fact('stale_one', { updated_at: '2026-01-02T10:00:00.000Z' })]);
        deleteKeys = [];

        await service.prune();

        const prompt = agent.client.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
        expect(prompt).toContain('updated 2026-01-02');
    });
});
