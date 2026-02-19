# Spec 041: Agentic Browser V2 (Moltbot-Inspired Overhaul)

## Why The Current Browser Fails

DeeDee's browser MCP (`packages/mcp-servers/browser/index.js`, 1041 lines) has these critical failures:

### 1. CSS Selectors Break On Real Sites
`browser_click` takes a CSS selector string. The agent hallucinates selectors, uses `:contains()` (not valid CSS), and modern SPAs use dynamic class names. The fallback chain (force click → text locator) still fails frequently.

### 2. Vision Click Is Fragile & Expensive
`browser_click_vision_annotated` works like this:
1. Inject yellow numbered labels into the DOM
2. Take a screenshot
3. Remove labels from DOM
4. Send screenshot to Gemini Vision API asking "which label matches this description?"
5. Parse JSON response for `labelIndex`
6. Find element by `data-agent-label-id` attribute
7. Click it

**Problems:** Labels shift layout. Gemini Vision can misidentify labels. The DOM mutation (inject→screenshot→remove) is race-prone. It costs a full Vision API call per click. And the `data-agent-label-id` attribute may be gone by the time we try to click.

### 3. No Page Structure Awareness
`browser_get_accessibility_tree` returns raw JSON — a massive blob the agent can't reason about efficiently. No refs, no interactive element identification, no way to act on what it sees.

### 4. No Wait/Retry For SPAs  
No `browser_wait` tool. After clicking a button that triggers a page transition, the agent immediately tries to read a page that hasn't loaded yet.

### 5. One-Field-At-A-Time
Filling a 5-field form requires 10 tool calls (click + type for each). No batch fill.

---

## What OpenClaw Does Differently (And What We Steal)

### The Core Idea: ARIA Snapshots + Refs

OpenClaw's **game-changing** concept: Use Playwright's built-in `locator.ariaSnapshot()` to get the page's accessibility tree as a text string, then assign short refs (`e1`, `e2`, ...) to interactive elements. The agent reads the tree, picks a ref, and all subsequent tools use that ref.

**File: `pw-role-snapshot.ts` (435 lines)**
- Parses Playwright's ARIA snapshot output (text-based, indented tree)
- Classifies roles: `INTERACTIVE_ROLES` (button, textbox, link, checkbox, etc.), `CONTENT_ROLES` (heading, cell, etc.), `STRUCTURAL_ROLES` (generic, group)
- Only interactive + named content elements get refs
- Handles duplicate role+name with `nth` index tracking
- Has `compact` mode that prunes empty branches (keeps only paths to refs)

**Result looks like:**
```
- heading "Book Your Flight" [level=1]
  - textbox "From" [ref=e1]
  - textbox "To" [ref=e2]  
  - combobox "Class" [ref=e3]
  - button "Search Flights" [ref=e4]
- navigation "Main"
  - link "Sign In" [ref=e5]
  - link "Help" [ref=e6]
```

### Ref Resolution: `refLocator()` (pw-session.ts:475-512)

The magic is in how refs resolve to Playwright locators:
```javascript
// OpenClaw's approach:
function refLocator(page, ref) {
  const info = pageState.roleRefs[ref]; // { role: 'textbox', name: 'From', nth: 0 }
  if (!info) throw new Error(`Unknown ref "${ref}". Run a new snapshot.`);
  
  const locator = info.name
    ? page.getByRole(info.role, { name: info.name, exact: true })
    : page.getByRole(info.role);
  
  return info.nth !== undefined ? locator.nth(info.nth) : locator;
}
```

**Why this is superior:**
- `getByRole` is **semantic**, not CSS-based — survives class name changes
- `exact: true` prevents matching the wrong element
- `nth` handles duplicates (e.g., two "Submit" buttons → `e4` and `e7 [nth=1]`)
- The ref map is stored in memory, so refs persist between tool calls within the same page

### Ref-Based Interactions (pw-tools-core.interactions.ts, 647 lines)

All interactions use the same pattern:
```javascript
const locator = refLocator(page, ref);
await locator.fill(text);  // or .click(), .selectOption(), etc.
```

Key functions we steal:
- **`clickViaPlaywright`**: Ref-based, supports doubleClick, button (left/right/middle), modifiers (Shift, Ctrl)
- **`typeViaPlaywright`**: Ref-based, `fill()` by default (fast), `type()` with delay for "slowly" mode, optional `submit` (presses Enter)
- **`fillFormViaPlaywright`**: Batch — takes `[{ ref, type, value }]`, handles checkboxes/radios via `setChecked()`
- **`selectOptionViaPlaywright`**: Ref-based dropdown selection
- **`waitForViaPlaywright`**: Wait for text, textGone, URL, loadState, or custom JS function
- **`screenshotWithLabelsViaPlaywright`**: Gets bounding boxes for all refs, overlays labels on screenshot (without mutating DOM — uses a fixed-position overlay div), then cleans up

