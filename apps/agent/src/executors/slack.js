/**
 * SlackExecutor - Agent tools for Slack integration.
 * 
 * Provides searchSlack, readSlackHistory, sendSlackMessage.
 * Routes through the Interfaces service (/slack/* and /send endpoints).
 */

const { BaseExecutor } = require('./base');
const axios = require('axios');

class SlackExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
        const token = process.env.DEEDEE_API_TOKEN;

        const headers = { Authorization: `Bearer ${token}` };

        switch (name) {
            case 'searchSlack': {
                const { query, limit } = args;
                console.log(`[SlackExecutor] Searching Slack for "${query}"`);

                try {
                    const res = await axios.get(`${interfacesUrl}/slack/search`, {
                        params: { query: encodeURIComponent(query), limit: limit || 10 },
                        headers,
                    });
                    return {
                        success: true,
                        results: res.data.results,
                        count: res.data.results?.length || 0,
                    };
                } catch (err) {
                    return {
                        success: false,
                        error: err.response?.data?.error || err.message,
                    };
                }
            }

            case 'readSlackHistory': {
                const { channel, limit } = args;
                console.log(`[SlackExecutor] Reading Slack history for ${channel}`);

                try {
                    const res = await axios.get(`${interfacesUrl}/slack/history`, {
                        params: { channel: encodeURIComponent(channel), limit: limit || 20 },
                        headers,
                    });
                    return {
                        success: true,
                        messages: res.data.messages,
                        count: res.data.messages?.length || 0,
                    };
                } catch (err) {
                    return {
                        success: false,
                        error: err.response?.data?.error || err.message,
                    };
                }
            }

            case 'sendSlackMessage': {
                const { channel, text, thread_ts } = args;
                console.log(`[SlackExecutor] Sending Slack message to ${channel}`);

                try {
                    const res = await axios.post(`${interfacesUrl}/send`, {
                        source: 'slack',
                        content: text,
                        metadata: { chatId: channel, thread_ts },
                    }, { headers });

                    return { success: true, info: `Message sent to ${channel}` };
                } catch (err) {
                    return {
                        success: false,
                        error: err.response?.data?.error || err.message,
                    };
                }
            }

            default:
                return null; // Not our tool
        }
    }
}

module.exports = { SlackExecutor };
