const crypto = require('crypto');

class NotificationService {
  /**
   * @param {import('../db').AgentDB} db
   * @param {import('../http-interface').HttpInterface} httpInterface
   */
  constructor(db, httpInterface) {
    this.db = db;
    this.interface = httpInterface;
  }

  /**
   * Create a notification, persist it, and broadcast via Socket.io.
   * @param {{ type: string, severity?: 'info'|'warning'|'error', title: string, message: string, metadata?: object }} opts
   * @returns {object} The created notification
   */
  create({ type, severity = 'warning', title, message, metadata = {} }) {
    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    try {
      this.db.createNotification({ id, type, severity, title, message, metadata });
    } catch (e) {
      console.error('[Notifications] Failed to persist notification:', e.message);
      return null;
    }

    const notification = { id, type, severity, title, message, metadata, is_read: false, is_dismissed: false, created_at };

    // Broadcast to all connected web clients (fire-and-forget)
    if (this.interface?.broadcast) {
      this.interface.broadcast('notification:new', notification).catch(() => {});
    }

    return notification;
  }
}

module.exports = { NotificationService };
