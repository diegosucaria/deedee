const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// Paths (Mirrors Agent Config)
const SKILL_DIRS = {
    builtin: path.join(process.cwd(), 'apps', 'agent', 'skills'),
    user: path.join(process.cwd(), 'data', 'skills')
};

// Helper: Parse Frontmatter (Duplicated from Agent SkillService for now)
function parseSkill(content, fileName, type) {
    const lines = content.split('\n');
    const frontmatter = {};
    let body = '';
    let inFM = false;
    let fmStart = false;
    let bodyStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '---') {
            if (!fmStart) {
                fmStart = true;
                inFM = true;
                continue;
            } else if (inFM) {
                inFM = false;
                bodyStartLine = i + 1;
                break;
            }
        }
        if (inFM) {
            const match = line.match(/^([a-zA-Z0-9-_]+):\s*(.*)$/);
            if (match) frontmatter[match[1]] = match[2];
        }
    }

    // Parse values
    Object.keys(frontmatter).forEach(k => {
        if (frontmatter[k] === 'true') frontmatter[k] = true;
        if (frontmatter[k] === 'false') frontmatter[k] = false;
    });

    return {
        name: frontmatter.name || fileName.replace('.md', ''),
        description: frontmatter.description || '',
        userInvocable: frontmatter['user-invocable'] !== false,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        type, // 'builtin' or 'user'
        fileName,
        content // Full raw content
    };
}

// GET /v1/skills - List all skills
router.get('/', async (req, res) => {
    try {
        const skills = [];
        const stateFile = path.join(process.cwd(), 'data', 'skills-state.json');
        let state = {};

        // Load State
        if (await fs.pathExists(stateFile)) {
            try {
                state = await fs.readJson(stateFile);
            } catch (e) {
                console.warn('Failed to load skills-state.json', e);
            }
        }

        // 1. Scan Built-in
        if (await fs.pathExists(SKILL_DIRS.builtin)) {
            const files = await fs.readdir(SKILL_DIRS.builtin);
            for (const f of files) {
                if (f.endsWith('.md')) {
                    const content = await fs.readFile(path.join(SKILL_DIRS.builtin, f), 'utf8');
                    skills.push(parseSkillWithState(content, f, 'builtin', state));
                }
            }
        }

        // 2. Scan User (data/skills)
        if (await fs.pathExists(SKILL_DIRS.user)) {
            const files = await fs.readdir(SKILL_DIRS.user);
            for (const f of files) {
                if (f.endsWith('.md')) {
                    const content = await fs.readFile(path.join(SKILL_DIRS.user, f), 'utf8');
                    // Override builtin if same name? 
                    // Client can handle dedupe or we do it here.
                    // For now, push all and let client decide (or filter by name map)
                    skills.push(parseSkillWithState(content, f, 'user', state));
                }
            }
        }

        res.json(skills);
    } catch (e) {
        console.error('List Skills Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Helper to merge state
function parseSkillWithState(content, filename, type, state) {
    const skill = parseSkill(content, filename, type);
    const sState = state[skill.name] || {};

    // Basic Dependency Check (Env Vars only, since we can't check Tools from API)
    const missingDependencies = [];
    if (skill.metadata && skill.metadata.requires && skill.metadata.requires.config) {
        skill.metadata.requires.config.forEach(key => {
            if (!process.env[key] && !process.env[key.toUpperCase()]) {
                missingDependencies.push(`Config: ${key}`);
            }
        });
    }

    return {
        ...skill,
        enabled: sState.enabled !== false, // Default true if not in state
        secrets: Object.keys(sState.secrets || {}),
        missingDependencies
    };
}

// GET /v1/skills/:filename
router.get('/:filename', async (req, res) => {
    try {
        const f = req.params.filename;
        let p = path.join(SKILL_DIRS.user, f);
        let type = 'user';

        if (!await fs.pathExists(p)) {
            p = path.join(SKILL_DIRS.builtin, f);
            type = 'builtin';
            if (!await fs.pathExists(p)) {
                return res.status(404).json({ error: 'Skill not found' });
            }
        }

        const content = await fs.readFile(p, 'utf8');
        const stateFile = path.join(process.cwd(), 'data', 'skills-state.json');
        let state = {};
        if (await fs.pathExists(stateFile)) state = await fs.readJson(stateFile);

        res.json({ ...parseSkillWithState(content, f, type, state), raw: content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills - Create/Update (Keep as is, but ensure state is preserved/init)
router.post('/', async (req, res) => {
    try {
        const { filename, content } = req.body;
        if (!content) return res.status(400).json({ error: 'Content required' });

        await fs.ensureDir(SKILL_DIRS.user);

        let targetFile = filename;
        if (!targetFile) {
            const meta = parseSkill(content, 'temp', 'user');
            if (meta.name) targetFile = `${meta.name}.md`;
            else targetFile = `skill_${Date.now()}.md`;
        }
        if (!targetFile.endsWith('.md')) targetFile += '.md';

        const safeName = path.basename(targetFile);
        if (safeName !== targetFile && targetFile.includes(path.sep)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const filePath = path.join(SKILL_DIRS.user, safeName);
        await fs.writeFile(filePath, content);
        res.json({ success: true, filename: safeName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Shared State Helper
async function updateSkillState(name, updateFn) {
    const stateFile = path.join(process.cwd(), 'data', 'skills-state.json');
    let state = {};
    try {
        if (await fs.pathExists(stateFile)) state = await fs.readJson(stateFile);
    } catch (e) { }

    if (!state[name]) state[name] = { enabled: true, secrets: {} };

    updateFn(state[name]);

    await fs.writeJson(stateFile, state, { spaces: 2 });
}

// POST /v1/skills/:name/enable
router.post('/:name/enable', async (req, res) => {
    try {
        await updateSkillState(req.params.name, (s) => s.enabled = true);
        res.json({ success: true, enabled: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills/:name/disable
router.post('/:name/disable', async (req, res) => {
    try {
        await updateSkillState(req.params.name, (s) => s.enabled = false);
        res.json({ success: true, enabled: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills/:name/secrets
router.post('/:name/secrets', async (req, res) => {
    try {
        const { secrets } = req.body;
        await updateSkillState(req.params.name, (s) => {
            s.secrets = { ...s.secrets, ...secrets };
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /v1/skills/:filename
router.delete('/:filename', async (req, res) => {
    try {
        const f = req.params.filename;
        // Sanitize
        if (f.includes('..') || f.includes('/') || f.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const p = path.join(SKILL_DIRS.user, f);

        if (await fs.pathExists(p)) {
            await fs.remove(p);
            res.json({ success: true });
        } else {
            // Check if it's builtin
            const builtinPath = path.join(SKILL_DIRS.builtin, f);
            if (await fs.pathExists(builtinPath)) {
                return res.status(403).json({ error: 'Cannot delete built-in skills. Try disabling it instead.' });
            }
            res.status(404).json({ error: 'Skill not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
