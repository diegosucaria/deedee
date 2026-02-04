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
        await this.loadSkills();
        this.watchSkills();
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

                const files = await fs.readdir(dir);
                for (const file of files) {
                    if (file.endsWith('.md')) {
                        await this.loadSkill(path.join(dir, file));
                    }
                }
            } catch (err) {
                console.error(`[SkillService] Error loading skills from ${dir}:`, err);
            }
        }

        console.log(`[SkillService] Loaded ${this.skills.size} skills.`);
    }

    async loadSkill(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const skill = this._parseSkill(content, filePath);

            if (skill) {
                // Validation: Check for duplicates or collisions?
                // For now, Last Write Wins (User overrides Built-in if same name)
                this.skills.set(skill.name, skill);
                // console.log(`[SkillService] Loaded skill: ${skill.name}`);
            }
        } catch (err) {
            console.error(`[SkillService] Failed to parse ${filePath}:`, err);
        }
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
        const activeSkills = Array.from(this.skills.values())
            .filter(s => !s.disableModelInvocation);

        if (activeSkills.length === 0) return '';

        return activeSkills.map(skill => {
            // Replace {baseDir} if needed (future proofing)
            return `
### SKILL: ${skill.name}
${skill.description ? `> ${skill.description}` : ''}

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
        if (this.skills.has(cmd)) return this.skills.get(cmd);

        // 2. Alias Match
        for (const skill of this.skills.values()) {
            if (skill.aliases && skill.aliases.includes(cmd)) {
                return skill;
            }
        }
        return null;
    }

    getAllSkills() {
        return Array.from(this.skills.values());
    }
}

module.exports = { SkillService };
