const fs = require('fs-extra');
const path = require('path');

class SkillService {
    constructor(agent) {
        this.agent = agent;
        this.skills = new Map(); // name -> skill object
        this.skillDirs = [
            path.join(process.cwd(), 'apps', 'agent', 'skills'), // Built-in
            path.join(process.cwd(), 'data', 'skills')          // User-defined
        ];
    }

    async init() {
        console.log('[SkillService] Initializing...');
        await this.loadState();
        await this.loadSkills();
        this.watchSkills();
    }

    async loadState() {
        this.stateFile = path.join(process.cwd(), 'data', 'skills-state.json');
        try {
            if (await fs.pathExists(this.stateFile)) {
                this.state = await fs.readJson(this.stateFile);
            } else {
                this.state = {};
            }
        } catch (e) {
            console.error('[SkillService] Failed to load state:', e);
            this.state = {};
        }
    }

    async saveState() {
        try {
            await fs.writeJson(this.stateFile, this.state, { spaces: 2 });
        } catch (e) {
            console.error('[SkillService] Failed to save state:', e);
        }
    }

    getSkillState(name) {
        if (!this.state[name]) {
            this.state[name] = { enabled: true, secrets: {} };
        }
        return this.state[name];
    }

    async toggleSkill(name, enabled) {
        const s = this.getSkillState(name);
        s.enabled = enabled;
        await this.saveState();
        // Reload instructions cache logic handled in getGlobalInstructions dynamically
        return s;
    }

    async setSkillSecrets(name, secrets) {
        const s = this.getSkillState(name);
        s.secrets = { ...s.secrets, ...secrets };
        await this.saveState();
        return s;
    }

    watchSkills() {
        // Watch user directory for changes
        const userDir = this.skillDirs[1]; // data/skills
        if (fs.existsSync(userDir)) {
            console.log(`[SkillService] Watching ${userDir} for changes...`);
            fs.watch(userDir, (eventType, filename) => {
                if (filename && filename.endsWith('.md')) {
                    console.log(`[SkillService] Detected change in ${filename}, reloading skill...`);
                    // Debounce or just reload specific file? 
                    // For simplicity/robustness, just reload that file. 
                    // Note: delete events might need specific handling if we want to remove from map.
                    this.handleFileChange(userDir, filename);
                }
            });
        }
    }

    async handleFileChange(dir, filename) {
        const filePath = path.join(dir, filename);
        if (await fs.pathExists(filePath)) {
            await this.loadSkill(filePath);
        } else {
            // File deleted
            // We need to find the skill by filename and remove it.
            // Our map is by Name. We store filePath in skill object.
            for (const [name, skill] of this.skills.entries()) {
                if (skill.filePath === filePath) {
                    this.skills.delete(name);
                    console.log(`[SkillService] Removed skill: ${name}`);
                    break;
                }
            }
        }
    }

    async loadSkills() {
        this.skills.clear();

        for (const dir of this.skillDirs) {
            try {
                if (!await fs.pathExists(dir)) {
                    await fs.ensureDir(dir);
                    continue;
                }

                // Recursive Scan
                await this.scanDir(dir);

            } catch (err) {
                console.error(`[SkillService] Error loading skills from ${dir}:`, err);
            }
        }

        console.log(`[SkillService] Loaded ${this.skills.size} skills.`);
    }

