const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Setup tmp dir
const tmpDir = path.join(__dirname, 'tmp_db');

describe('AgentDB', () => {
  let db;

  beforeAll(() => {
    // Cleanup old run
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    db = new AgentDB(tmpDir);
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  test('should save and retrieve messages', () => {
    const msg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'hello',
      source: 'telegram',
      metadata: { chatId: '123' },
      timestamp: new Date().toISOString()
    };
    db.saveMessage(msg);

    const history = db.getHistory(1);
    expect(history[0].content).toBe('hello');
    expect(history[0].chat_id).toBe('123');
  });

  test('should save and retrieve KV pairs', () => {
    db.setKey('name', { first: 'Diego' });
    const val = db.getKey('name');
    expect(val).toEqual({ first: 'Diego' });
  });

  test('should manage goals', () => {
    const info = db.addGoal('Fix bugs');
    const goals = db.getPendingGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0].description).toBe('Fix bugs');

    db.completeGoal(info.lastInsertRowid);
    const pending = db.getPendingGoals();
    expect(pending).toHaveLength(0);
  });
});
