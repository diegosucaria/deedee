const { createAssistantMessage } = require('@deedee/shared/src/types');

class DJExecutor {
    constructor(services) {
        this.services = services;
        this.djService = services.dj;
    }

    async execute(name, args) {
        switch (name) {
            case 'add_vinyl':
                return this.add_vinyl(args);
            case 'recommend_vinyl':
                return this.recommend_vinyl(args);
            case 'ingest_dj_history':
                return this.ingest_dj_history(args);
            case 'recommend_digital':
                return this.recommend_digital(args);
            default:
                return null;
        }
    }

    async add_vinyl({ image_path }) {
        if (!image_path) return "Please provide an image of the vinyl or receipt.";

        try {
            const results = await this.djService.ingestVinyl(image_path, 'auto');
            if (results.length === 0) return "No vinyls detected or confidence too low.";

            const list = results.map(v => `- **${v.artist}** - ${v.title} (${v.label})`).join('\n');
            return `Added ${results.length} vinyls to your crate:\n${list}`;
        } catch (e) {
            console.error(e);
            return `Failed to ingest vinyl: ${e.message}`;
        }
    }

    async recommend_vinyl({ current_track }) {
        try {
            // ToolExecutor calls executor[toolName](args) — chatId not available here
            // TODO: Pass chatId from ToolExecutor for proper token logging

            const recommendation = await this.djService.recommendVinyl(current_track, 'system_tool_call');
            return recommendation;
        } catch (e) {
            return `Error getting recommendation: ${e.message}`;
        }
    }

    async ingest_dj_history({ content, venue, date, party }) {
        try {
            const filename = await this.djService.ingestHistory(content, { venue, date, party });
            return `History saved to DJ Vault as \`${filename}\` with context: ${venue} / ${party} (${date}).`;
        } catch (e) {
            return `Failed to save history: ${e.message}`;
        }
    }

    async recommend_digital({ current_track, context }) {
        try {
            const result = await this.djService.recommendDigital(current_track, { context }, 'system_tool_call');
            return result;
        } catch (e) {
            return `Error: ${e.message}`;
        }
    }
}

module.exports = { DJExecutor };
