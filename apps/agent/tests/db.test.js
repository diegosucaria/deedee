const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Setup tmp dir
const tmpDir = path.join(__dirname, 'tmp_db');

describe('AgentDB', () => {
  let db;

  beforeEach(() => {
    // Cleanup old run
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    db = new AgentDB(tmpDir);
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    const history = db.getHistory({ limit: 1 });
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

  describe('Chat Sessions', () => {
    it('should create and retrieve a session', () => {
      const session = db.createSession({ id: 'test-session', title: 'Test Chat' });
      const retrieved = db.getSession('test-session');
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe('test-session');
      expect(retrieved.title).toBe('Test Chat');
    });

    it('should ensure valid session for valid source', () => {
      const s1 = db.ensureSession('web-uuid', 'web');
      expect(s1.title).toBe('New Chat');

      const s2 = db.ensureSession('12345', 'telegram');
      expect(s2.title).toBe('Telegram Chat');
    });

    it('should update session', () => {
      db.createSession({ id: 'update-test', title: 'Old' });
      db.updateSession('update-test', { title: 'New', isArchived: 1 });
      const s = db.getSession('update-test');
      expect(s.title).toBe('New');
      expect(s.is_archived).toBe(1);
    });

    it('should delete session and cascading messages', () => {
      db.createSession({ id: 'del-test', title: 'Del' });
      db.saveMessage({ role: 'user', content: 'hi', metadata: { chatId: 'del-test' } });

      const countBefore = db.countMessages('del-test');
      expect(countBefore).toBe(1);

      db.deleteSession('del-test');
      const s = db.getSession('del-test');
      expect(s).toBeUndefined();

      const countAfter = db.countMessages('del-test');
      expect(countAfter).toBe(0);
    });
  });
});
