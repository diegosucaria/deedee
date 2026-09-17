# Gemini model roles

Deedee calls Gemini through nine roles. Each role is one env var, read once at
agent start by `apps/agent/src/services/config-service.js` (`CONSTANTS.MODELS`).
Code asks for a role, never for an id: `configService.getModel('FLASH')`.

| Role | Env var | Default id | Used for | $/1M tokens in → out |
|---|---|---|---|---|
| ROUTER | `ROUTER_MODEL` | `gemini-3.1-flash-lite` | picks FLASH or PRO and the tool mode per message | 0.25 → 1.50 |
| LITE | `WORKER_LITE` | `gemini-3.1-flash-lite` | transcription, image descriptions, tool scoping, summaries | 0.25 → 1.50 |
| FLASH | `WORKER_FLASH` | `gemini-3.6-flash` | main chat, tool loops, sub-agents, most services | 0.75 → 3.75 |
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
| `thinking` | same | text at the smoke's role level (ROUTER/LITE MINIMAL, FLASH/SEARCH LOW, PRO HIGH); prints `thoughtsTokenCount`. Runtime levels: "Thinking levels" below |
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

Every text call asks `ConfigService.getThinking(role, callClass, { source, model })`
for its `thinkingLevel` and `includeThoughts`. Before this, the main chat call
sent no level, so Pro thought at HIGH on every turn and paid for it as output.
Image, TTS, embedding and Live calls do not take part.

Defaults (`THINKING_DEFAULTS` in `config-service.js`):

| Role | Class | Level |
|---|---|---|
| ROUTER, LITE | all (`router`, `scoper`, `cron_helper`, `eager_extract`) | MINIMAL |
| SEARCH | `search` (the googleSearch polyfill) | LOW |
| FLASH | `chat`, `tool_loop`, `job`, `subagent`, `watcher`, `coding`, `wardrobe`, `impersonation` | LOW |
| FLASH | `summarization`, `title`, `scoper`, `people_enrich`, `cron_helper`, `analysis`, `transcribe`, `partner_greeting`, `dj`, `impersonation_learn`, any other | MINIMAL |
| PRO | `tool_loop`, `dream`, `pruning`, `dj`, any other | LOW |
| PRO | `chat`, `job`, `subagent`, `consolidation`, `wardrobe`, `impersonation` | MEDIUM |
| PRO | `coding` | HIGH |

PRO `chat` sits at MEDIUM because the router sends only deep work to Pro:
Terraform, GCP, Kubernetes, planning, analysis, history search. LOW there made
those turns thinner than they were before this change.

Call classes for the main agent turn: `coding` on a code signal, else
`subagent` when `metadata.isSubAgent`, `job` when `source` is `scheduler`,
`watcher` for watcher alerts, else `chat`. The code signal is the `code` tool
group on the session, the router asking for `code`, or a message that says
`shell`, `git`, `repo`, `repository` or `codebase` as a word
(`GROUP_NAME_WORDS` in `services/tool-groups.js`). Sub-agents and jobs never
get scoped groups, so for them the signal is the router's pick and their own
prompt; a sub-agent sent to change the repo thinks at `coding`, not `subagent`.
Jobs and watcher runs keep their own class either way. The group keeps its name
for 30 minutes per chat, like every other group. Today it changes the thinking
class only: the shell and file tools stay core until tool deferral moves them
behind `code`. Tool-loop turns of a `chat` session use `tool_loop`, one step
down at LOW; the other classes keep their level through the loop.
When the loop level differs from the session level the agent re-sends the full
session config on each loop call (the SDK replaces, not merges, a per-call
config).

Env overrides, read on every call, so a Balena variable is the rollback:

- `THINKING_<ROLE>` sets every class of that role, not only the ones missing
  from the table: `THINKING_PRO=HIGH` raises chat, jobs, dream and pruning at
  once.
- `THINKING_<ROLE>_<CLASS>` sets one class (`THINKING_PRO_TOOL_LOOP=MEDIUM`,
  `THINKING_FLASH_TITLE=LOW`). The class part is the class name in upper case.
- Values: `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`. Anything else is ignored with one
  warning.

Guard (`MODEL_THINKING_LEVELS`): `gemini-3.1-pro*`, `gemini-3-pro*`,
`gemini-3.8-flash`, `gemini-3.7-flash` accept LOW/MEDIUM/HIGH;
`gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-3-flash-preview` accept all four. A level the model lacks is raised to
the lowest it accepts and logged once per model and level. Ids outside the
3.x family get no `thinkingLevel` at all (they take `thinkingBudget`, and the
two keys together are a 400). Nothing here ever sets `thinkingBudget`.

`includeThoughts` is true only when `source` is `web` or `live`: only the web
UI renders `agent:thought`. WhatsApp, Telegram, Slack, iOS, scheduler and
sub-agent turns get none, which also keeps thought text out of stored parts.
Billing follows the full thought tokens either way; the level is the cost lever.

Measure with `AVG(thoughts_tokens)` per `tag` in `token_usage`: Pro `chat`
should sit well under 1k per turn, `router`, `title` and `summarization` near
zero. If Pro tool planning gets worse, set `THINKING_PRO_TOOL_LOOP=MEDIUM`.

## Watch after a change

For a week, run this against `data/agent.db`:

```sql
SELECT model, tag, COUNT(*), SUM(thoughts_tokens) * 1.0 / SUM(candidate_tokens), SUM(estimated_cost)
FROM token_usage WHERE timestamp > date('now', '-7 day') GROUP BY 1, 2;
```

Expect only the new ids, daily cost within about 25% of the prior week, and no
`model_failure` or `rag_reindex_failed` notifications.
