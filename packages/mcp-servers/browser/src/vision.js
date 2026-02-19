/**
 * Browser V2 — Vision (Labeled Screenshots)
 * Improved approach: overlay labels via fixed-position div (no DOM mutation).
 * Labels are drawn using bounding boxes from ref locators.
 */

const { getCurrentRefs, refLocator } = require('./state');

/**
 * Take a screenshot with ref labels overlaid.
 * Uses fixed-position overlay (pointer-events: none) — does NOT shift layout.
 *
 * @param {import('playwright').Page} page
 * @returns {{ image: Buffer, labelCount: number }}
 */
async function screenshotWithLabels(page) {
    const refs = getCurrentRefs();

    // 1. Get bounding boxes for all refs
    const boxes = [];
    for (const [ref, info] of Object.entries(refs)) {
        try {
            const locator = refLocator(page, ref);
            const box = await locator.boundingBox({ timeout: 1000 });
            if (box && box.width > 0 && box.height > 0) {
                boxes.push({ ref, x: box.x, y: box.y, w: box.width, h: box.height });
            }
        } catch {
            // Skip invisible or detached elements
        }
    }

    // 2. Clean existing overlays and inject new one (fixed-position, pointer-events: none)
    await page.evaluate(() => {
        document.querySelectorAll('[data-deedee-labels]').forEach(el => el.remove());
    });
    await page.evaluate((labels) => {
        const root = document.createElement('div');
        root.setAttribute('data-deedee-labels', '1');
        root.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';

        for (const { ref, x, y, w, h } of labels) {
            // Border around element
            const border = document.createElement('div');
            border.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:2px solid #FF6B35;border-radius:3px;`;
            root.appendChild(border);

            // Label tag
            const tag = document.createElement('div');
            tag.textContent = ref;
            tag.style.cssText = `position:absolute;left:${x}px;top:${Math.max(0, y - 18)}px;background:#FF6B35;color:white;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:2px;font-family:monospace;`;
            root.appendChild(tag);
        }

        document.documentElement.appendChild(root);
    }, boxes);

    // 3. Screenshot
    const buffer = await page.screenshot({ fullPage: false });

    // 4. Remove overlay
    await page.evaluate(() => {
        document.querySelectorAll('[data-deedee-labels]').forEach(el => el.remove());
    });

    return { image: buffer, labelCount: boxes.length };
}

module.exports = { screenshotWithLabels };
