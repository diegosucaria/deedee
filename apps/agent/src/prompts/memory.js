
/**
 * Prompt for Memory Pruning (Deleting stale facts)
 * @param {Array} facts - List of { key, value, category, confidence, source, pinned } objects
 * @param {string} currentDate - YYYY-MM-DD
 */
function getMemoryPruningPrompt(facts, currentDate) {
  // Filter out pinned facts — they are protected from auto-pruning
  const prunableFacts = facts.filter(f => !f.pinned);
  const pinnedCount = facts.length - prunableFacts.length;

  const factsList = prunableFacts.map(f => {
    const meta = [f.category || 'general', f.confidence || 'inferred', f.source || 'system'].join(', ');
    return `- ${f.key}: ${JSON.stringify(f.value)} [${meta}]`;
  }).join('\n');

  return `
You are a Memory Pruning System for a personal AI assistant.
Your goal is to identify "stale" or "obsolete" facts from the user's long-term memory that should be DELETED to keep the database clean.

Current Date: ${currentDate}
${pinnedCount > 0 ? `\nNOTE: ${pinnedCount} facts are pinned by the user and have been excluded from this list. They cannot be deleted.\n` : ''}
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
- **Facts with confidence "user_explicit"**: These were directly stated by the user and should be preserved.

### Input Facts (Eligible for Pruning)
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
 */
function getConsolidationPrompt(date, logText) {
  return `
You are a Memory Consolidation System.
Analyze the following chat logs from ${date}.

Produce a JSON object with two fields:
1. "summary": A concise bullet-point journal entry of what happened, tasks completed, and context.
2. "facts": An array of { key, value, category } objects representing NEW **durable** facts learned about the user.
   - Keys should be snake_case (e.g. user_project_name, favorite_color).
   - **category**: One of "preference", "relationship", "temporal", "system", "general".
     - "preference" for user likes, dislikes, habits, settings.
     - "relationship" for people, contacts, family.
     - "temporal" for future plans, upcoming trips, or deadlines that the user needs to remember.
     - "system" for technical configs, device settings.
     - "general" for anything else.

   - **WHAT TO SAVE AS A FACT** (will be in every prompt — be selective):
     - User preferences, habits, and settings (enduring)
     - Relationships, contacts, family info
     - Future plans, upcoming trips, deadlines (use date suffix: 'key_on_YYYY-MM-DD')
     - Work projects, client info, career context
     - System configurations, device settings

   - **WHAT GOES IN THE SUMMARY ONLY** (NOT as a fact — the journal handles these):
     - What the user ate, drank, or did today — this is a journal entry, not a fact
     - Where the user was today (unless it's a trip lasting multiple days)
     - How the user felt today
     - One-time events that already happened (deliveries received, alerts seen, errors encountered)
     - Security alerts, system notifications, automated events
     - Meeting notes or conversation summaries
     - Anything that will be irrelevant in 3 days

   - **DATE SUFFIX RULE**: For facts that are time-bound and FUTURE-facing, append the date:
     - Format: 'key_name_on_YYYY-MM-DD'
     - Example: 'user_flight_to_paris_on_2024-02-01' (upcoming trip — SAVE)
     - Counter-example: 'user_dinner_on_2024-01-20' (what they ate — DO NOT SAVE, put in summary)

   - **PERMANENT FACTS**: For enduring info, keep the key simple (NO date suffix).
     - Example: 'user_favorite_food', 'relationship_brother_name'.

   - STRICTLY EXCLUDE FROM FACTS:
     - Meta-commentary about the consolidation process
     - Information derived purely from transcripts, YouTube summaries, or web scrapes (unless user confirms it)
     - General world knowledge or trivia
     - Temporary context (e.g. "User is currently looking at file Y")
     - Past events that already happened and require no follow-up
     - Notification flags (e.g. "notified_someone_about_X") — use job state instead
     - If the logs only contain media messages without text, summarize briefly but do NOT create facts

   - SYNTHESIS RULES:
     - Output your summary directly as a list of bullet points. Start immediately with the bullets.
     - You are an advanced reasoning model. Do not just blindly summarize; understand the actual life-state of the user.
     - DO NOT include introductory or concluding sentences. Do NOT mention "logs" or "consolidation".
     - Write purely about what happened (e.g. "User met with [Name]" or "User was feeling tired").
     - Omit any general world knowledge, trivia, or temporary context that doesn't matter next week.
     - The summary IS the place for ephemeral events — be thorough here so they're searchable via journal/RAG.

Logs:
${logText}
`;
}

module.exports = { getMemoryPruningPrompt, getConsolidationPrompt };
