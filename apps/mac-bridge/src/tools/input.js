const robot = require('robotjs');

// Actions
const actions = {
    moveMouse: async ({ x, y }) => {
        robot.moveMouse(x, y);
    },
    click: async ({ button = 'left' }) => {
        // robotjs uses "left", "right", "middle"
        robot.mouseClick(button, false); // doubleClick=false
    },
    type: async ({ text }) => {
        robot.typeString(text);
    },
    pressKey: async ({ keys }) => {
        // robotjs keyTap(key, modifier[])
        // Parsing keys: robotjs expects lowercase "command", "alt", "control", "shift"
        // And simple chars like "a", "enter", "backspace"
        if (keys.length === 0) return;

        const modifiers = keys.slice(1).map(k => k.toLowerCase().replace('cmd', 'command'));
        const key = keys[0].toLowerCase();

        robot.keyTap(key, modifiers);
    },
    scroll: async ({ amount }) => {
        robot.scrollMouse(0, amount);
    }
};

const macInputTool = {
    name: "mac_input",
    description: "Control Mac Mouse/Keyboard. Supports: moveMouse(x,y), click(button), type(text), pressKey(keys[] - first is key, others modifiers), scroll(amount).",
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["moveMouse", "click", "type", "pressKey", "scroll"],
                description: "Action to perform"
            },
            x: { type: "number" },
            y: { type: "number" },
            button: { type: "string", enum: ["left", "right", "middle"] },
            text: { type: "string" },
            keys: { type: "array", items: { type: "string" }, description: "Ex: ['enter', 'command']" },
            amount: { type: "number" }
        },
        required: ["action"]
    },
    handler: async (args) => {
        const { action } = args;
        if (!actions[action]) throw new Error(`Unknown action: ${action}`);

        try {
            await actions[action](args);
            return { content: [{ type: 'text', text: `Performed ${action}` }] };
        } catch (e) {
            return { isError: true, content: [{ type: 'text', text: `Action ${action} failed: ${e.message}` }] };
        }
    }
};

module.exports = { macInputTool };
