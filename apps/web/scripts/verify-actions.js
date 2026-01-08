const fs = require('fs');
const path = require('path');

const ACTIONS_FILE = path.join(__dirname, '../src/app/actions.js');
const LIVE_ACTIONS_FILE = path.join(__dirname, '../src/app/live/actions.js');

const REQUIRED_ACTIONS = [
    // Core
    'createSession',
    'getSessions',
    'getSession',
    'getUserLocation',
    // Tasks
    'getTasks',
    'runTask',
    // Helpers
    'runTask',
    // Helpers
    'getEnvConfig',
    // Settings
    'getVoiceSettings',
    'saveVoiceSettings'
];

const REQUIRED_LIVE_ACTIONS = [
    'getLiveToken',
    'executeLiveTool',
    'getLiveConfig'
];

function checkFile(filePath, requiredExports) {
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const missing = [];

    requiredExports.forEach(funcName => {
        // Regex to match "export async function funcName" or "export const funcName"
        const regex = new RegExp(`export\\s+(async\\s+)?function\\s+${funcName}\\b|export\\s+const\\s+${funcName}\\b`);
        if (!regex.test(content)) {
            missing.push(funcName);
        }
    });

    if (missing.length > 0) {
        console.error(`❌ Missing exports in ${path.basename(filePath)}:`);
        missing.forEach(m => console.error(`   - ${m}`));
        return false;
    }

    console.log(`✅ ${path.basename(filePath)} passed (${requiredExports.length} checks)`);
    return true;
}

console.log('🔍 Verifying Server Actions...');

let success = true;
success = checkFile(ACTIONS_FILE, REQUIRED_ACTIONS) && success;
success = checkFile(LIVE_ACTIONS_FILE, REQUIRED_LIVE_ACTIONS) && success;

if (!success) {
    console.error('❌ Verification Failed');
    process.exit(1);
}

console.log('✨ All Actions Verified');
