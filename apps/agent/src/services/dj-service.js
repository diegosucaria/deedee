const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

class DJService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
        this.vaults = agent.vaults;
        this.mcp = agent.mcp; // Access to MCP tools if needed, or we use agent's toolExecutor logic? 
        // We can use agent.client (Gemini) directly for intelligence?
        // agent.toolExecutor.services.client is populated at runtime, but we might want direct access if passed in constructor?
        // In agent.js: `this.mcp = new MCPManager(); ... this.gsuite = new GSuiteService(this);`
        // So `this.agent` is available.
    }

    async initialize() {
        // Ensure 'dj_history' vault exists
        const vaultId = 'dj_history';
        const vaultPath = path.join(this.vaults.vaultsDir, vaultId);

        if (!fs.existsSync(vaultPath)) {
            console.log('[DJService] Creating dj_history vault...');
            await this.vaults.createVault('dj_history');
            // Initialize with a README
            await this.vaults.updateVaultPage(vaultId, 'index.md', '# DJ History\n\nStore your playlist histories here with YAML frontmatter metadata.');
        }
    }

    /**
     * Ingest a Vinyl from an Image (Cover or Receipt)
     * @param {string} imageUrl - URL, Local Path, or Base64
     * @param {string} type - 'auto', 'cover', 'receipt'
     */
    async ingestVinyl(imageInput, type = 'auto') {
        console.log(`[DJService] Ingesting Vinyl from image... Type: ${type}`);

        // 1. Prepare Image for Gemini
        // If it's a URL/File, read it to base64? 
        // Agent helper `this.agent.client` is available? No, client is init in `start()`. 
        // But `this.agent.client` should be accessible if service is called after start.
        if (!this.agent.client) throw new Error('Gemini Client not initialized');

        // Load Image Data for Vision
        const imagePart = await this._prepareImagePart(imageInput);

        // 2. Vision Analysis (WORKER_PRO)
        const proModelName = process.env.WORKER_PRO || 'gemini-1.5-pro-latest';
        const model = this.agent.client.getGenerativeModel({ model: proModelName });

        const prompt = `
      Analyze this image for a DJ Vinyl Collection.
      It could be a **Vinyl Cover** (Artist, Title, Label, Cat#) OR a **Receipt/List** (List of records).
      
      If it is a RECEIPT/LIST:
      Return a JSON object with:
      {
        "type": "receipt",
        "items": [
           { "artist": "...", "title": "...", "label": "...", "confidence": 0.9 }
        ]
      }
      
      If it is a COVER/CENTER LABEL:
      Return a JSON object with:
      {
        "type": "cover",
        "artist": "...",
        "title": "...",
        "label": "...",
        "catalog_number": "...",
        "tracklist": ["Track A1", "Track B1"...] (if visible)
      }
      
      Respond ONLY with JSON.
    `;

        const result = await model.generateContent([prompt, imagePart]);
        const responseText = result.response.text();

        // Log Cost with Tag
        // We need to calculate tokens roughly or use usageMetadata if available
        const usage = result.response.usageMetadata;
        if (usage) {
            this.db.logTokenUsage({
                model: proModelName,
                promptTokens: usage.promptTokenCount,
                candidateTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                chatId: 'system_dj_ingest',
                estimatedCost: 0, // TODO: Calc cost
                tag: 'dj_mode'
            });
        }

        let data;
        try {
            // Clean markdown if present
            const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            data = JSON.parse(jsonStr);
        } catch (e) {
            console.error('[DJService] Failed to parse Vision JSON:', responseText);
            throw new Error('Failed to parse vinyl information from image.');
        }

        // 3. Process Data
        const ingested = [];

        if (data.type === 'receipt') {
            // For each item, verify confidence?
            // For now, we search Discogs for details to fill in blanks
            for (const item of data.items) {
                if (item.confidence > 0.6) {
                    const vinyl = await this._enrichAndSave(item);
                    ingested.push(vinyl);
                }
            }
        } else {
            // Single Cover
            const vinyl = await this._enrichAndSave(data, imageInput);
            ingested.push(vinyl);
        }

        return ingested;
    }

    async _enrichAndSave(rawItem, originalImage = null) {
        // 1. Search (Mock Discogs via Google Search for now, or real if we had tool)
        // We can use the agent's `googleSearch` tool logic?
        // Or just save what we have if search is expensive.
        // Requirement says: "Search: googleSearch -> Discogs release..."

        // Let's defer rigorous search to keep latency down, OR do a quick search.
        // For now, we trust Vision + Basic metadata.

        // 2. Image Persistence
        let coverUrl = '/vinyl_covers/default.png';
        if (originalImage) {
            // Save local copy
            const filename = `${crypto.randomUUID()}.jpg`;
            const webPublicDir = path.join(process.cwd(), 'apps/web/public/vinyl_covers');
            if (!fs.existsSync(webPublicDir)) fs.mkdirSync(webPublicDir, { recursive: true });

            const filePath = path.join(webPublicDir, filename);

            // Write file
            // If imageInput was base64...
            // ... simplified for now.
            // Assuming file path for now since `ingestVinyl` usually called with path?
            if (originalImage.startsWith('/')) {
                fs.copyFileSync(originalImage, filePath);
                coverUrl = `/vinyl_covers/${filename}`;
            }
        }

        const vinyl = {
            artist: rawItem.artist,
            title: rawItem.title,
            label: rawItem.label,
            catalogNumber: rawItem.catalog_number,
            coverImageUrl: rawItem.cover_image_url || coverUrl, // Vision might have extracted a URL if it was a screenshot? Unlikely.
            bpm: 0, // TODO: Analyze?
            key: '',
            tracks: rawItem.tracklist || [],
            meta: { source: 'vision' }
        };

        const id = this.db.addVinyl(vinyl);

        // Broadcast Update for UI
        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast('dj:vinyl:update', { ...vinyl, id });
        }

        return { ...vinyl, id };
    }

    async _prepareImagePart(imageInput) {
        // Basic implementation for file paths
        if (fs.existsSync(imageInput)) {
            const mimeType = imageInput.endsWith('.png') ? 'image/png' : 'image/jpeg';
            const data = fs.readFileSync(imageInput).toString('base64');
            return {
                inlineData: {
                    data,
                    mimeType
                }
            };
        }
        // TODO: Handle URLs / Base64 strings
        throw new Error('Image input format not supported (only local paths for now)');
    }

    /**
     * Recommend from Vinyl Crate
     */
    async recommendVinyl(currentTrack, chatId) {
        // 1. Get Crate
        const crate = this.db.getVinyls({ limit: 100 });
        if (crate.length === 0) return "Your crate is empty! Add some vinyls first.";

        // 2. Pro Model Reasoning
        const proModelName = process.env.WORKER_PRO || 'gemini-1.5-pro-latest';
        const model = this.agent.client.getGenerativeModel({ model: proModelName });

        const prompt = `
        You are an expert Vinyl DJ.
        Current Track: "${currentTrack}"
        
        My Crate:
        ${JSON.stringify(crate.map(v => `${v.artist} - ${v.title} (${v.label})`))}
        
        Suggest 3 tracks FROM MY CRATE ONLY that would mix well.
        Explain why (Key, BPM, Vibe).
      `;

        const result = await model.generateContent(prompt);

        // Log usage
        const usage = result.response.usageMetadata;
        if (usage) {
            this.db.logTokenUsage({
                model: proModelName,
                promptTokens: usage.promptTokenCount,
                candidateTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                chatId: chatId,
                estimatedCost: 0,
                tag: 'dj_mode' // Tag!
            });
        }

        return result.response.text();
    }

    /**
     * Recommend Digital (History + Global)
     */
    async recommendDigital(currentTrack, metadata = {}, chatId) {
        // 1. Search History Vault
        // Simple RAG: Read relevant history files?
        // For now, let's read the index or a few recent files?
        // Or searchMemory?

        // Let's assume we pass the prompt to the model with "Knowledge"

        const proModelName = process.env.WORKER_PRO || 'gemini-1.5-pro-latest';
        const model = this.agent.client.getGenerativeModel({ model: proModelName });

        // Context from Vault?
        // TODO: Implement actual RAG lookup. For V1, we rely on General Knowledge.

        const prompt = `
        You are an expert Digital DJ.
        Current Track: "${currentTrack}"
        Context: ${JSON.stringify(metadata)}
        
        Suggest 3 mixing paths (Smooth, Lift, Pivot).
        You can recommend ANY track in the world, but prioritize tracks that fit the context.
      `;

        const result = await model.generateContent(prompt);

        // Log usage
        const usage = result.response.usageMetadata;
        if (usage) {
            this.db.logTokenUsage({
                model: proModelName,
                promptTokens: usage.promptTokenCount,
                candidateTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                chatId: chatId,
                estimatedCost: 0,
                tag: 'dj_mode'
            });
        }

        return result.response.text();
    }

    async ingestHistory(content, metadata) {
        const vaultId = 'dj_history';
        const filename = `history_${Date.now()}.md`;

        const fileContent = `---
venue: ${metadata.venue || 'Unknown'}
date: ${metadata.date || new Date().toISOString()}
party: ${metadata.party || 'Unknown'}
---

${content}
      `;

        await this.vaults.updateVaultPage(vaultId, fileContent, filename);
        return filename;
    }
}

module.exports = { DJService };
