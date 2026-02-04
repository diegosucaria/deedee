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

        // 1. Scan Built-in
        if (await fs.pathExists(SKILL_DIRS.builtin)) {
            const files = await fs.readdir(SKILL_DIRS.builtin);
            for (const f of files) {
                if (f.endsWith('.md')) {
                    const content = await fs.readFile(path.join(SKILL_DIRS.builtin, f), 'utf8');
                    skills.push(parseSkill(content, f, 'builtin'));
                }
            }
        }

        // 2. Scan User (data/skills)
        if (await fs.pathExists(SKILL_DIRS.user)) {
            const files = await fs.readdir(SKILL_DIRS.user);
            for (const f of files) {
                if (f.endsWith('.md')) {
                    const content = await fs.readFile(path.join(SKILL_DIRS.user, f), 'utf8');
                    // Override builtin if same name? Agent logic uses Map set(), so yes.
                    // We pushed to array so logic is different here. 
                    // Let's filter duplicates by name in client or here.
                    skills.push(parseSkill(content, f, 'user'));
                }
            }
        }

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
        res.json({ ...parseSkill(content, f, type), raw: content });
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
        res.json({ success: true, filename: safeName });
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
                return res.status(403).json({ error: 'Cannot delete built-in skills' });
            }
            res.status(404).json({ error: 'Skill not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
