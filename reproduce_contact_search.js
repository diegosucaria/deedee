
const { AgentDB } = require('./apps/agent/src/db');
const fs = require('fs');

async function test() {
    // Setup temporary DB
    const dbPath = './test_contact_search.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new AgentDB({ path: dbPath });

    // Seed Data
    db.createPerson({ name: 'Diego', phone: '1234567890' });
    db.createPerson({ name: 'Mom', phone: '0987654321' });

    console.log("--- Seeding Complete ---");
    console.log("DB: Diego, Mom");

    // Test Cases
    const queries = [
        'Diego',            // Should match
        'Diego Sucaria',    // Should match? (Currently likely FAIL)
        'My Mom',           // Should match? (Currently likely FAIL)
        'Mommy'             // Should match? (Currently likely FAIL)
    ];

    for (const q of queries) {
        const results = db.searchPeople(q);
        console.log(`Query: "${q}" -> Matches: ${results.length} (${results.map(r => r.name).join(', ')})`);
    }

    // Cleanup
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

test();
