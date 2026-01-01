const EventEmitter = require('events');

class MockInterface extends EventEmitter {
  constructor() {
    super();
    this.sentMessages = [];
  }
  receive(message) { this.emit('message', message); }
  async send(message) { this.sentMessages.push(message); return true; }
  getLastMessage() { return this.sentMessages[this.sentMessages.length - 1]; }
}

module.exports = { MockInterface };
