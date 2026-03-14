/**
 * Browser V2 — ARIA Snapshot Engine
 * Parses Playwright's ariaSnapshot() output into a tree with refs.
 * Ported from OpenClaw's pw-role-snapshot.ts, adapted for DeeDee.
 */

const { storeRefs } = require('./state');

// Role classification
const INTERACTIVE_ROLES = new Set([
    'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'scrollbar',
    'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
    'treeitem',
]);

const CONTENT_ROLES = new Set([
    'heading', 'img', 'cell', 'columnheader', 'rowheader', 'caption',
    'definition', 'term', 'tooltip', 'status', 'alert', 'log', 'marquee',
    'timer', 'math', 'figure', 'meter', 'progressbar', 'separator',
]);

const STRUCTURAL_ROLES = new Set([
    'generic', 'group', 'list', 'listitem', 'menu', 'menubar', 'navigation',
    'tablist', 'tabpanel', 'toolbar', 'tree', 'treegrid', 'grid', 'row',
    'rowgroup', 'table', 'region', 'article', 'banner', 'complementary',
    'contentinfo', 'form', 'main', 'search', 'application', 'dialog',
    'alertdialog', 'document', 'feed', 'note', 'presentation', 'none',
    'directory', 'paragraph', 'blockquote', 'insertion', 'deletion',
    'emphasis', 'strong', 'subscript', 'superscript', 'code', 'time',
]);

/**
 * Parse Playwright's ariaSnapshot text output into a tree.
 * Format: indented lines like:
 *   - role "name" [attr=value]:
 *     - childrole "childname"
 *
 * @param {string} text - Raw ariaSnapshot output
 * @returns {Array} parsed tree nodes
 */
function parseAriaSnapshot(text) {
    if (!text || !text.trim()) return [];

    const lines = text.split('\n');
    const root = { children: [], indent: -1 };
    const stack = [root];

    for (const line of lines) {
        if (!line.trim() || !line.trim().startsWith('-')) continue;

        // Calculate indent level (number of leading spaces / 2)
        const indent = (line.length - line.trimStart().length) / 2;
        const content = line.trim().replace(/^-\s*/, '');

        const node = parseLine(content);
        node.indent = indent;
        node.children = [];

        // Find parent: walk up stack until we find a node with less indent
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        stack[stack.length - 1].children.push(node);
        stack.push(node);
    }

    return root.children;
}

/**
 * Parse a single line into a node object.
 * Examples:
 *   'heading "Book Your Flight" [level=1]'
 *   'textbox "From"'
 *   'link "Sign In"'
 *   'button "Search"'
 *   'text: "some content"'
 *   'generic:'
 *
 * @param {string} content - Line content without leading "- "
 * @returns {Object} { role, name, attrs }
 */
function parseLine(content) {
    // Handle text content nodes: 'text: "some value"' or just '"some text"'
    if (content.startsWith('text:') || content.startsWith('"')) {
        const textMatch = content.match(/"([^"]*)"/);
        return { role: 'text', name: textMatch ? textMatch[1] : content, isText: true };
    }

    // Parse: role "name" [attr1=val1] [attr2=val2]:
    const roleMatch = content.match(/^(\w+)/);
    const role = roleMatch ? roleMatch[1] : 'unknown';

    // Extract quoted name
    const nameMatch = content.match(/"([^"]*)"/);
    const name = nameMatch ? nameMatch[1] : '';

    // Extract attributes in brackets
    const attrs = {};
    const attrMatches = content.matchAll(/\[(\w+)=([^\]]+)\]/g);
    for (const m of attrMatches) {
        attrs[m[1]] = m[2];
    }

    // Check for trailing colon (indicates container)
    const isContainer = content.endsWith(':');

    return { role, name, attrs, isContainer };
}

/**
 * Create a tracker for duplicate role+name combinations.
 * When two elements have the same role+name, nth indices are assigned.
 */
function createRoleNameTracker() {
    const counts = {};    // "role:name" → count seen so far
    const nthMap = {};    // "role:name" → array of ref IDs

    return {
        /**
         * Track a role+name combo and return the nth index if duplicate.
         * @returns {{ nth: number|undefined, isDuplicate: boolean }}
         */
        track(role, name) {
            const key = `${role}:${name}`;
            if (!counts[key]) {
                counts[key] = 0;
                nthMap[key] = [];
            }
            const nth = counts[key];
            counts[key]++;
            nthMap[key].push(nth);

            return { nth, isDuplicate: counts[key] > 1 };
        },

        /**
         * After all tracking, remove nth from non-duplicates.
         * If a role+name was only seen once, nth is unnecessary.
         */
        cleanNonDuplicates(refs) {
            for (const [key, indices] of Object.entries(nthMap)) {
                if (indices.length === 1) {
                    // Find the ref that has this role+name and remove nth
                    for (const ref of Object.keys(refs)) {
                        const info = refs[ref];
                        if (`${info.role}:${info.name}` === key && info.nth === 0) {
                            delete info.nth;
                        }
                    }
                }
            }
        }
    };
}

/**
 * Assign refs (e1, e2, ...) to interactive and named content elements.
 *
 * @param {Array} tree - Parsed tree nodes
 * @param {Object} options
 * @param {boolean} options.interactiveOnly - Only assign refs to interactive elements
 * @returns {{ tree: Array, refs: Object }} Tree with refs + ref map
 */
