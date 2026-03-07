/**
 * ToolScoper - Analyzes job prompts and determines which tool categories are needed.
 * Uses a lightweight FLASH model call to classify which tool categories a job requires.
 * Results are stored in the job payload as `allowedTools` for filtering at runtime.
 */

const { toolDefinitions } = require('../tools-definition');
const { ConfigService } = require('./config-service');

// Category descriptions for the LLM prompt
const CATEGORY_DESCRIPTIONS = {
    memory: 'Remember/recall facts, search history, journal logging, memory consolidation',
    goals: 'Add/complete/list goals and task tracking',
    scheduler: 'Schedule jobs, set reminders, manage job state between runs',
    filesystem: 'Read/write files, run shell commands, git operations',
    search: 'Google Search for web lookups, weather, news',
    generative: 'Generate images, text-to-speech audio responses',
    smarthome: 'Control smart home devices (lights, AC, etc.)',
    communication: 'Send WhatsApp messages, search contacts, read chat history, watchers',
    people: 'Manage people/contacts database (list, search, update)',
    vault: 'Life Vaults for document storage and knowledge management',
    rag: 'Semantic document search and ingestion',
    dj: 'DJ tools: vinyl management, track recommendations',
    slack: 'Slack: search, read history, send messages, monitored channels',
    subagent: 'Spawn sub-agents for parallel task execution',
    // MCP-based categories (external tools inferred by namespace)
    calendar_email: 'Google Workspace: Gmail, Calendar, Drive, Docs, Sheets',
    smarthome_mcp: 'Home Assistant MCP tools',
    media: 'Plex media server tools',
    browser: 'Browser automation tools',
    automation: 'Node-RED automation workflows'
};

// MCP namespace patterns → categories
const MCP_PATTERNS = [
    { pattern: /gws/i, category: 'calendar_email' },
    { pattern: /^homeassistant/i, category: 'smarthome_mcp', serverMatch: true },
    { pattern: /^plex/i, category: 'media', serverMatch: true },
    { pattern: /^browser/i, category: 'browser', serverMatch: true },
    { pattern: /^node-red/i, category: 'automation', serverMatch: true }
];

class ToolScoper {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.client = null;
        this.config = new ConfigService();
    }

    async _ensureClient() {
        if (!this.client) {
            const { GoogleGenAI } = await import('@google/genai');
            this.client = new GoogleGenAI({ apiKey: this.apiKey });
        }
    }

    /**
     * Build a map of internal tool names by category from toolDefinitions.
     */
    _getInternalToolsByCategory() {
        const map = {};
        for (const group of toolDefinitions) {
            for (const tool of (group.functionDeclarations || [])) {
                const cat = tool.category || 'uncategorized';
                if (!map[cat]) map[cat] = [];
                map[cat].push(tool.name);
            }
        }
        return map;
    }

    /**
     * Classify MCP (external) tools into categories by namespace/name patterns.
     */
    _classifyMcpTools(mcpTools) {
        const map = {};
        for (const tool of mcpTools) {
            let matched = false;
            for (const { pattern, category, serverMatch } of MCP_PATTERNS) {
                const target = serverMatch ? (tool.serverName || tool.name) : tool.name;
                if (pattern.test(target)) {
                    if (!map[category]) map[category] = [];
                    map[category].push(tool.name);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                // Uncategorized MCP tools go into a catchall
                if (!map['mcp_other']) map['mcp_other'] = [];
                map['mcp_other'].push(tool.name);
            }
        }
        return map;
    }

    /**
     * Analyze a job prompt and determine which tool categories are needed.
     * @param {string} taskPrompt - The job instruction text
     * @param {Array} mcpTools - Current MCP tools from mcp.getTools()
     * @returns {string[]|null} Array of tool names, or null on failure
     */
    async scope(taskPrompt, mcpTools = []) {
        await this._ensureClient();

        const internalByCategory = this._getInternalToolsByCategory();
        const mcpByCategory = this._classifyMcpTools(mcpTools);

        // Build category list for the prompt
        const allCategories = new Set([...Object.keys(internalByCategory), ...Object.keys(mcpByCategory)]);
        const categoryList = [...allCategories].map(cat => {
            const desc = CATEGORY_DESCRIPTIONS[cat] || cat;
            return `- ${cat}: ${desc}`;
        }).join('\n');

        const prompt = `You are a tool classifier. Given a scheduled job instruction, determine which tool categories the job will need.

Available categories:
${categoryList}

Job instruction:
"${taskPrompt.slice(0, 1500)}"

Return ONLY a JSON array of category name strings that this job needs. Include "scheduler" if the job is recurring (needs getJobState/saveJobState). Include "subagent" if the job mentions spawning agents or delegating tasks. Be inclusive — it's better to include an extra category than to miss one the job needs.

Example: ["slack", "calendar_email", "memory", "subagent", "scheduler"]`;

        try {
            const model = this.config.getModel('ROUTER'); // Use cheapest model
            const response = await this.client.models.generateContent({
                model,
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    temperature: 0
                }
            });

            const text = response.text?.trim() || response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!text) return null;

            const categories = JSON.parse(text);
            if (!Array.isArray(categories)) return null;

            // Resolve categories to tool names
            const toolNames = new Set();
            for (const cat of categories) {
                const internal = internalByCategory[cat];
                if (internal) internal.forEach(t => toolNames.add(t));
                const mcp = mcpByCategory[cat];
                if (mcp) mcp.forEach(t => toolNames.add(t));
            }

            // Always include uncategorized MCP tools (safety fallback)
            if (mcpByCategory['mcp_other']) {
                mcpByCategory['mcp_other'].forEach(t => toolNames.add(t));
            }

            return toolNames.size > 0 ? [...toolNames] : null;
        } catch (err) {
            console.error('[ToolScoper] Failed to scope tools:', err.message);
            return null; // Fallback: no filtering
        }
    }
}

module.exports = { ToolScoper };
