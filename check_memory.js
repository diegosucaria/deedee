const Database = require('better-sqlite3');
const db = new Database('/app/data/agent.db');

try {
  console.log('--- HECHOS GUARDADOS (KV STORE) ---');
  const facts = db.prepare('SELECT * FROM kv_store').all();
  if (facts.length === 0) {
    console.log('No tengo hechos guardados.');
  } else {
    facts.forEach(f => console.log(`${f.key}: ${f.value}`));
  }

  console.log('\n--- ÚLTIMOS MENSAJES ---');
  const msgs = db.prepare('SELECT role, content FROM messages ORDER BY timestamp DESC LIMIT 5').all();
  if (msgs.length === 0) {
    console.log('No hay mensajes previos.');
  } else {
    msgs.reverse().forEach(m => console.log(`[${m.role}]: ${m.content.substring(0, 100)}...`));
  }
} catch (error) {
  console.error('Error leyendo DB:', error);
}