    async scanDir(dir) {
        const items = await fs.readdir(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                // Check if directory contains SKILL.md
                const skillMd = path.join(fullPath, 'SKILL.md');
                if (await fs.pathExists(skillMd)) {
                    await this.loadSkill(skillMd);
                } else {
                    // Recurse? Or just support 1 level deep? 
                    // OpenClaw seems to be 1 level deep (skills/name/SKILL.md).
                    // Let's recurse to be safe/flexible.
                    await this.scanDir(fullPath);
                }
            } else if (item.endsWith('.md')) {
                // Root level .md file
                // Avoid loading SKILL.md if we already handled it via directory check?
                // Actually the directory check looks for specific file.
                // If we possess a recursive scan, we might double load if we not careful.
                if (item === 'SKILL.md') {
                    // Should have been handled by parent dir check, 
                    // OR we are in a subfolder loop.
                    await this.loadSkill(fullPath);
                } else {
                    // Classic flat file
                    await this.loadSkill(fullPath);
                }
            }
        }
    }

    async loadSkill(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const skill = this._parseSkill(content, filePath);

            if (skill) {
                // Validation: Check for duplicates or collisions?
                // For now, Last Write Wins (User overrides Built-in if same name)

                // Check Dependencies
                skill.missingDependencies = this.checkDependencies(skill);

                this.skills.set(skill.name, skill);
                // console.log(`[SkillService] Loaded skill: ${skill.name}`);
            }
        } catch (err) {
            console.error(`[SkillService] Failed to parse ${filePath}:`, err);
        }
    }

    checkDependencies(skill) {
        const missing = [];
        if (skill.metadata && skill.metadata.requires) {
            const reqs = skill.metadata.requires;

            // Check Config (Env Vars or Agent Config)
            if (reqs.config) {
                reqs.config.forEach(key => {
                    // Check env first
                    if (process.env[key]) return;
                    if (process.env[key.toUpperCase()]) return;

                    // Check Agent Config
                    // We assume agent.config is available or we check settings
                    // For now, simple ENV check is robust enough for "slack.token" etc.
                    missing.push(`Config: ${key}`);
                });
            }

            // Check Tools (MCP)
            if (reqs.tools) {
                // We'd need access to the tool registry. availableTools is usually on agent.
                // Assuming this.agent.tools is a Map or Object
                if (this.agent.tools) {
                    reqs.tools.forEach(tool => {
                        if (!this.agent.tools[tool]) missing.push(`Tool: ${tool}`);
                    });
                }
            }
        }
        return missing;
    }

    /**
     * Parses a SKILL.md file with YAML-style frontmatter.
     * Logic: Supports single-line keys only, generic "---" delimiter.
     */
    _parseSkill(fileContent, filePath) {
        const lines = fileContent.split('\n');
        const frontmatter = {};
        let bodyLines = [];
        let inFrontmatter = false;
        let fmStartFound = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Check for delimiter
            if (line === '---') {
                if (!fmStartFound) {
                    fmStartFound = true;
                    inFrontmatter = true;
                    continue;
                } else if (inFrontmatter) {
                    inFrontmatter = false;
                    // Remaining lines are body
                    bodyLines = lines.slice(i + 1);
                    break;
                }
            }

            if (inFrontmatter) {
                // Parse "key: value"
                const match = line.match(/^([a-zA-Z0-9-_]+):\s*(.*)$/);
                if (match) {
                    const key = match[1];
                    let value = match[2];

                    // Basic boolean/tool parsing
                    if (value === 'true') value = true;
                    if (value === 'false') value = false;

                    // JSON parsing for metadata
                    if (key === 'metadata' && value.startsWith('{')) {
                        try {
                            value = JSON.parse(value);
                        } catch (e) {
                            console.warn(`[SkillService] Failed to parse metadata JSON for ${filePath}`);
                        }
                    }

                    frontmatter[key] = value;
                }
            }
        }

        // Parse Aliases
        if (frontmatter['command-alias']) {
            const aliasVal = frontmatter['command-alias'];
            // Handle array "['a', 'b']" or string "a"
            // Simple parsing: if starts with [, strip brackets and split.
            let aliases = [];
            if (aliasVal.startsWith('[')) {
                aliases = aliasVal.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
            } else {
                aliases = [aliasVal.trim()];
            }
            frontmatter.aliases = aliases;
        }

        if (!frontmatter.name) {
            console.warn(`[SkillService] Skipping ${filePath}: Missing 'name' in frontmatter.`);
            return null;
        }

        return {
            ...frontmatter,
            aliases: frontmatter.aliases || [],
            instructions: bodyLines.join('\n').trim(),
            filePath,
            // Defaults
            userInvocable: frontmatter['user-invocable'] !== false, // Default true
            disableModelInvocation: frontmatter['disable-model-invocation'] === true // Default false
        };
    }

    /**
     * Returns the formatted prompt string to inject into the System Prompt.
     */
    getGlobalInstructions() {
        // Enforce Enable/Disable State
        const activeSkills = Array.from(this.skills.values())
            .filter(s => {
                if (s.disableModelInvocation) return false;
                const state = this.getSkillState(s.name);
                if (!state.enabled) return false;
                if (s.missingDependencies && s.missingDependencies.length > 0) return false;
                return true;
            });

        if (activeSkills.length === 0) return '';

        return activeSkills.map(skill => {
            // Replace {baseDir} if needed (future proofing)
            return `
### SKILL: ${skill.name}
${skill.description ? `> ${skill.description}` : ''}
${skill.metadata && skill.metadata.emoji ? `Emoji: ${skill.metadata.emoji}` : ''}

${skill.instructions}
--------------------------------------------------
`;
        }).join('\n');
    }

    getSkill(name) {
        return this.skills.get(name);
    }

    getSkillByCommand(cmd) {
        // 1. Direct Name Match
        if (this.skills.has(cmd)) {
            const s = this.skills.get(cmd);
            const state = this.getSkillState(s.name);
            if (state.enabled) return s;
        }

        // 2. Alias Match
        for (const skill of this.skills.values()) {
            if (skill.aliases && skill.aliases.includes(cmd)) {
                const state = this.getSkillState(skill.name);
                if (state.enabled) return skill;
            }
        }
        return null;
    }

    getAllSkills() {
        return Array.from(this.skills.values()).map(s => {
            const state = this.getSkillState(s.name);
            return {
                ...s,
                enabled: state.enabled,
                secrets: Object.keys(state.secrets || {}), // Don't expose values
                missingDependencies: s.missingDependencies
            };
        });
    }
}

module.exports = { SkillService };
