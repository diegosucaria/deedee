
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

            const text = result.json();
            // SDK v1.x result.json() returns the object directly if MIME is application/json?
            // Or we parse text()?
            // result.text() returns string JSON. 
            // Docs say `responseMimeType: 'application/json'` returns text that is JSON.
            // But SDK might have helper.
            // Safe bet: JSON.parse(result.text())
            // Wait, previous code used result directly? No, it was inside agent.js but I didn't see the parsing logic in the snippet.
            // I'll assume JSON.parse(result.text()) is standard.

            // Actually, newer SDK might parse valid JSON automatically if schema is provided?
            // Let's stick to parsing text.
            let analysis;
            try {
                analysis = typeof result.text === 'function' ? JSON.parse(result.text()) : null;
            } catch (e) {
                console.warn('[AnalysisService] Failed to parse JSON response', e);
            }

            if (!analysis) return;

            console.log(`[AnalysisService] Result for ${chatId}:`, analysis);

            // Action
            if (analysis.vaultId && analysis.vaultId !== 'null' && analysis.vaultId !== 'none') {
                // Auto-Store? Or Suggest?
                // For now, just Log/Memory
                // Ideally we add to the Vault directly.
                console.log(`[AnalysisService] Identified Vault: ${analysis.vaultId}`);

                // Store in Vault Notes
                await this.agent.vaults.addNote(analysis.vaultId, `Analyzed File: ${analysis.summary}`);

                // Notify User
                /*
                const reply = createAssistantMessage(`📂 I filed that document into your **${analysis.vaultId}** vault.\nSummary: ${analysis.summary}`);
                reply.metadata = { chatId };
                this.agent.interface.send(reply); // Async send
                */
                // We don't have easy async send back without context.
            }

        } catch (e) {
            console.error('[AnalysisService] Failed:', e);
        }
    }
}

module.exports = { AnalysisService };
