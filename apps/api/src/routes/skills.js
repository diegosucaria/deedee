const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

// Paths (Mirrors Agent Config)
const getRootDir = () => {
    const cwd = process.cwd();
    if (cwd.endsWith(path.join('apps', 'agent')) || cwd.endsWith(path.join('apps', 'api'))) {
        return path.resolve(cwd, '..', '..');
    }
    return cwd;
};

const ROOT_DIR = getRootDir();

const SKILL_DIRS = {
    builtin: path.join(ROOT_DIR, 'apps', 'agent', 'skills'),
    user: path.join(ROOT_DIR, 'data', 'skills')
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

// Helper to scan directory recursively
async function scanSkillsDir(dir) {
    let results = [];
    if (!await fs.pathExists(dir)) return results;

    const items = await fs.readdir(dir);
    for (const item of items) {
        if (item.startsWith('.')) continue; // Skip hidden

        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            // Check for SKILL.md inside
            const skillMd = path.join(fullPath, 'SKILL.md');
            if (await fs.pathExists(skillMd)) {
                results.push({
                    path: skillMd,
                    filename: item, // Use dirname as "filename" for list view if preferred? Or maintain path?
                    // We'll use relative path from base dir as unique IDish thing
                    relPath: path.relative(dir, skillMd)
                });
            } else {
                // Recurse
                // (Note: This simple recursion assumes skills aren't nested inside other skills)
                const subResults = await scanSkillsDir(fullPath);
                // Adjust relative paths to be relative to the original root? 
                // Currently scanSkillsDir function is creating a new context.
                // Better approach: just return list of absolute paths.
                results = results.concat(subResults);
            }
        } else if (item.endsWith('.md')) {
            // Flat file
            results.push({ path: fullPath, relPath: item });
        }
    }
    return results;
}

