require('dotenv').config({ path: '../../.env' });
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const { getConsolidationPrompt } = require('./src/prompts/memory.js');

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const fullText = fs.readFileSync('../../test-logs-dump.js', 'utf8');
const logs = fullText.split('--- WHAT THE LLM SEES ---')[1] || fullText;

async function run() {
    console.log("Starting test...");
    const prompt = getConsolidationPrompt('2026-02-22', logs);

    try {
        const result = await client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ parts: [{ text: prompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        console.log("=== CURRENT PROMPT OUTPUT ===");
        console.log(result.text);
    } catch (e) {
        console.error("Failed:", e);
    }
}
run();
