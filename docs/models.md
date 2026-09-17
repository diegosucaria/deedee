# Gemini model roles

Deedee calls Gemini through nine roles. Each role is one env var, read once at
agent start by `apps/agent/src/services/config-service.js` (`CONSTANTS.MODELS`).
Code asks for a role, never for an id: `configService.getModel('FLASH')`.

| Role | Env var | Default id | Used for | $/1M tokens in → out |
|---|---|---|---|---|
| ROUTER | `ROUTER_MODEL` | `gemini-3.1-flash-lite` | picks FLASH or PRO and the tool mode per message | 0.25 → 1.50 |
| LITE | `WORKER_LITE` | `gemini-3.1-flash-lite` | transcription, image descriptions, tool scoping, summaries, lightweight sub-agents, sub-agent result summaries | 0.25 → 1.50 |
| FLASH | `WORKER_FLASH` | `gemini-3.6-flash` | main chat, tool loops, sub-agents, system jobs, nightly dream and pruning, most services | 0.75 → 3.75 |
| SEARCH | `WORKER_GOOGLE_SEARCH` | `gemini-3.6-flash` | Google Search grounding | 0.75 → 3.75, plus grounding quota |
| PRO | `WORKER_PRO` | `gemini-3.1-pro-preview` | hard reasoning, code, planning | 2.00 → 12.00 (4.00 → 18.00 above 200k input) |
| TTS | `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | voice notes | 0.50 → 10.00 |
| IMAGE | `GEMINI_IMAGE_MODEL` | `gemini-3-pro-image` | image generation, wardrobe mirror | 2.00 in; 12.00 text out; 120.00 image out (`gemini-3.1-flash-image` is half the price per image, lighter model) |
| EMBEDDING | `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2` | RAG vectors (`EMBEDDING_DIMENSIONS`, 1536 in production) | 0.20 in |
| LIVE | `WORKER_LIVE` | `gemini-3.8-live` | voice page at `/live` | audio 3.00 → 12.00; text 0.75 → 4.50 |

Prices come from https://ai.google.dev/gemini-api/docs/pricing. The 3.x Flash
price doubles on 2027-01-01. Grounded requests on 3.x models share one free pool
of 5,000 per month, then cost $14 per 1,000.

## Where the ids live and how to override them

- `docker-compose.yml` sets every role for the `agent` service.
- Balena device and fleet variables override compose. To change or roll back a
  model without a deploy: set the variable in the Balena dashboard, restart the
  `agent` service. The old ids are kept as comments in compose for this.
- Never write an id in code. Use `configService.getModel('ROLE')`; the role→env
  map is `CONSTANTS.MODEL_ENV_VARS`.

## System jobs and sub-agents

System jobs that run an agent turn no longer go through the router. Each
`SYSTEM_JOBS` entry in `apps/agent/src/scheduler.js` names its model and tool
list:

| job | model | tools |
|---|---|---|
| `proactive_thought` | PRO | `spawnAgent`, `getAgentResult`, `scheduleJob`, `setReminder`, `sendMessage`, `searchMemory`, `getFact`, `saveJobState`, `getJobState`, `askUser` |
| `wardrobe_pretrip_check` | FLASH | `list_wardrobe_trips`, `start_wardrobe_trip`, `wardrobe_pack_for_trip`, `spawnAgent`, `getAgentResult`, `sendMessage`, `askUser` |
| `wardrobe_morning_outfit` | FLASH | `spawnAgent`, `getAgentResult`, `recommend_outfit`, `sendMessage`, `getFact`, `searchMemory`, `askUser` |

Each list names `askUser` because the scheduler filter matches by exact name.
User jobs keep it through the tool scoper, which keeps every internal tool
with no category. Questions from a job go to the owner channel.

The two wardrobe jobs run on FLASH because the quality sits in their inner PRO
calls (`recommend_outfit`, `wardrobe_pack_for_trip`). `proactive_thought` has no
inner PRO call — its filter step decides what reaches the owner, so the turn
itself stays PRO. It fires under once a day (p=0.05 over 16 hourly slots).

The PRO calls inside `recommend_outfit`, `wardrobe_pack_for_trip` and
`consolidateMemory` stay. `nightly_consolidation` calls `consolidateMemory`
through the tool executor, with no agent turn. `nightly_dream` and
`nightly_memory_pruning` call FLASH. Pruning bounds that weaker judge in code:
at most `MEMORY_PRUNE_MAX_DELETES` (10) keys per run, and it never deletes a
pinned fact, a fact with confidence `user_explicit`, a preference or
relationship, or anything touched in the last 7 days. Every deletion still goes
to `data/pruned_memories.json`, and the owner gets a `memory_pruned`
notification listing the keys.

- Override per job: set `model` or `allowedTools` on the job's row in
  `scheduled_jobs` (payload JSON). The row wins and survives restarts; the
  defaults sit under `payload.scope`.
- Roll back: `SYSTEM_JOBS_SCOPED=0` sends system jobs with no model and no
  tool list, as before.

Sub-agents (`apps/agent/src/services/subagent-service.js`):

- `lightweight: true` with no `model` runs on LITE. `SUBAGENT_LIGHTWEIGHT_MODEL=FLASH`
  rolls that back. `FLASH` is the default, `PRO` only when asked.
- Tool loops per run: 20, or 50 when the allowlist names browser tools or the
  run is PRO (`metadata.maxToolLoops`; the agent's browser escalation still
  applies). `SUBAGENT_MAX_TOOL_LOOPS` and `SUBAGENT_MAX_TOOL_LOOPS_BROWSER`
  change the two caps; `MAX_TOOL_LOOPS` does not apply to sub-agents.
- A result longer than `SUBAGENT_RESULT_CAP` (4,000 chars; 0 disables) is
  compressed by LITE with MINIMAL thinking, tag `subagent_summary`. The full
  text is kept in `subagents.result_full`; `getAgentResult(taskId, full: true)`
  returns it. That call runs after the run's own timeout, so it carries its own
  30-second bound; on timeout the result is cut at the cap instead.
- Pass `model` when code parses the reply. A lightweight run defaults to LITE,
  which is free to add prose around JSON; the trip weather sub-agent in
  `wardrobe-service.js` asks for FLASH for that reason.
- Sub-agent turns do not ask for thought parts.

Watch in `token_usage`: cost per day and model for `chat_id LIKE 'system_%'`,
and `tag = 'subagent_summary'`. The `job` and `subagent` tags arrive with the
usage-attribution change.

## Pricing table and cost tracking

`CONSTANTS.PRICING` in `config-service.js` holds one row per id. `calculateCost`
looks for an exact row first. Ids that are missing fall through a name heuristic
(`tts`, `embedding`, `image` split on `pro`/flash, `live`, `pro`, `lite`, then
flash). Add a row whenever you add an id; the heuristic is a guess.

Rules applied by `calculateCost`:

- cached input tokens cost 10% of the input rate;
- thinking tokens cost the output rate;
- image models bill image output tokens at the image rate and text output tokens
  at `outputText`, using `usageMetadata.candidatesTokensDetails`. Without that
  split all output is billed at the image rate;
- the `gemini-3.8-live` row uses the audio rates, since Live is voice. Text-only
  turns are over-counted until Live usage is split by modality.

## Smoke check

`apps/agent/scripts/model-smoke.js` makes one real call per role with the ids
the agent resolves. Run it inside the agent container, from `/app/apps/agent` or
the repo root:

```bash
node scripts/model-smoke.js              # all roles, no image
node scripts/model-smoke.js --with-image # also generates one image (~$0.07)
node scripts/model-smoke.js --only LITE,FLASH --checks get,text
node scripts/model-smoke.js --json
```

On the device: open a shell in the `agent` container from the Balena dashboard
or with `balena ssh <device-uuid> agent`; `GOOGLE_API_KEY` is already in the
container env.

Per role it runs:

| Check | Roles | Passes when |
|---|---|---|
| `get` | all | `models.get` returns the id |
| `text` | ROUTER LITE FLASH SEARCH PRO | a 20-token reply has text (lowest thinking level the model accepts) |
| `tools` | same | the model calls `getTime`, then answers a `functionResponse` with text |
| `thinking` | same | text at the role level: ROUTER/LITE MINIMAL, FLASH/SEARCH LOW, PRO HIGH; prints `thoughtsTokenCount` |
| `tts` | TTS | an `inlineData` part with an `audio/*` mime type |
| `image` | IMAGE | an `inlineData` part with an `image/*` mime type (needs `--with-image`) |
| `embed` | EMBEDDING | `values.length === EMBEDDING_DIMENSIONS` |
| `live` | LIVE | `authTokens.create` with `liveConnectConstraints` returns a name starting `auth_tokens/` |

Roles that share an id share the call. The output is a table with latency,
tokens, thought tokens and an estimated cost; the exit code is 1 on any failure,
2 on bad arguments or a missing key. A full run without the image costs about
one cent. The script does not write to `token_usage`.

Run it before and after every id change. A retired id fails at `get` with a 404.

## SDK

The agent calls Gemini through `@google/genai` 2.22.0 (`apps/agent/package.json`).
The 2.0.0 major only broke the Interactions API, which Deedee does not use.
Every call passes its options under `config`; the SDK drops any other key
without a warning. The SDK can retry HTTP 408, 429 and 5xx (five attempts, one
second doubling up to sixty), but only when the client is built with
`httpOptions: { retryOptions }`. Deedee does not set it: every `new GoogleGenAI`
passes only `apiKey`. So `_retryCall` in `apps/agent/src/agent.js` is the only
retry layer. If SDK retries are wanted later, add
`httpOptions: { retryOptions: { attempts: 2 } }` at the constructors and lower
`MAX_RETRIES` in `_retryCall`, or the two loops nest and the worst-case wait
grows.

After a bump, run the smoke inside the agent container on the device:

```bash
node scripts/model-smoke.js --with-image
```

Every check must pass and the agent boot log must show no SDK warnings. To roll
back, revert `apps/agent/package.json` and `package-lock.json` and redeploy.

## Changing the embedding model

`rag-service.js` stores the embedding model id and the dimension count in the
`rag_metadata` table of `rag.db`.

Where `rag.db` lives: `$DATA_DIR/rag.db`. The `agent` service in
`docker-compose.yml` sets `DATA_DIR=/app/data`, the `agent-data` volume. Before
this, `rag.db` sat under the container's working directory and was rebuilt on
every release, so the model-change path below never ran. The first boot after
this change builds a fresh index under the volume (one full embed of all
documents); later boots reuse it.

- Dimensions change: all vectors are cleared at start and re-embedded by the
  next scan (existing behaviour).
- Model id changes, dimensions do not: vectors from two models do not share a
  space, so the whole index needs re-embedding. At start the agent keeps the old
  id in `rag_metadata`, creates a `rag_reindex_required` notification ("RAG index
  needs re-embedding for model X") and runs `reindexAll` in the background.
  Search quality dips while it runs.
- `reindexAll` works document by document. A document keeps its old chunks
  until all its new ones embedded, so a failed call never drops content from
  vector or keyword search. Each embedding call gets 3 tries with backoff
  (0.5 s, 1 s), at most 3 calls in flight. One run at a time: a second caller
  joins the running one, and the nightly scan skips while it runs.
- When every document succeeded it records the new id and posts
  `rag_reindex_complete`. If any document failed it keeps the old id, posts
  `rag_reindex_failed` with the counts, and the next agent start retries.
- Manual trigger: the `reindexEmbeddings` tool, or a `rag_metadata` edit.
- Switching `GEMINI_EMBEDDING_MODEL` on the device: do it after the release
  that carries this section has deployed, or the re-embed runs on a `rag.db`
  that the next release throws away.

Budget the re-embed before switching: chunk count × average chunk tokens ×
$0.20 per million. `getStats()` (the `/system` page) shows the chunk count.

## Live

`POST /live/token` (`apps/agent/src/routes/live.js`) mints an ephemeral token
with `client.authTokens.create`: v1alpha, one use, 30 minutes, locked to the
LIVE model and to AUDIO. The `/live` page opens the
`v1beta ... BidiGenerateContentConstrained` socket with it and sends a setup
message with the Agent's Live prompt (`apps/agent/src/prompts/live.js`), the
voice and the tool list. The smoke's `live` check makes the same call. Details
in `docs/interfaces.md`, "Gemini Live".

## Thinking levels

Only the eager media extraction sends `thinkingLevel` today (MINIMAL on LITE).
Per-role levels in `ConfigService` are a later change; the smoke uses the
planned mapping above. `gemini-3.7-flash`, `gemini-3.8-flash` and the Pro
models reject MINIMAL.

## Watch after a change

For a week, run the usage report inside the agent container:

```bash
node scripts/usage-report.js            # last 7 days, by day, model and tag
node scripts/usage-report.js --days 30  # baseline before a change
node scripts/usage-report.js --json
```

It reads `data/agent.db` read-only (`--db` for another path) and prints:

- cost, average prompt, cached ratio and average thoughts by day, model and
  tag, most expensive first;
- the prompt composition estimates (`sys_tokens_est`, `tools_tokens_est`,
  `history_tokens_est`, `decl_count`) by tag and model. They are JSON length
  divided by 4 of the system instruction, the function declarations and the
  history sent; the API's `prompt_tokens` stays the billed number;
- the `prefix_hash` metric: one row per turn, value 1 when the system
  instruction or the declared tool names differ from the chat's previous
  turn. After a session's first turn it should stay at 0; a run of 1s means
  the implicit cache prefix moves every turn.

Tags on the main chat path: `chat`, `job` (scheduler), `subagent`, `watcher`,
each with a `_tool_loop` suffix on the calls that follow tool results. Other
tags name their call site (`router`, `title`, `tts`, `wardrobe_*`, ...).
Rows with a NULL tag predate the attribution change. The stats page cost
breakdown (`/v1/stats/cost-by-tag`) treats main-path tags like NULL: it sorts
those rows into WhatsApp, Web Chat, Jobs or Sub-agents by `chat_id`.

Expect only the new ids, daily cost within about 25% of the prior week, and no
`model_failure` or `rag_reindex_failed` notifications.
