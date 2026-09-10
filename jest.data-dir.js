// Give each test file its own empty data directory.
//
// Without this, anything that builds an AgentDB with no explicit path (the
// Agent constructor does, for its rate limiter) opens the repo's ./data/agent.db.
// Every test run then logs usage there, and after 50 runs in an hour the rate
// limiter short-circuits processMessage and unrelated tests fail — including
// under the pre-push hook.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATA_DIR) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-jest-'));
    process.env.DATA_DIR = dir;
    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.DATA_DIR;
    });
}
