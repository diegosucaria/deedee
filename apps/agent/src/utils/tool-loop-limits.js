/**
 * Per-tool ceilings for the tool-loop guard's first tier: the same tool
 * called again and again with new arguments. The default ceiling is
 * MAX_SAME_TOOL_CALLS in agent.js. The tools here fan out across many
 * distinct arguments on purpose; they still have a ceiling, unlike the
 * exempt tools.
 */
const TIER1_LIMIT_OVERRIDES = Object.freeze({
  resolveSlackUser: 12, // fans out per user in a Slack scan (6–10 normal); cheap now that the workspace roster is cached interface-side
  // A list of records checked one by one is a real pass, not a stuck loop:
  // the 6-call warning nagged a 12-item cart check and told the model to
  // stop. search_vinyls now takes a list; this is for a model that still
  // goes one by one. Both are cheap local reads.
  search_vinyls: 20,
  get_vinyl: 20,
});

module.exports = { TIER1_LIMIT_OVERRIDES };