function assignRefs(tree, options = {}) {
    const refs = {};
    let counter = 1;
    const tracker = createRoleNameTracker();

    function walk(nodes) {
        for (const node of nodes) {
            if (node.isText) continue;

            const shouldRef =
                INTERACTIVE_ROLES.has(node.role) ||
                (!options.interactiveOnly && CONTENT_ROLES.has(node.role) && node.name);

            if (shouldRef) {
                const ref = `e${counter++}`;
                const { nth } = tracker.track(node.role, node.name);

                refs[ref] = { role: node.role, name: node.name, nth };

                node.ref = ref;
            }

            if (node.children && node.children.length > 0) {
                walk(node.children);
            }
        }
    }

    walk(tree);

    // Clean up: remove nth from non-duplicates
    tracker.cleanNonDuplicates(refs);

    return { tree, refs };
}

/**
 * Compact tree: prune branches that contain no refs.
 * Keeps only structural paths leading to ref'd elements.
 *
 * @param {Array} tree - Tree with refs assigned
 * @returns {Array} Compacted tree
 */
function compactTree(tree) {
    function hasRefs(node) {
        if (node.ref) return true;
        if (node.children) {
            return node.children.some(hasRefs);
        }
        return false;
    }

    function prune(nodes) {
        return nodes
            .filter(node => {
                // Keep text nodes if they're under a ref'd parent (handled by parent)
                if (node.isText) return true;
                // Keep if this node or any descendant has a ref
                return node.ref || hasRefs(node);
            })
            .map(node => {
                if (node.children && node.children.length > 0) {
                    return { ...node, children: prune(node.children) };
                }
                return node;
            });
    }

    return prune(tree);
}

/**
 * Render tree back to indented text format for the agent.
 *
 * @param {Array} tree - Tree nodes
 * @param {number} depth - Current indent depth
 * @param {number} [maxDepth] - Max tree depth to render (undefined = unlimited)
 * @returns {string} Formatted text
 */
function renderTree(tree, depth = 0, maxDepth) {
    const lines = [];
    const indent = '  '.repeat(depth);

    for (const node of tree) {
        if (node.isText) {
            if (node.name && node.name.trim()) {
                lines.push(`${indent}- text: "${node.name.slice(0, 200)}"`);
            }
            continue;
        }

        let line = `${indent}- ${node.role}`;
        if (node.name) line += ` "${node.name.slice(0, 120)}"`;

        // Add attributes
        if (node.attrs) {
            for (const [k, v] of Object.entries(node.attrs)) {
                line += ` [${k}=${v}]`;
            }
        }

        // Add ref
        if (node.ref) line += ` [ref=${node.ref}]`;

        lines.push(line);

        if (node.children && node.children.length > 0) {
            // Respect maxDepth: skip rendering children beyond limit
            if (maxDepth !== undefined && depth + 1 >= maxDepth) {
                const childRefCount = countRefs(node.children);
                if (childRefCount > 0) {
                    lines.push(`${indent}  - ... (${childRefCount} more refs inside)`);
                }
            } else {
                lines.push(renderTree(node.children, depth + 1, maxDepth));
            }
        }
    }

    return lines.join('\n');
}

/**
 * Count refs in a subtree (used for depth-limited rendering).
 */
function countRefs(nodes) {
    let count = 0;
    for (const node of nodes) {
        if (node.ref) count++;
        if (node.children) count += countRefs(node.children);
    }
    return count;
}

/**
 * Get page snapshot: the main entry point.
 *
 * @param {import('playwright').Page} page
 * @param {Object} options
 * @param {boolean} options.interactiveOnly - Only show interactive elements
 * @param {boolean} options.compact - Prune empty branches (default: true)
 * @param {string} [options.frameSelector] - Optional iframe to inspect
 * @param {number} [options.maxChars=20000] - Truncate output to prevent context blowout
 * @param {number} [options.maxDepth] - Max tree depth to render (undefined = unlimited)
 * @returns {{ snapshot: string, refs: Object, url: string, title: string }}
 */
async function getPageSnapshot(page, options = {}) {
    const compact = options.compact !== false;
    const maxChars = options.maxChars || 20000;
    const maxDepth = options.maxDepth;
    const frameSelector = (options.frameSelector || '').trim();

    let ariaText = '';
    const root = frameSelector ? page.frameLocator(frameSelector).locator('body') : page.locator('body');

    try {
        // Use Playwright's ariaSnapshot (≥1.49)
        ariaText = await root.ariaSnapshot();
    } catch (err) {
        console.warn(`[BrowserV2] ariaSnapshot failed (frameSelector: "${frameSelector}"):`, err.message);
        return {
            snapshot: `Failed to capture snapshot. ${err.message}`,
            refs: {},
            url: page.url(),
            title: await page.title().catch(() => '')
        };
    }

    // Parse into tree
    let tree = parseAriaSnapshot(ariaText);

    // Assign refs to interactive/content elements
    const { refs } = assignRefs(tree, { interactiveOnly: options.interactiveOnly });

    // Compact: prune branches without refs
    if (compact) {
        tree = compactTree(tree);
    }

    // Render to text
    let snapshot = renderTree(tree, 0, maxDepth);

    // Truncate if it exceeds maxChars
    if (snapshot.length > maxChars) {
        snapshot = snapshot.slice(0, maxChars) + '\n\n[...TRUNCATED - page too large]';
    }

    const url = page.url();
    const title = await page.title().catch(() => '');

    // Store refs for subsequent tool calls
    storeRefs(refs, url);

    return { snapshot, refs, url, title };
}

module.exports = {
    getPageSnapshot,
    parseAriaSnapshot,
    assignRefs,
    compactTree,
    renderTree,
    createRoleNameTracker,
    INTERACTIVE_ROLES,
    CONTENT_ROLES,
    STRUCTURAL_ROLES,
};