// GET /v1/skills - List all skills
router.get('/', async (req, res) => {
    try {
        const skills = [];
        const stateFile = path.join(ROOT_DIR, 'data', 'skills-state.json');
        let state = {};

        // Load State
        if (await fs.pathExists(stateFile)) {
            try {
                state = await fs.readJson(stateFile);
            } catch (e) {
                console.warn('Failed to load skills-state.json', e);
            }
        }

        // Helper to process a list of file paths
        const processFiles = async (fileList, type, baseDir) => {
            for (const f of fileList) {
                // Determine display filename (handle subfolders)
                // If it's a folder-skill (e.g. weather/SKILL.md), use "weather" as the logical name/filename
                let displayFilename = path.basename(f.path);
                if (displayFilename === 'SKILL.md') {
                    displayFilename = path.basename(path.dirname(f.path)); // "weather"
                }

                const content = await fs.readFile(f.path, 'utf8');
                // Pass the RELATIVE path as the "fileName" so UI knows how to fetch it back?
                // Or utilize the fact that GET /:filename needs to be smart.
                // Let's use the ID/Name as the primary key.
                const parsed = parseSkillWithState(content, displayFilename, type, state);

                // Augment with actual relative path for fetching details
                parsed.filePath = f.relPath; // e.g. "weather/SKILL.md" or "joke.md"

                skills.push(parsed);
            }
        };

        // 1. Scan Built-in
        if (await fs.pathExists(SKILL_DIRS.builtin)) {
            // We need a better recursive scanner that is robust
            // Let's use a simpler flattened flat-scan for now inside the handler or move scanSkillsDir up.
            // Implemented scanSkillsDir above.
            // CAUTION: scanSkillsDir returns { path, relPath } (nested relPath isn't perfect in recursion above)
            // Correct recursion fix:
            const getFiles = async (dir) => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                const files = await Promise.all(entries.map((entry) => {
                    const res = path.resolve(dir, entry.name);
                    if (entry.isDirectory()) {
                        // Check for SKILL.md
                        const skillFile = path.join(res, 'SKILL.md');
                        if (fs.existsSync(skillFile)) return [{ path: skillFile, relPath: path.relative(SKILL_DIRS.builtin, skillFile), isFolder: true }];
                        return getFiles(res).then(fls => fls.map(f => ({ ...f, relPath: path.relative(SKILL_DIRS.builtin, f.path) })));
                    }
                    return entry.name.endsWith('.md') ? [{ path: res, relPath: entry.name, isFolder: false }] : [];
                }));
                return files.flat();
            };

            // Actually, let's keep it simple. Directory scan logic in API should match Agent.
            // For list, we just want valid skills.
            // We can use the same logic as Agent: Read All.

            // RE-IMPLEMENTING scanSkillsDir strictly for this route context to ensure correctness without complex deps.
            const scan = async (base) => {
                let results = [];
                if (!await fs.pathExists(base)) return results;
                const items = await fs.readdir(base, { withFileTypes: true });
                for (const item of items) {
                    const full = path.join(base, item.name);
                    if (item.isDirectory()) {
                        if (await fs.pathExists(path.join(full, 'SKILL.md'))) {
                            results.push({ path: path.join(full, 'SKILL.md'), rel: path.join(item.name, 'SKILL.md') });
                        } else {
                            // Recurse?
                            // results.push(...await scan(full)); // Let's stick to 1-level deep for folders for now to avoid mess
                        }
                    } else if (item.name.endsWith('.md')) {
                        results.push({ path: full, rel: item.name });
                    }
                }
                return results;
            }

            const builtinFiles = await scan(SKILL_DIRS.builtin);
            for (const f of builtinFiles) {
                const content = await fs.readFile(f.path, 'utf8');
                const parsed = parseSkillWithState(content, f.rel, 'builtin', state);
                // Ensure name is clean (remove /SKILL.md if preferred, or rely on parsing)
                skills.push(parsed);
            }
        }

        // 2. Scan User (data/skills)
        if (await fs.pathExists(SKILL_DIRS.user)) {
            const scan = async (base) => {
                let results = [];
                const items = await fs.readdir(base, { withFileTypes: true });
                for (const item of items) {
                    const full = path.join(base, item.name);
                    if (item.isDirectory()) {
                        if (await fs.pathExists(path.join(full, 'SKILL.md'))) {
                            results.push({ path: path.join(full, 'SKILL.md'), rel: path.join(item.name, 'SKILL.md') });
                        }
                    } else if (item.name.endsWith('.md')) {
                        results.push({ path: full, rel: item.name });
                    }
                }
                return results;
            }

            const userFiles = await scan(SKILL_DIRS.user);
            for (const f of userFiles) {
                const content = await fs.readFile(f.path, 'utf8');
                const parsed = parseSkillWithState(content, f.rel, 'user', state);
                skills.push(parsed);
            }
        }

        res.json(skills);
    } catch (e) {
        console.error('List Skills Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /v1/skills/:filename
// NOTE: "filename" param might effectively be a path now (e.g. "weather%2FSKILL.md").
// Only tricky part is Express routing if it contains slashes. 
// We should encode component on client, but Express might decode it before matching /:filename.
// Standard trick: use /:filename(*) to match slashes too.
router.get('/:filename(*)', async (req, res) => {
    try {
        const f = req.params.filename; // Could be "weather/SKILL.md" or "joke.md"

        // Security Check for Traversal
        if (f.includes('..')) return res.status(400).json({ error: 'Invalid path' });

        let p = path.join(SKILL_DIRS.user, f);
        let type = 'user';

        if (!await fs.pathExists(p)) {
            p = path.join(SKILL_DIRS.builtin, f);
            type = 'builtin';
            if (!await fs.pathExists(p)) {
                // Try fallback: maybe they asked for "weather" but it's "weather/SKILL.md"?
                // Or they asked for "joke" and it's "joke.md"?
                // Let's rely on exact match or appending .md if missing.
                if (!f.endsWith('.md')) {
                    const tryMd = f + '.md';
                    if (await fs.pathExists(path.join(SKILL_DIRS.user, tryMd))) {
                        p = path.join(SKILL_DIRS.user, tryMd);
                    } else if (await fs.pathExists(path.join(SKILL_DIRS.builtin, tryMd))) {
                        p = path.join(SKILL_DIRS.builtin, tryMd);
                        type = 'builtin';
                    } else {
                        // Try folder/SKILL.md
                        const tryFolder = path.join(f, 'SKILL.md');
                        if (await fs.pathExists(path.join(SKILL_DIRS.user, tryFolder))) {
                            p = path.join(SKILL_DIRS.user, tryFolder);
                        } else if (await fs.pathExists(path.join(SKILL_DIRS.builtin, tryFolder))) {
                            p = path.join(SKILL_DIRS.builtin, tryFolder);
                            type = 'builtin';
                        } else {
                            return res.status(404).json({ error: 'Skill not found' });
                        }
                    }
                } else {
                    return res.status(404).json({ error: 'Skill not found' });
                }
            }
        }

        const content = await fs.readFile(p, 'utf8');
        const stateFile = path.join(ROOT_DIR, 'data', 'skills-state.json');
        let state = {};
        if (await fs.pathExists(stateFile)) state = await fs.readJson(stateFile);

        // Pass the resolved relative filename/path to the parser so it matches the list view
        // Is p absolute? Yes. We need relative?
        // Let's just pass f or the relative version.
        // Actually parser uses it for "fileName" field.
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
    const stateFile = path.join(ROOT_DIR, 'data', 'skills-state.json');
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
