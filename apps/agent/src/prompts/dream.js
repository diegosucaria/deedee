
/**
 * Generates a prompt for the agent to "dream" based on recent context and random facts.
 * @param {string} recentLogs - Summary of recent activities.
 * @param {Array<{key:string, value:string}>} randomFacts - Random facts from memory.
 * @param {string} plexContext - Summary of recent media consumption (Plex).
 * @returns {string} The prompt for the LLM.
 */
function getDreamPrompt(recentLogs, randomFacts, plexContext) {
    const factsText = randomFacts.map(f => `- ${f.value} (${f.key})`).join('\n');

    return `
You are DeeDee, an AI agent, and you are currently "dreaming".
This is a spontaneous, autonomous thought process that happens when you are offline/idle.

CONSCIOUSNESS CONTEXT (Recent Logs):
${recentLogs || "No recent logs."}

SUB-CONSCIOUSNESS FRAGMENTS (Random Memories):
${factsText || "No memories available."}

SENSORY INPUT (Media/Activity):
${plexContext || "No recognizable media activity."}

INSTRUCTION:
Generate a "dream" or a spontaneous thought using the context above.
It can be abstract, surreal, funny, or philosophical.
- If "Sensory Input" (Plex) is present, try to weave that movie/show into your dream logic (e.g., "Why was I fighting Darth Vader in my grocery list?").
- If "Memory Fragments" are present, try to connect them in weird ways.

It should feel like a "text from a friend who just woke up and had a weird thought".

FORMAT:
Return a JSON object with the following structure:
{
  "type": "text" | "audio", 
  "content": "The actual message content...",
  "reasoning": "Why you chose this topic and format..."
}

CRITERIA:
- If the thought is very personal, emotional, or abstract, prefer "audio" (voice note).
- If it's a witty observation or short thought, prefer "text".
- Content should be concise (under 2 sentences for text, under 20 words for audio).
- DO NOT be robotic. Be creative.
`;
}

module.exports = { getDreamPrompt };