### Session State Management (pw-session.ts, 797 lines)

OpenClaw manages per-page state:
- `roleRefs` stored per page in a WeakMap
- `roleRefsByTarget` Map caches refs by CDP target ID — so refs survive page object recreation
- `restoreRoleRefsForTarget()` called before every interaction to ensure refs are available
- `storeRoleRefsForTarget()` called after every snapshot to persist refs

**We adapt this for DeeDee's simpler single-page model** (one persistent browser context, one active page).

---

## Implementation Plan

### Architecture
Keep the existing MCP server structure (`packages/mcp-servers/browser/index.js`), but:
1. Extract logic into focused modules under `packages/mcp-servers/browser/src/`
2. Replace CSS selector tools with ref-based tools
3. Keep vision as a fallback (improved)
4. **Keep existing: CDP screencast, secrets, profile management**

```
packages/mcp-servers/browser/
├── index.js              # MCP server entry (slimmed down)
├── src/
│   ├── snapshot.js        # ARIA snapshot → ref map (from pw-role-snapshot.ts)
│   ├── interactions.js    # Ref-based click/type/fill/select (from pw-tools-core.interactions.ts)
│   ├── wait.js            # Wait conditions (from pw-tools-core.interactions.ts)
│   ├── vision.js          # Annotated screenshot (improved from current + pw-tools-core.interactions.ts)
│   ├── screencast.js      # CDP screencast logic (extracted from current index.js)
│   └── state.js           # Page state + ref storage (from pw-session.ts)
```

### CDP Screencast → Live Browser View (PRESERVED)

The current CDP screencast system that streams JPEG frames to the chat UI via Socket.io **must be preserved exactly as-is**. This is one of DeeDee's killer features.

The existing code (lines 160-204 of current `index.js`) will be extracted into `src/screencast.js` but the behavior is unchanged:
1. Connect to Interfaces via Socket.io on startup
2. Start CDP `Page.startScreencast` (JPEG, quality 50, max 800px width)
3. On each `Page.screencastFrame` event, emit `browser:frame` to Socket.io
4. Ack each frame to keep the stream alive

The web UI already consumes these frames — **no changes needed on the frontend**.

### Phase 1: Snapshot Engine (`src/snapshot.js`)

**Port from:** `pw-role-snapshot.ts` → JavaScript, adapted for DeeDee.

Core function:
```javascript
async function getPageSnapshot(page, options = {}) {
  // 1. Use Playwright's ariaSnapshot (available in Playwright 1.49+)
  const ariaText = await page.locator('body').ariaSnapshot();
  
  // 2. Parse into tree with refs (ported from buildRoleSnapshotFromAriaSnapshot)
  const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(ariaText, {
    interactive: options.interactiveOnly || false,
    compact: options.compact !== false,  // compact by default
    maxDepth: options.maxDepth
  });
  
  return { snapshot, refs, url: page.url(), title: await page.title() };
}
```

**What we port from OpenClaw:**
- `INTERACTIVE_ROLES`, `CONTENT_ROLES`, `STRUCTURAL_ROLES` sets
- `buildRoleSnapshotFromAriaSnapshot()` — the main parser
- `createRoleNameTracker()` — handles duplicate role+name with nth
- `compactTree()` — prunes branches without refs
- `removeNthFromNonDuplicates()` — cleaner output

### Phase 2: State Management (`src/state.js`)

Simple adaptation since DeeDee uses a single page (no multi-tab management needed initially):

```javascript
// Module-level state (DeeDee has one page at a time)
let currentRefs = {};     // ref → { role, name, nth }
let currentUrl = '';

function storeRefs(refs, url) {
  currentRefs = refs;
  currentUrl = url;
}

function refLocator(page, ref) {
  const info = currentRefs[ref];
  if (!info) {
    throw new Error(`Unknown ref "${ref}". Call browser_snapshot first to get current refs.`);
  }
  const locator = info.name
    ? page.getByRole(info.role, { name: info.name, exact: true })
    : page.getByRole(info.role);
  return info.nth !== undefined ? locator.nth(info.nth) : locator;
}
```

### Phase 3: Interaction Tools (`src/interactions.js`)

Port from OpenClaw's `pw-tools-core.interactions.ts`:

