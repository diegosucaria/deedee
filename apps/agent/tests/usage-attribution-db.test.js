/**
 * Cost breakdown with main-path usage tags: chat, job, subagent and watcher
 * rows (and their _tool_loop forms) must classify by chat_id, as untagged rows
 * did before the attribution change, so the WhatsApp / Web Chat / Jobs split
 * on the stats page survives.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB, MAIN_PATH_TAGS } = require('../src/db');

describe('cost breakdown with main-path tags', () => {
  let db, tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-attr-db-'));
    db = new AgentDB(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const log = (tag, chatId, cost = 1) => db.logTokenUsage({
    model: 'm', promptTokens: 10, candidateTokens: 1, totalTokens: 11, chatId, estimatedCost: cost, tag
  });

  test('MAIN_PATH_TAGS lists the four bases and their tool-loop forms', () => {
    expect(MAIN_PATH_TAGS).toEqual([
      'chat', 'chat_tool_loop', 'job', 'job_tool_loop',
      'subagent', 'subagent_tool_loop', 'watcher', 'watcher_tool_loop'
    ]);
  });

  test('getCostByTag classifies main-path tags by chat_id', () => {
    log(null, '123@s.us', 0.5);              // pre-change row
    log('chat', '123@s.us');
    log('chat_tool_loop', '123@g.us');
    log('watcher', '123@s.us');
    log('chat', 'web-abc');
    log('chat_tool_loop', 'web-abc');
    log('job', 'scheduled_daily');
    log('job_tool_loop', 'system_nightly');
    log('subagent', 'subagent-1');
    log('subagent_tool_loop', 'subagent-1');
    log('tts', '123@s.us', 2);              // call-site tag keeps its own category

    const { categories, total } = db.getCostByTag(null, null, 1);
    expect(categories.WhatsApp).toEqual({ cost: 3.5, tokens: 44, calls: 4 });
    expect(categories['Web Chat']).toEqual({ cost: 2, tokens: 22, calls: 2 });
    expect(categories.Jobs).toEqual({ cost: 2, tokens: 22, calls: 2 });
    expect(categories['Sub-agents']).toEqual({ cost: 2, tokens: 22, calls: 2 });
    expect(categories.Speech).toEqual({ cost: 2, tokens: 11, calls: 1 });
    expect(categories.Other).toBeUndefined();
    expect(total.calls).toBe(11);
  });

  test('getDailyCostByCategory classifies main-path tags by chat_id', () => {
    log('chat', '123@s.us');
    log('job_tool_loop', 'scheduled_daily', 3);
    log('mystery_tag', 'web-abc', 7);

    const [day] = db.getDailyCostByCategory(null, null, 90);
    expect(day.WhatsApp).toBe(1);
    expect(day.Jobs).toBe(3);
    expect(day.Other).toBe(7);
    expect(day['Web Chat']).toBeUndefined();
  });
});
