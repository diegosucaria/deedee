
const fs = require('fs');
const path = require('path');

const session = process.argv[2];
if (!session || (session !== 'user' && session !== 'assistant')) {
    console.error("Usage: node tools/reset-whatsapp.js <user|assistant>");
    process.exit(1);
}

const dataDir = path.join(process.cwd(), 'data');
const authDir = path.join(dataDir, `baileys_auth_${session}`);
const dbFile = path.join(dataDir, `messages_${session}.db`);

console.log(`[Reset] Resetting session '${session}'...`);

// 1. Delete DB
if (fs.existsSync(dbFile)) {
    try {
        fs.unlinkSync(dbFile);
        console.log(`✅ Deleted DB: ${dbFile}`);
    } catch (e) {
        console.error(`❌ Failed to delete DB: ${e.message}`);
    }
} else {
    console.log(`ℹ️ DB not found: ${dbFile}`);
}

// 2. Delete Auth
if (fs.existsSync(authDir)) {
    try {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`✅ Deleted Auth: ${authDir}`);
    } catch (e) {
        console.error(`❌ Failed to delete Auth: ${e.message}`);
    }
} else {
    console.log(`ℹ️ Auth not found: ${authDir}`);
}

console.log("\n[Reset] Complete. Please restart the application and Re-Scan QR code.");
