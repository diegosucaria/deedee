const express = require('express');
const path = require('path');

const createSkillsRouter = (agent) => {
    const router = express.Router();

    // GET /internal/skills - List all loaded skills (with state)
    // This replaces the filesystem scan in the API
    router.get('/', async (req, res) => {
        try {
            // Get all loaded skills from the service
            // We want to return detailed objects similar to what the UI expects
            // agent.skillService.skills is a Map<string, Skill>
            const skills = Array.from(agent.skillService.skills.values()).map(skill => {
                // Hydrate with current runtime state
                let state = { enabled: true, secrets: {} }; // Defaults
                if (agent.skillService.state && agent.skillService.state[skill.name]) {
                    state = agent.skillService.state[skill.name];
                }

                return {
                    ...skill,
                    enabled: state.enabled && skill.userInvocable, // Effective status
                    secrets: state.secrets,
                    // UI expects 'filePath' for editing. Since we are proxying, this path is relative to Agent container.
                    // This might be tricky if UI tries to save it back differently, but saving goes via API->Agent too?
                    // Let's assume just passing back what we have is fine.
                };
            });
            res.json(skills);
        } catch (error) {
            console.error('[Agent] List Skills Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /internal/skills/:name
    router.get('/:name', async (req, res) => {
        try {
            const name = req.params.name;
            const skill = agent.skillService.skills.get(name);

            if (!skill) {
                return res.status(404).json({ error: 'Skill not found' });
            }

            // We might need to reload or read the file content if strictly needed for editing? 
            // The loaded skill object already has 'content' (raw markdown) if _parseSkill kept it.
            // Let's check _parseSkill. Yes, it has `content`.

            let state = {};
            if (agent.skillService.state && agent.skillService.state[name]) {
                state = agent.skillService.state[name];
            }

            res.json({
                ...skill,
                enabled: state.enabled,
                secrets: state.secrets,
                raw: skill.content // For editor
            });
        } catch (error) {
            console.error('[Agent] Get Skill Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /internal/skills/:name/toggle
    router.post('/:name/toggle', async (req, res) => {
        try {
            const { enabled } = req.body;
            const name = req.params.name;
            await agent.skillService.toggleSkill(name, enabled);
            res.json({ success: true, enabled });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // POST /internal/skills/:name/secrets
    router.post('/:name/secrets', async (req, res) => {
        try {
            const { secrets } = req.body;
            const name = req.params.name;
            await agent.skillService.setSkillSecrets(name, secrets);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};

module.exports = { createSkillsRouter };
