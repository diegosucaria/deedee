const crypto = require('crypto');

// Type definitions for internal messages
// In a real TS project this would be a .d.ts or .ts file, 
// but for JS/JSDoc compatibility we'll export constants and "shapes" via comments.

/**
 * @typedef {Object} Message
 * @property {string} id - Unique ID of the message
 * @property {string} content - Text content
 * @property {string} role - 'user' | 'assistant' | 'system'
 * @property {string} source - 'telegram' | 'slack' | 'system'
 * @property {string} userId - ID of the user who sent it
 * @property {Object} [metadata] - Extra platform-specific data
 */

/**
 * Creates a standard User Message
 * @param {string} content 
 * @param {string} source 
 * @param {string} userId 
 * @returns {Message}
 */
const createUserMessage = (content, source, userId) => ({
  id: crypto.randomUUID(),
  role: 'user',
  content,
  source,
  userId,
  timestamp: new Date().toISOString()
});

/**
 * Creates a standard Assistant Message
 * @param {string} content 
 * @returns {Message}
 */
const createAssistantMessage = (content) => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  source: 'system',
  userId: 'agent',
  timestamp: new Date().toISOString()
});

module.exports = {
  createUserMessage,
  createAssistantMessage
};
