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
            configService: { getModel: jest.fn().mockReturnValue('gemini-3.6-flash'), getThinkingConfig: () => null },
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

    // Found by running the real prompt against the live fact set: Pro asked to
    // delete a concert nine days away. Its key is category 'temporal' and was
    // last touched outside the recency window, so no other rule covered it.
    test('never deletes a fact whose date has not arrived yet', async () => {
        const day = (offset) => {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            return d.toISOString().split('T')[0];
        };
        const facts = [
            fact(`user_concert_on_${day(9)}`, { category: 'temporal' }),
            fact(`user_appointment_on_${day(60)}`, { category: 'temporal' }),
            fact(`user_flight_on_${day(0)}`, { category: 'temporal' }),
            fact(`user_dinner_on_${day(-30)}`, { category: 'temporal' }),
            fact('user_note_on_not-a-date', { category: 'temporal' })
        ];
        setup(facts);
        deleteKeys = facts.map(f => f.key);

        await service.prune();

        // Nothing still to come may go, whatever the model named.
        expect(deleted).not.toContain(`user_concert_on_${day(9)}`);
        expect(deleted).not.toContain(`user_appointment_on_${day(60)}`);
        expect(deleted).not.toContain(`user_flight_on_${day(0)}`);
        // A date already past and a key with no date are still fair game (the
        // past-dated one goes in the deterministic pass before the model runs).
        expect(deleted).toContain(`user_dinner_on_${day(-30)}`);
        expect(deleted).toContain('user_note_on_not-a-date');
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