| OpenClaw Function | DeeDee Tool | What We Port |
|---|---|---|
| `clickViaPlaywright` | `browser_click` | Ref-based, double-click, button, modifiers |
| `typeViaPlaywright` | `browser_type` | Ref-based, fill vs slow type, submit option |
| `fillFormViaPlaywright` | `browser_fill_form` | Batch `[{ ref, value }]`, checkbox/radio support |
| `selectOptionViaPlaywright` | `browser_select` | Ref-based dropdown |
| `pressKeyViaPlaywright` | `browser_press_key` | Keyboard keys (Enter, Tab, Escape) |
| `hoverViaPlaywright` | `browser_hover` | Ref-based hover |
| `scrollIntoViewViaPlaywright` | `browser_scroll` | Ref-based scroll |

### Phase 4: Wait Tool (`src/wait.js`)

Port directly from `waitForViaPlaywright`:
```javascript
// browser_wait tool
async function handleWait(page, args) {
  const timeout = Math.min(args.timeout || 30000, 60000);
  
  if (args.timeMs) await page.waitForTimeout(Math.min(args.timeMs, 10000));
  if (args.text) await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
  if (args.textGone) await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
  if (args.url) await page.waitForURL(args.url, { timeout });
  if (args.loadState) await page.waitForLoadState(args.loadState, { timeout });
  
  return { success: true, url: page.url() };
}
```

### Phase 5: Improved Vision Fallback (`src/vision.js`)

Steal OpenClaw's `screenshotWithLabelsViaPlaywright` approach instead of the current DOM injection:

**Current (broken):** Inject labels into DOM → screenshot → remove labels → click by attribute
**New (from OpenClaw):** Get bounding boxes from ref locators → overlay fixed-position labels → screenshot → remove overlay → agent uses ref to click

```javascript
async function screenshotWithLabels(page, refs) {
  // 1. Get bounding boxes for all refs (no DOM mutation)
  const boxes = [];
  for (const [ref, info] of Object.entries(refs)) {
    try {
      const locator = refLocator(page, ref);
      const box = await locator.boundingBox();
      if (box) {
        boxes.push({ ref, x: box.x, y: box.y, w: box.width, h: box.height });
      }
    } catch { /* skip invisible elements */ }
  }
  
  // 2. Inject overlay (fixed-position, pointer-events: none — doesn't affect layout!)
  await page.evaluate((labels) => {
    const root = document.createElement('div');
    root.setAttribute('data-deedee-labels', '1');
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    // ... draw boxes + tags (from OpenClaw's screenshotWithLabelsViaPlaywright)
    document.documentElement.appendChild(root);
  }, boxes);
  
  // 3. Screenshot
  const buffer = await page.screenshot();
  
  // 4. Clean up
  await page.evaluate(() => {
    document.querySelectorAll('[data-deedee-labels]').forEach(el => el.remove());
  });
  
  return { image: buffer, labelCount: boxes.length };
}
```

**Key difference from current:** Labels are `pointer-events: none` and don't shift layout. The agent already has refs from the snapshot — the labeled screenshot is just visual confirmation. No Vision API needed to identify which label to click.

### Phase 6: Smart Defaults

**Auto-snapshot after navigate:** When `browser_navigate` returns, include a compact snapshot in the response. Saves a round-trip.

