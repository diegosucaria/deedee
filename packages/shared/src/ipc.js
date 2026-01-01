const axios = require('axios'); // We need to add axios to shared dependencies

class SupervisorClient {
  /**
   * @param {string} baseUrl - e.g., 'http://supervisor:4000'
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  /**
   * Requests the Supervisor to commit and push changes.
   * @param {string} message - Commit message
   * @param {string[]} [files=['.']] - Files to stage
   * @returns {Promise<Object>}
   */
  async commitAndPush(message, files = ['.']) {
    try {
      const response = await axios.post(`${this.baseUrl}/cmd/commit`, {
        message,
        files
      });
      return response.data;
    } catch (error) {
      console.error('IPC Error (commitAndPush):', error.message);
      throw error;
    }
  }

  /**
   * Simple health check
   */
  async health() {
    const response = await axios.get(`${this.baseUrl}/health`);
    return response.data;
  }
}

module.exports = { SupervisorClient };
