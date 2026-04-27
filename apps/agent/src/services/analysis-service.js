
const fs = require('fs');
const path = require('path');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { ConfigService } = require('./config-service');

class AnalysisService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
    }

    async analyzeAttachment(chatId, part, currentVaultId) {
        console.log(`[AnalysisService] Analyzing attachment for ${chatId}...`);
        try {
            const { mimeType, data } = part.inlineData;

            // Fetch available vaults
            const vaults = await this.agent.vaults.listVaults();
            const vaultList = vaults.map(v => `- **${v.id}**: ${v.id === 'health' ? 'Medical records, prescriptions, workout plans, diet' : v.id === 'finance' ? 'Invoices, receipts, tax docs, bank statements' : 'Items related to ' + v.id}`).join('\n        ');

            // Construct prompt
            const prompt = `
            Analyze this document/file.
            Your goal is to determine if this file belongs to one of our specific Life Vaults:
            ${vaultList}

            If it clearly belongs to one of them, extract RELEVANT data to store in that vault.
            If it is generic or doesn't fit, just summarize it briefly.

            Return JSON:
            {
                "vaultId": "health" | "finance" | "null",
                "summary": "Brief summary...",
                "suggestedMemories": ["fact 1", "fact 2"]
            }
            `;

            const schema = {
                type: 'OBJECT',
                properties: {
                    vaultId: { type: 'STRING', nullable: true },
                    summary: { type: 'STRING' },
                    suggestedMemories: { type: 'ARRAY', items: { type: 'STRING' } }
                }
            };

            // Use Worker Flash Model (Cheaper/Faster)
            // Hardcoded model dependency extracted from env or default
            const model = this.config.getModel('FLASH');

            // We need a fresh client or use the agent's client?
            // Agent's client might be busy or we want a one-off request.
            // Client is stateless, so we can reuse `this.agent.client`.

            const result = await this.agent.client.models.generateContent({
                model: model,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType, data } },
                        { text: prompt }
                    ]
                }],
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: schema
                }
            });

            this.config.logUsageFromResponse(this.agent.db, model, result, chatId, 'analysis');

            // Parse JSON from response text (SDK may return raw text even with responseMimeType set)
            let analysis;
            try {
                let text = '';
                try {
                    if (typeof result.text === 'function') text = result.text();
                    else if (result.response && typeof result.response.text === 'function') text = result.response.text();
                } catch (e) { /* ignore */ }

                if (!text && result.response?.candidates?.[0]?.content?.parts) {
                    text = result.response.candidates[0].content.parts.map(p => p.text).join('');
                } else if (!text && result.candidates?.[0]?.content?.parts) {
                    text = result.candidates[0].content.parts.map(p => p.text).join('');
                }

                if (text) {
                    // Clean markdown if present
                    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
                    analysis = JSON.parse(text);
                }
            } catch (e) {
                console.warn('[AnalysisService] Failed to parse JSON response', e);
            }

            if (!analysis) return;

            console.log(`[AnalysisService] Result for ${chatId}:`, analysis);

            // Action
            if (analysis.vaultId && analysis.vaultId !== 'null' && analysis.vaultId !== 'none') {
                console.log(`[AnalysisService] Identified Vault: ${analysis.vaultId}`);

                // Route vinyl/DJ images to the DJ Service for proper cataloguing
                if (analysis.vaultId === 'dj_history' && this.agent.djService) {
                    try {
                        console.log('[AnalysisService] Routing to DJService.ingestVinyl()...');
                        const results = await this.agent.djService.ingestVinylFromBase64(data, mimeType);
                        console.log(`[AnalysisService] DJ ingestion complete: ${results.length} vinyls added.`);
                    } catch (djErr) {
                        console.error('[AnalysisService] DJ ingestion failed:', djErr.message);
                    }
                } else {
                    // Store in Vault Notes for non-DJ vaults.
                    // Date.now() alone collides when multiple attachments from the same
                    // message complete analysis within the same millisecond — add a
                    // random suffix so concurrent writes don't silently overwrite.
                    const suffix = Math.random().toString(36).slice(2, 10);
                    const filename = `analysis_${Date.now()}_${suffix}.md`;
                    await this.agent.vaults.updateVaultPage(analysis.vaultId, filename, `# Analyzed File\n\n${analysis.summary}`);
                }
            }

        } catch (e) {
            console.error('[AnalysisService] Failed:', e);
        }
    }
}

module.exports = { AnalysisService };
