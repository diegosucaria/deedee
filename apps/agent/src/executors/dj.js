const { createAssistantMessage } = require('@deedee/shared/src/types');

class DJExecutor {
    constructor(services) {
        this.services = services;
        this.djService = services.dj;
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
            // Pass chatId from metadata if we can get it? 
            // ToolExecutor passes (name, args, message, ...)
            // But here args are destructured. 
            // We might need to change signature or access it differently if we want to log tokens correctly with chatId.
            // For now, let's pass a placeholder or fix ToolExecutor call.
            // Actually, ToolExecutor calls `executor[toolName](args)`. 

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
