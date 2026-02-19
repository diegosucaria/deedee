/**
 * Browser V2 — Ref-Based Interactions
 * All interactions resolve refs via state.refLocator().
 * Ported from OpenClaw's pw-tools-core.interactions.ts.
 */

const { refLocator } = require('./state');

/**
 * Click an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, doubleClick?, button?, modifiers? }
 */
async function handleClick(page, args) {
    const locator = refLocator(page, args.ref);

    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });

    const clickOptions = { timeout: 5000 };
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
}

/**
 * Type text into an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref, text, submit?, slowly?, clear? }
 */
async function handleType(page, args) {
    const locator = refLocator(page, args.ref);

    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });

    if (args.slowly) {
        // Click to focus, then type character by character
        await locator.click({ timeout: 3000 });
        if (args.clear !== false) {
            await locator.fill('', { timeout: 2000 }).catch(() => { });
        }
        await locator.pressSequentially(args.text, { delay: 80 });
    } else {
        // Fast fill (replaces existing content)
        await locator.fill(args.text, { timeout: 5000 });
    }

    if (args.submit) {
        await locator.press('Enter');
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
    }

    return { success: true, message: `Typed into ref=${args.ref}` };
}

/**
 * Fill multiple form fields at once.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { fields: [{ ref, value, type? }] }
 */
async function handleFillForm(page, args) {
    if (!args.fields || !Array.isArray(args.fields)) {
        throw new Error('fields must be an array of { ref, value }');
    }

    const results = [];

    for (const field of args.fields) {
        const locator = refLocator(page, field.ref);

        try {
            await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });

            // Handle checkboxes/radios differently
            const role = (await locator.getAttribute('role').catch(() => null)) ||
                (await locator.getAttribute('type').catch(() => null));

            if (role === 'checkbox' || role === 'switch' || field.type === 'checkbox') {
                const shouldCheck = field.value === true || field.value === 'true' || field.value === 'on';
                await locator.setChecked(shouldCheck, { timeout: 3000 });
            } else if (role === 'radio' || field.type === 'radio') {
                await locator.check({ timeout: 3000 });
            } else {
                await locator.fill(String(field.value), { timeout: 5000 });
            }

            results.push({ ref: field.ref, success: true });
        } catch (err) {
            results.push({ ref: field.ref, success: false, error: err.message });
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
 * @param {Object} args - { ref, values }
 */
async function handleSelect(page, args) {
    const locator = refLocator(page, args.ref);
    const values = Array.isArray(args.values) ? args.values : [args.values];

    await locator.selectOption(values, { timeout: 5000 });
    return { success: true, message: `Selected [${values.join(', ')}] in ref=${args.ref}` };
}

/**
 * Hover over an element by ref.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref }
 */
async function handleHover(page, args) {
    const locator = refLocator(page, args.ref);
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
    await locator.hover({ timeout: 5000 });
    return { success: true, message: `Hovered ref=${args.ref}` };
}

/**
 * Scroll to an element (by ref) or scroll the page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { ref?, direction? }
 */
async function handleScroll(page, args) {
    if (args.ref) {
        const locator = refLocator(page, args.ref);
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
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
}

/**
 * Press a keyboard key.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { key }
 */
async function handlePressKey(page, args) {
    await page.keyboard.press(args.key);
    await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => { });
    return { success: true, message: `Pressed ${args.key}` };
}

module.exports = {
    handleClick,
    handleType,
    handleFillForm,
    handleSelect,
    handleHover,
    handleScroll,
    handlePressKey,
};
