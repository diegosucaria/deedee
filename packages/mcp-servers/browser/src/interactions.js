/**
 * Browser V2 — Ref-Based Interactions
 * All interactions resolve refs via state.refLocator().
 * Ported from OpenClaw's pw-tools-core.interactions.ts.
 */

const { refLocator } = require('./state');

/**
 * Translate raw Playwright errors into actionable advice for the agent.
 */
function toAIFriendlyError(err, ref) {
    const raw = err.message || String(err);
    if (raw.includes('TimeoutError')) {
        return `Timeout waiting for ref=${ref}. The element might not be visible or the page is too slow. Try waiting or checking if a modal is covering it.`;
    }
    if (raw.includes('intercepted')) {
        return `Action on ref=${ref} was intercepted! Another element (like a modal, overlay, or sticky header) is covering it. You must close the overlay or scroll it into view before interacting.`;
    }
    if (raw.includes('Target closed') || raw.includes('Target crashed')) {
        return `The browser page closed or crashed during the action on ref=${ref}.`;
    }
    if (raw.includes('is not attached to the DOM')) {
        return `Element ref=${ref} is no longer on the page (it was removed). You need to take a new browser_snapshot.`;
    }
    return `Failed to interact with ref=${ref}: ${raw.split('\n')[0]}`;
}

/**
 * Helper to get timeout clamped between 500ms and 60000ms.
 */
function getTimeout(ms, defaultMs = 5000) {
    if (typeof ms !== 'number' || isNaN(ms)) return defaultMs;
    return Math.max(500, Math.min(ms, 60000));
}

/**
 * Click an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, doubleClick?, button?, modifiers?, frameSelector?, timeoutMs? }
 */
async function handleClick(page, args) {
    try {
        const locator = refLocator(page, args.ref, args.frameSelector);
        const timeout = getTimeout(args.timeoutMs, 5000);

        await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 3000) }).catch(() => { });

        const clickOptions = { timeout };
        if (args.button) clickOptions.button = args.button; // 'left', 'right', 'middle'
        if (args.modifiers) clickOptions.modifiers = args.modifiers; // ['Shift', 'Control']

        if (args.doubleClick) {
            await locator.dblclick(clickOptions);
        } else {
            await locator.click(clickOptions);
        }

        // Auto-wait for potential navigation/SPA transition (non-failing)
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });

        return { success: true, message: `Clicked ref=${args.ref}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, args.ref) };
    }
}

/**
 * Type text into an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, text, submit?, slowly?, clear?, frameSelector?, timeoutMs? }
 */
async function handleType(page, args) {
    try {
        const locator = refLocator(page, args.ref, args.frameSelector);
        const timeout = getTimeout(args.timeoutMs, 5000);

        await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 3000) }).catch(() => { });

        if (args.slowly) {
            // Click to focus, then type character by character
            await locator.click({ timeout: Math.min(timeout, 3000) });
            if (args.clear !== false) {
                await locator.fill('', { timeout: 2000 }).catch(() => { });
            }
            await locator.pressSequentially(args.text, { delay: 80 });
        } else {
            // Fast fill (replaces existing content)
            await locator.fill(args.text, { timeout });
        }

        if (args.submit) {
            await locator.press('Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
        }

        return { success: true, message: `Typed into ref=${args.ref}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, args.ref) };
    }
}

/**
 * Fill multiple form fields at once.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { fields: [{ ref, value, type? }], frameSelector?, timeoutMs? }
 */
