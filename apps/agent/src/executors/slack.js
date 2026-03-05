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
                const { query, limit, workspace } = args;
                console.log(`[SlackExecutor] Searching Slack for "${query}" (workspace: ${workspace || 'all'})`);

                try {
                    const res = await axios.get(`${interfacesUrl}/slack/search`, {
                        params: { query: encodeURIComponent(query), limit: limit || 10, teamId: workspace },
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
                const { channel, limit, days_back, workspace } = args;
                console.log(`[SlackExecutor] Reading Slack history for ${channel} (days_back: ${days_back || 2}, workspace: ${workspace || 'auto'})`);

                try {
                    const res = await axios.get(`${interfacesUrl}/slack/history`, {
                        params: {
                            channel: encodeURIComponent(channel),
                            limit: limit || 20,
                            days_back: days_back || 2,
                            teamId: workspace
                        },
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
                const { channel, text, thread_ts, workspace } = args;
                console.log(`[SlackExecutor] Sending Slack message to ${channel} (workspace: ${workspace || 'auto'})`);

                try {
                    const res = await axios.post(`${interfacesUrl}/send`, {
                        source: 'slack',
                        content: text,
                        metadata: { chatId: channel, thread_ts, teamId: workspace },
                    }, { headers });

                    return { success: true, info: `Message sent to ${channel}` };
                } catch (err) {
                    return {
                        success: false,
                        error: err.response?.data?.error || err.message,
                    };
                }
            }

            case 'getSlackMonitoredChannels': {
                console.log('[SlackExecutor] Getting monitored channels from Interfaces API');
                try {
                    // 1. Get all connected workspaces
                    const statusRes = await axios.get(`${interfacesUrl}/slack/status`, { headers });
                    const connections = statusRes.data.connections || [];

                    let allMonitored = [];

                    // 2. Fetch monitored channels for each workspace
                    for (const conn of connections) {
                        if (!conn.connected) continue;

                        const wsRes = await axios.get(`${interfacesUrl}/slack/monitored-channels`, {
                            params: { teamId: conn.teamId },
                            headers
                        });

                        const channels = wsRes.data || [];
                        // Annotate with workspace ID so LLM knows how to query readSlackHistory
                        const annotated = channels.map(ch => ({
                            ...ch,
                            workspace: conn.teamId,
                            workspaceName: conn.teamName
                        }));
                        allMonitored = allMonitored.concat(annotated);
                    }

                    return {
                        success: true,
                        channels: allMonitored,
                        count: allMonitored.length,
                        hint: allMonitored.length === 0
                            ? 'No monitored channels configured. The user should set them in Settings > Slack.'
                            : `Use 'readSlackHistory' on these ${allMonitored.length} channels (passing the specific 'workspace' ID) to extract tasks or summaries. DO NOT use searchSlack.`,
                    };
                } catch (err) {
                    return { success: false, error: err.response?.data?.error || err.message };
                }
            }

            case 'readAllMonitoredSlackHistory': {
                const { days_back } = args;
                console.log(`[SlackExecutor] Reading ALL monitored Slack history (days_back: ${days_back || 1})`);

                try {
                    const res = await axios.get(`${interfacesUrl}/slack/history/monitored`, {
                        params: { days_back: days_back || 1 },
                        headers,
                    });
                    return {
                        success: true,
                        text: res.data.text,
                        size_chars: res.data.text?.length || 0,
                    };
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
