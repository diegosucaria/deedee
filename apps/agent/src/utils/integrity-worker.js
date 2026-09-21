/**
 * PRAGMA quick_check reads every page of the database file: over a second on
 * the device. Run here, on its own read-only connection in a worker thread, it
 * never blocks the agent. WAL mode lets this reader run beside the agent's
 * writes. Started by AgentDB.scanIntegrity().
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

try {
    const db = new Database(workerData.file, { readonly: true, fileMustExist: true });
    let rows;
    try {
        rows = db.pragma('quick_check');
    } finally {
        db.close();
    }
    parentPort.postMessage({ rows: rows.slice(0, 10).map(r => r.quick_check) });
} catch (err) {
    // A badly damaged file makes quick_check throw (SQLITE_CORRUPT,
    // SQLITE_NOTADB) where a lightly damaged one returns rows. The code tells
    // AgentDB which it was.
    parentPort.postMessage({ error: err.message, code: err.code || null });
}