async function handleFillForm(page, args) {
    if (!args.fields || !Array.isArray(args.fields)) {
        return { success: false, message: 'fields must be an array of { ref, value }' };
    }

    const results = [];
    const timeout = getTimeout(args.timeoutMs, 5000);

    for (const field of args.fields) {
        try {
            const locator = refLocator(page, field.ref, args.frameSelector);

            await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 2000) }).catch(() => { });

            // Handle checkboxes/radios differently
            const role = (await locator.getAttribute('role').catch(() => null)) ||
                (await locator.getAttribute('type').catch(() => null));

            if (role === 'checkbox' || role === 'switch' || field.type === 'checkbox') {
                const shouldCheck = field.value === true || field.value === 'true' || field.value === 'on';
                await locator.setChecked(shouldCheck, { timeout });
            } else if (role === 'radio' || field.type === 'radio') {
                await locator.check({ timeout });
            } else {
                await locator.fill(String(field.value), { timeout });
            }

            results.push({ ref: field.ref, success: true });
        } catch (err) {
            results.push({ ref: field.ref, success: false, error: toAIFriendlyError(err, field.ref) });
        }
    }

    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
        return {
            success: false,
            message: `Filled ${results.length - failures.length}/${results.length} fields. Failed: ${failures.map(f => `${f.ref}: ${f.error}`).join('; ')}`,
            results,
        };
    }

    return { success: true, message: `Filled ${results.length} fields`, results };
}

/**
 * Select option(s) in a dropdown by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, values, frameSelector?, timeoutMs? }
 */
async function handleSelect(page, args) {
    try {
        const locator = refLocator(page, args.ref, args.frameSelector);
        const timeout = getTimeout(args.timeoutMs, 5000);
        const values = Array.isArray(args.values) ? args.values : [args.values];

        await locator.selectOption(values, { timeout });
        return { success: true, message: `Selected [${values.join(', ')}] in ref=${args.ref}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, args.ref) };
    }
}

/**
 * Hover over an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, frameSelector?, timeoutMs? }
 */
async function handleHover(page, args) {
    try {
        const locator = refLocator(page, args.ref, args.frameSelector);
        const timeout = getTimeout(args.timeoutMs, 5000);
        await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 3000) }).catch(() => { });
        await locator.hover({ timeout });
        return { success: true, message: `Hovered ref=${args.ref}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, args.ref) };
    }
}

/**
 * Scroll to an element (by ref) or scroll the page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref?, direction?, frameSelector?, timeoutMs? }
 */
async function handleScroll(page, args) {
    try {
        if (args.ref) {
            const locator = refLocator(page, args.ref, args.frameSelector);
            const timeout = getTimeout(args.timeoutMs, 5000);
            await locator.scrollIntoViewIfNeeded({ timeout });
            return { success: true, message: `Scrolled to ref=${args.ref}` };
        }

        // Scroll page directionally
        const direction = args.direction || 'down';
        const amount = 600;

        switch (direction) {
            case 'up':
                await page.mouse.wheel(0, -amount);
                break;
            case 'down':
                await page.mouse.wheel(0, amount);
                break;
            case 'left':
                await page.mouse.wheel(-amount, 0);
                break;
            case 'right':
                await page.mouse.wheel(amount, 0);
                break;
            default:
                await page.mouse.wheel(0, amount);
        }

        return { success: true, message: `Scrolled ${direction}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, args.ref || 'page') };
    }
}

/**
 * Press a keyboard key.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { key }
 */
async function handlePressKey(page, args) {
    try {
        await page.keyboard.press(args.key);
        // We do not wait for timeoutMs here as press is instantaneous, but wait for loadstate purely as a convenience
        await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => { });
        return { success: true, message: `Pressed ${args.key}` };
    } catch (err) {
        return { success: false, message: `Failed to press key ${args.key}: ${err.message}` };
    }
}

/**
 * Drag an element (startRef) and drop it on another element (endRef).
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { startRef, endRef, frameSelector?, timeoutMs? }
 */
async function handleDrag(page, args) {
    try {
        const startLocator = refLocator(page, args.startRef, args.frameSelector);
        const endLocator = refLocator(page, args.endRef, args.frameSelector);
        const timeout = getTimeout(args.timeoutMs, 10000);

        await startLocator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 3000) }).catch(() => { });
        await startLocator.dragTo(endLocator, { timeout });

        // Auto-wait for potential SPA transition
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });

        return { success: true, message: `Dragged ref=${args.startRef} to ref=${args.endRef}` };
    } catch (err) {
        return { success: false, message: toAIFriendlyError(err, `${args.startRef} -> ${args.endRef}`) };
    }
}

module.exports = {
    handleClick,
    handleType,
    handleFillForm,
    handleSelect,
    handleHover,
    handleScroll,
    handlePressKey,
    handleDrag,
    toAIFriendlyError
};
