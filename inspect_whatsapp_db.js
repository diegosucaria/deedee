
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Find the database file
const dataDir = path.join(process.cwd(), 'data');
const dbFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('messages_') && f.endsWith('.db'));

if (dbFiles.length === 0) {
    console.error("No WhatsApp Database found in ./data");
    process.exit(1);
}

const dbPath = path.join(dataDir, dbFiles[0]); // Pick first found
console.log(`Inspecting Database: ${dbPath}`);

const db = new Database(dbPath, { readonly: true });

// 1. Get Count
const count = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
console.log(`Total Messages: ${count}`);

// 2. Get Last 5 Messages
const rows = db.prepare(`
    SELECT remote_jid, from_me, timestamp, content, data 
    FROM messages 
    ORDER BY timestamp DESC 
    LIMIT 5
`).all();

console.log("\n--- Latest 5 Messages ---");
rows.forEach(r => {
    const date = new Date(r.timestamp * 1000).toLocaleString();
    const snippet = r.content ? r.content.substring(0, 50) : '[No Content]';
    console.log(`[${date}] (${r.from_me ? 'Me' : 'Them'}) ${r.remote_jid}: ${snippet}`);
});

console.log("\n-------------------------");
