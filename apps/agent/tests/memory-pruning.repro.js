
require('dotenv').config({ path: '.env' }); // Ensure env vars are loaded for Gemini
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const { MemoryPruningService } = require('../src/services/memory-pruning');

async function run() {
    console.log('--- Memory Pruning Verification ---');

    // 1. Setup DB and Fact
    const db = new AgentDB('/Users/diego/Projects/DeeDee/data');
    const STALE_KEY = 'test_stale_fact_on_2020_01_01';
    const FRESH_KEY = 'user_favorite_food';
    const FUTURE_KEY = 'user_plans_on_2030_01_01';

    db.setKey(STALE_KEY, 'Dinner at 8pm on Friday (stale)');
    db.setKey(FRESH_KEY, 'Pizza');
    db.setKey(FUTURE_KEY, 'Future plans');

    console.log('[Setup] Facts inserted.');

    // 2. Mock Agent and Interface
    const mockInterface = { on: () => { } };
    const agent = new Agent({ db, interface: mockInterface });

    // We can't easily run full agent.start() because of RAG/Server issues, 
    // but we need the client initialized.
    // Let's manually init the client if we can, or just try catch start.
    try {
        await agent.start({ headless: true }); // Initialize client
    } catch (e) {
        console.warn('[Setup] Agent start failed partially, proceeding if client exists:', e.message);
    }

    // Mock the LLM Client to avoid API calls and auth errors
    agent.client = {
        models: {
            generateContent: async () => {
                console.log('[MockLLM] generateContent called. Returning mock pruning instruction.');
                return {
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    delete_keys: [STALE_KEY]
                                })
                            }]
                        }
                    }]
                };
            }
        }
    };
    agent.configService = { getModel: () => 'gemini-1.5-flash' };

    // 3. Run Prune
    console.log('[Action] Running Prune...');
    const service = new MemoryPruningService(agent);

    // We need to wait a bit for the LLM to process
    const result = await service.prune();
    console.log('[Result]', result);

    // 4. Verify
    const allFacts = db.getAllFacts();
    const staleExists = allFacts.find(f => f.key === STALE_KEY);
    const freshExists = allFacts.find(f => f.key === FRESH_KEY);
    const futureExists = allFacts.find(f => f.key === FUTURE_KEY);

    console.log('--- Verification ---');
    console.log(`Stale Key (${STALE_KEY}) Exists?`, !!staleExists);
    console.log(`Fresh Key (${FRESH_KEY}) Exists?`, !!freshExists);
    console.log(`Future Key (${FUTURE_KEY}) Exists?`, !!futureExists);

    if (!staleExists && freshExists) {
        console.log('SUCCESS: Pruning worked as expected.');
    } else {
        console.log('FAILURE: Pruning did not work as expected.');
    }

    process.exit(0);
}

run().catch(e => console.error(e));
