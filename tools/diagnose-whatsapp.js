
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino'); // Baileys logger
const path = require('path');

async function startDiagnostic(session = 'user') {
    const dataDir = path.join(process.cwd(), 'data');
    const authDir = path.join(dataDir, `baileys_auth_${session}`);

    console.log(`[Diagnostic] Starting for session: ${session}`);
    console.log(`[Diagnostic] Auth Dir: ${authDir}`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[Diagnostic] Baileys Version: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'debug' }), // FULL DEBUG LOGS from Baileys internal
        printQRInTerminal: true,
        connectTimeoutMs: 60000,
        syncFullHistory: false, // Match current config
        markOnlineOnConnect: true, // TEST: Force Online to see if it wakes up
        browser: ['DeeDee Diagnostic', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) console.log('[Diagnostic] QR Code received');
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[Diagnostic] Connection closed. Reconnect: ${shouldReconnect}`, lastDisconnect.error);
            if (shouldReconnect) {
                setTimeout(() => startDiagnostic(session), 5000);
            }
        } else if (connection === 'open') {
            console.log('[Diagnostic] Connection OPEN! 🟢');

            // ACTIVE PROBE 1: Presence
            console.log('[Diagnostic] 🔍 PROBE 1: Sending Presence Update...');
            sock.sendPresenceUpdate('available')
                .then(() => console.log('[Diagnostic] ✅ PROBE 1: Presence Acknowledged'))
                .catch(e => console.error('[Diagnostic] ❌ PROBE 1 FAILED:', e));

            // ACTIVE PROBE 2: Fetch Blocklist (Simple IQ)
            console.log('[Diagnostic] 🔍 PROBE 2: Fetching Blocklist...');
            sock.fetchBlocklist()
                .then(list => console.log(`[Diagnostic] ✅ PROBE 2: Blocklist Fetched (${list.length} entries)`))
                .catch(e => console.error('[Diagnostic] ❌ PROBE 2 FAILED:', e));
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        console.log(`[Diagnostic] 📩 MESSAGES UPSERT (Type: ${type}) Count: ${messages.length}`);
        for (const m of messages) {
            console.log(`   - ID: ${m.key.id} From: ${m.key.remoteJid} TS: ${m.messageTimestamp}`);
        }
    });

    sock.ev.on('messaging-history.set', (data) => {
        const { contacts, messages, isLatest } = data;
        console.log(`[Diagnostic] 📚 HISTORY SYNC. Contacts: ${contacts?.length || 0}, Messages: ${messages?.length || 0}`);
    });

    console.log('[Diagnostic] Listening for events...');
}

// Run
const session = process.argv[2] || 'user';
startDiagnostic(session);