**Auto-wait after click:** After `browser_click`, wait for `domcontentloaded` (max 2s, don't fail). Prevents reading stale pages.

### Phase 7: Update Aerolineas Argentinas Skill

The `aerolineas-argentinas` skill (`apps/agent/skills/aerolineas-argentinas/SKILL.md`) explicitly references the old browser tools (`browser_click_vision_annotated`, CSS selector-based `browser_type`). It **must** be updated to use the new ref-based workflow:

**Current (SKILL.md lines 41-52):**
```
- Type the city name (e.g. "Buenos Aires").
- Wait for the dropdown to appear.
- Click the correct airport from the list using `browser_click_vision_annotated`.
- Use `browser_click_vision_annotated` and `browser_type` precisely.
```

**Updated:**
```
- Use `browser_snapshot` to see the flight search form and get refs.
- Use `browser_type` with the ref for the origin field (e.g. ref=e1).
- Use `browser_wait` with `text` to wait for the autocomplete dropdown.
- Use `browser_snapshot` again to see the dropdown options.
- Use `browser_click` with the ref for the correct airport.
- Use `browser_fill_form` for passenger details (batch fill DNI, name, email, phone).
- Use `browser_fill_secret` with ref for credit card fields.
```

**Also update `references/checkout_guide.md`** to remove CSS selector references (`#passenger-form`) and replace with ref-based instructions.

**Also update the duplicate skill dir** (`apps/agent/skills/aerolineas/SKILL.md`) if it still exists, or remove it.

---

## Tool Definitions (Final)

### Navigation
| Tool | Input | Description |
|---|---|---|
| `browser_navigate` | `url`, `waitUntil?` | Go to URL. Returns title + compact snapshot. |
| `browser_snapshot` | `interactiveOnly?`, `compact?` | Get ARIA tree with refs. **The primary tool.** |
| `browser_screenshot` | `fullPage?`, `withLabels?` | Screenshot. With labels = annotated with ref IDs. |
| `browser_extract_text` | - | Page text as markdown. |

### Interaction (Ref-Based)
| Tool | Input | Description |
|---|---|---|
| `browser_click` | `ref`, `doubleClick?`, `button?` | Click by ref. |
| `browser_type` | `ref`, `text`, `submit?`, `slowly?` | Type into element by ref. `submit` presses Enter. |
| `browser_fill_form` | `fields: [{ ref, value }]` | Fill multiple fields at once. |
| `browser_select` | `ref`, `values` | Select dropdown option(s) by ref. |
| `browser_press_key` | `key` | Press keyboard key (Enter, Escape, Tab). |
| `browser_hover` | `ref` | Hover by ref. |
| `browser_scroll` | `ref?`, `direction?` | Scroll to ref or scroll page. |

### Waiting
| Tool | Input | Description |
|---|---|---|
| `browser_wait` | `text?`, `textGone?`, `url?`, `loadState?`, `timeMs?` | Wait for condition. |

### Advanced
| Tool | Input | Description |
|---|---|---|
| `browser_evaluate` | `script` | Run JS on page. |
| `browser_fill_secret` | `ref`, `secretKey` | Type secret by ref. |
| `browser_list_secrets` | - | List secret keys. |

### Removed
- `browser_click_vision` — replaced by ref-based click
- `browser_click_vision_annotated` — replaced by `browser_screenshot --withLabels` + ref-based click

---

## Migration & Backward Compatibility

1. Old `browser_click` with CSS selectors is **replaced** by ref-based `browser_click`. The agent prompt is updated to guide usage.
2. Old `browser_type` with CSS selectors is **replaced** by ref-based `browser_type`.
3. `browser_get_accessibility_tree` is **replaced** by `browser_snapshot` (better output format).
4. Existing persistent profile dirs, CDP screencast, and secrets system are **preserved**.
5. `browser_navigate`, `browser_screenshot`, `browser_extract_text`, `browser_run_script` keep working with enhancements.

## System Prompt Update

```
## Browser Strategy
1. ALWAYS start with `browser_snapshot` to see the page structure and get refs.
2. Use refs (e1, e2, ...) for click, type, fill, select — NEVER use CSS selectors.
3. Use `browser_fill_form` for multi-field forms instead of typing one at a time.
4. Use `browser_wait` after actions that trigger page changes.
5. If a ref doesn't work, call `browser_snapshot` again — the page may have changed.
6. Use `browser_screenshot --withLabels` for visual verification when unsure.
```

## Files Changed

| File | Action | Description |
|---|---|---|
| `packages/mcp-servers/browser/index.js` | REWRITE | Slim entry, delegates to modules |
| `packages/mcp-servers/browser/src/snapshot.js` | NEW | ARIA snapshot → ref map (from `pw-role-snapshot.ts`) |
| `packages/mcp-servers/browser/src/interactions.js` | NEW | Ref-based interactions (from `pw-tools-core.interactions.ts`) |
| `packages/mcp-servers/browser/src/wait.js` | NEW | Wait primitives (from `pw-tools-core.interactions.ts`) |
| `packages/mcp-servers/browser/src/vision.js` | NEW | Labeled screenshots (from `screenshotWithLabelsViaPlaywright`) |
| `packages/mcp-servers/browser/src/state.js` | NEW | Ref storage (from `pw-session.ts`, simplified) |
| `apps/agent/src/prompts/system.js` | MODIFY | Update browser strategy |
| `apps/agent/src/tools-definition.js` | MODIFY | Update browser tool schemas |
| `apps/agent/skills/aerolineas-argentinas/SKILL.md` | MODIFY | Update to ref-based browser tools |
| `apps/agent/skills/aerolineas-argentinas/references/checkout_guide.md` | MODIFY | Remove CSS selectors, use refs |

## Testing
- **Unit**: Test snapshot parsing, ref assignment, nth tracking, compact mode (port `pw-role-snapshot.test.ts`).
- **Integration**: Navigate to `httpbin.org/forms/post` → snapshot → fill form → submit → verify.
- **E2E**: "Search Google for DeeDee" → navigate → snapshot → type → click → extract results.
- **Manual**: Book a flight on Google Flights → multi-step form fill + date picker + dropdown.

## Playwright Version Requirement
`ariaSnapshot()` requires **Playwright ≥ 1.49**. Current DeeDee uses Playwright via `packages/mcp-servers/browser/package.json`. Must verify version and upgrade if needed.
