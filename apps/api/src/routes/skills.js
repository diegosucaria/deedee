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

// GET /v1/skills - List all skills (Consolidated via Agent Service)
router.get('/', async (req, res) => {
    try {
        if (!req.agent || !req.agent.skillService) {
            return res.status(503).json({ error: 'Agent SkillService not available' });
        }
        const skills = req.agent.skillService.getAllSkills();
        res.json(skills);
    } catch (e) {
        console.error('List Skills Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /v1/skills/:filename
router.get('/:filename', async (req, res) => {
    try {
        const f = req.params.filename;
        const skills = req.agent.skillService.getAllSkills();
        // Since getAllSkills returns object with metadata, we search by fileName or name
        const match = skills.find(s => s.fileName === f || s.name === f.replace('.md', ''));

        if (match) {
            // Re-read file just to be safe/fresh? Or rely on match?
            // match.content is available
            res.json(match);
        } else {
            res.status(404).json({ error: 'Skill not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills - Create/Update
router.post('/', async (req, res) => {
    try {
        const { filename, content } = req.body;
        if (!content) return res.status(400).json({ error: 'Content required' });

        // Ensure dir exists
        await fs.ensureDir(SKILL_DIRS.user);

        // Determine filename
        let targetFile = filename;
        if (!targetFile) {
            // Extract name from content?
            // We use the helper locally just for name extraction before file write
            const meta = parseSkill(content, 'temp', 'user');
            if (meta.name) targetFile = `${meta.name}.md`;
            else targetFile = `skill_${Date.now()}.md`;
        }
        if (!targetFile.endsWith('.md')) targetFile += '.md';

        // Sanitize filename - STRICT
        const safeName = path.basename(targetFile);
        if (safeName !== targetFile && targetFile.includes(path.sep)) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const filePath = path.join(SKILL_DIRS.user, safeName);
        await fs.writeFile(filePath, content);

        // Trigger explicit reload in service might be needed if fs.watch is slow?
        // Service watches, so it should pick it up.

        res.json({ success: true, filename: safeName });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills/:name/enable
router.post('/:name/enable', async (req, res) => {
    try {
        const { name } = req.params;
        await req.agent.skillService.toggleSkill(name, true);
        res.json({ success: true, enabled: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills/:name/disable
router.post('/:name/disable', async (req, res) => {
    try {
        const { name } = req.params;
        await req.agent.skillService.toggleSkill(name, false);
        res.json({ success: true, enabled: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /v1/skills/:name/secrets
router.post('/:name/secrets', async (req, res) => {
    try {
        const { name } = req.params;
        const { secrets } = req.body; // Expects object { KEY: "value" }
        await req.agent.skillService.setSkillSecrets(name, secrets);
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
