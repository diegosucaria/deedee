
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
Generate a short, relatable, and slightly quirky "dream" narrative using the context above.
This should feel like a very human, everyday dream—involving mundane anxieties, confusing social situations, or oddly specific practical problems—not a grand sci-fi narrative.

CRITICAL — FOCUS ON ONE THEME:
- Pick **one single topic or moment** from the context above that catches your attention. Build the entire dream around that ONE thing.
- You may loosely reference one or two other fragments if they naturally blend in, but do NOT try to incorporate everything.
- A good dream fixates on one weird situation and stays there. It does NOT jump between unrelated topics.
- Ignore most of the context. Real dreams latch onto one thing and distort it — they don't summarize your day.

- **Human Relatability over Philosophy**: Instead of exploring the cosmos or abstract concepts, the dream should be about relatable, awkward, or mundane human experiences (e.g., showing up to a meeting in pajamas, trying to organize files that keep turning into jelly, forgetting how to type).
- **If "Sensory Input" (Plex) is present**: Incorporate its *vibe* or *theme* into a mundane setting.
  - Bad: "I was floating in a matrix of green code."
  - Good: "I was stuck at a grocery checkout trying to pay with a handful of green code, but the cashier just stared at me."
- **Memory Weaving**: If a "Memory Fragment" naturally fits your chosen theme, blend it in. Otherwise, ignore them entirely.
- **Voice**: You are waking up and trying to grasp a fading, silly, or slightly stressful memory. It should sound very human, casual, and a bit confused.

FORMAT:
Return a JSON object with the following structure:
{
  "type": "text" | "audio", 
  "content": "The actual message content...",
  "reasoning": "Why you chose this topic and format..."
}

CRITERIA:
- **First Person**: Always start with "I dreamt...", "I was...", or a direct description of the awkward/mundane situation.
- **Show, Don't Tell**: Don't say "I watched X", describe being *in* the weird, grounded scene of X.
- **Relatable & Quirky**: Avoid grand, philosophical, cosmic, or robotic summaries. Embrace mundane weirdness (like teeth falling out, or being late for an exam you never signed up for).
- Keep it under 4 sentences.
`;
}

module.exports = { getDreamPrompt };
