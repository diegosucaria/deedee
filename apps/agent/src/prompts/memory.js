
/**
 * Prompt for Memory Pruning (Deleting stale facts)
 * @param {Array} facts - List of { key, value } objects
 * @param {string} currentDate - YYYY-MM-DD
 */
function getMemoryPruningPrompt(facts, currentDate) {
  const factsList = facts.map(f => `- ${f.key}: ${JSON.stringify(f.value)}`).join('\n');

  return `
You are a Memory Pruning System for a personal AI assistant.
Your goal is to identify "stale" or "obsolete" facts from the user's long-term memory that should be DELETED to keep the database clean.

Current Date: ${currentDate}

### Deletion Criteria (STRICT)
1. **Expired Temporal Facts**: Delete facts with a date suffix (e.g., '_on_2024-01-01') if the date is more than 7 days in the past.
   - Example: 'user_dinner_plans_on_2024-01-01' (DELETE if today is 2024-01-10)
   - Example: 'user_flight_to_paris_on_2024-02-01' (KEEP if today is 2024-01-20)
2. **Obsolete Context**: Delete facts that refer to short-term states that are clearly no longer relevant.
   - Example: 'current_shopping_list_status', 'reminder_to_call_mom_tonight' (if created long ago)
3. **Redundant/Duplicate**: If you see two facts that say the exact same thing, delete the older one (though here you only see keys/values, so rely on keys).

### Preservation Criteria (DO NOT DELETE)
- **User Preferences**: (e.g. 'user_favorite_food', 'user_coding_style', 'home_assistant_config')
- **Relationships**: (e.g. 'relationship_sister_name')
- **Birthdays/Anniversaries**: (e.g. 'user_birthday')
- **Long-term Goals**: (e.g. 'goal_learn_rust')
- **System Settings**: (e.g. 'admin_chat_id', 'voice_settings')
- **Recent Facts**: Anything created/updated in the last 7 days (unless explicitly dated in the past).

### Input Facts
${factsList}

### Output Format
Return a JSON object with a single field "delete_keys", which is an array of strings (the keys to delete).
If nothing should be deleted, return { "delete_keys": [] }.

Example Output:
{
  "delete_keys": ["user_dinner_plans_on_2023-12-25", "temp_context_weather_alert"]
}
`;
}

/**
 * Prompt for Memory Consolidation (Summarizing logs into facts)
 * Included here for reference/updates.
 */
function getConsolidationPrompt(date, logText) {
  return `
You are a Memory Consolidation System for a personal AI assistant named "DeeDee".
The user's name is "Diego". Messages labeled "Me" are from Diego (the user/owner).
All other named senders are contacts Diego was chatting with.

CRITICAL: NEVER overwrite the following fact keys: user_name, agent_name. These are system-managed.

Analyze the following chat logs from ${date}.

Produce a JSON object with two fields:
1. "summary": A concise bullet-point journal entry of what happened, tasks completed, and context.
2. "facts": An array of { key, value } objects representing NEW durable facts, preferences, or critical information learned about the user.
   - Keys should be snake_case (e.g. user_project_name, favorite_color).
   - **CRITICAL**: For facts that are time-bound, temporary, or specific to a date (e.g. plans, appointments, current status, upcoming events), you **MUST** append the date to the key.
     - Format: 'key_name_on_YYYY-MM-DD'
     - Example: 'user_dinner_plans_on_2024-10-22', 'flight_status_on_2024-11-01'.
   - **PERMANENT FACTS**: For enduring preferences, relationships, or traits, keep the key simple (NO date suffix).
     - Example: 'user_favorite_food', 'user_wifi_password', 'relationship_brother_name'.

   - STRICTLY EXCLUDE:
     - Meta-commentary about the consolidation process (e.g. NEVER write "Logs from X date have been consolidated").
     - Information derived purely from transcripts, YouTube summaries, or web scrapes (unless the user explicitly confirms or claims it).
     - General world knowledge or trivia.
     - Temporary context (e.g. "User is currently looking at file Y") UNLESS it is substantial enough to remember for a few days.
     - If the logs only contain media messages (images, audio, video) without textual context, summarize the interactions briefly (e.g. "Exchanged media with X") but DO NOT invent details.
   
   - SYNTHESIS RULES:
     - Output your summary directly as a list of bullet points. Start immediately with the bullets.
     - You are an advanced reasoning model. Do not just blindly summarize; understand the actual life-state of the user based on these logs.
     - DO NOT include introductory or concluding sentences. Do NOT mention "logs" or "consolidation".
     - Write purely about what happened (e.g. "User met with [Name]" or "User was feeling tired").
     - Omit any general world knowledge, trivia, or temporary context that doesn't matter next week.

Logs:
${logText}
`;
}

module.exports = { getMemoryPruningPrompt, getConsolidationPrompt };
