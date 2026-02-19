/**
 * Tests for Browser V2 — Interactions
 */

const { handleClick, handleType, handleFillForm, handleSelect, handleHover, handleScroll, handlePressKey } = require('../src/interactions');

// Mock state module
jest.mock('../src/state', () => {
    const mockLocator = {
        scrollIntoViewIfNeeded: jest.fn().mockResolvedValue(),
        click: jest.fn().mockResolvedValue(),
        dblclick: jest.fn().mockResolvedValue(),
        fill: jest.fn().mockResolvedValue(),
        pressSequentially: jest.fn().mockResolvedValue(),
        press: jest.fn().mockResolvedValue(),
        selectOption: jest.fn().mockResolvedValue(),
        hover: jest.fn().mockResolvedValue(),
        setChecked: jest.fn().mockResolvedValue(),
        getAttribute: jest.fn().mockResolvedValue(null),
    };

    return {
        refLocator: jest.fn().mockReturnValue(mockLocator),
        _mockLocator: mockLocator, // expose for test assertions
    };
});

const { refLocator, _mockLocator: mockLocator } = require('../src/state');

const mockPage = {
    waitForLoadState: jest.fn().mockResolvedValue(),
    mouse: { wheel: jest.fn().mockResolvedValue() },
    keyboard: { press: jest.fn().mockResolvedValue() },
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Interactions', () => {
    describe('handleClick', () => {
        test('should click by ref', async () => {
            const result = await handleClick(mockPage, { ref: 'e1' });
            expect(refLocator).toHaveBeenCalledWith(mockPage, 'e1');
            expect(mockLocator.click).toHaveBeenCalled();
            expect(result.success).toBe(true);
        });

        test('should support double-click', async () => {
            await handleClick(mockPage, { ref: 'e1', doubleClick: true });
            expect(mockLocator.dblclick).toHaveBeenCalled();
        });

        test('should support button option', async () => {
            await handleClick(mockPage, { ref: 'e1', button: 'right' });
            expect(mockLocator.click).toHaveBeenCalledWith(expect.objectContaining({ button: 'right' }));
        });

        test('should auto-wait after click', async () => {
            await handleClick(mockPage, { ref: 'e1' });
            expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 2000 });
        });
    });

    describe('handleType', () => {
        test('should fill text by ref', async () => {
            const result = await handleType(mockPage, { ref: 'e2', text: 'hello' });
            expect(mockLocator.fill).toHaveBeenCalledWith('hello', { timeout: 5000 });
            expect(result.success).toBe(true);
        });

        test('should type slowly when specified', async () => {
            await handleType(mockPage, { ref: 'e2', text: 'hello', slowly: true });
            expect(mockLocator.click).toHaveBeenCalled();
            expect(mockLocator.pressSequentially).toHaveBeenCalledWith('hello', { delay: 80 });
        });

        test('should press Enter when submit is true', async () => {
            await handleType(mockPage, { ref: 'e2', text: 'hello', submit: true });
            expect(mockLocator.press).toHaveBeenCalledWith('Enter');
        });
    });

    describe('handleFillForm', () => {
        test('should fill multiple fields', async () => {
            const result = await handleFillForm(mockPage, {
                fields: [
                    { ref: 'e1', value: 'John' },
                    { ref: 'e2', value: 'john@example.com' },
                ],
            });
            expect(result.success).toBe(true);
            expect(result.results).toHaveLength(2);
        });

        test('should error on missing fields array', async () => {
            await expect(handleFillForm(mockPage, {})).rejects.toThrow(/fields must be an array/);
        });
    });

    describe('handleSelect', () => {
        test('should select option by ref', async () => {
            const result = await handleSelect(mockPage, { ref: 'e3', values: 'option1' });
            expect(mockLocator.selectOption).toHaveBeenCalledWith(['option1'], { timeout: 5000 });
            expect(result.success).toBe(true);
        });

        test('should support multiple values', async () => {
            await handleSelect(mockPage, { ref: 'e3', values: ['a', 'b'] });
            expect(mockLocator.selectOption).toHaveBeenCalledWith(['a', 'b'], { timeout: 5000 });
        });
    });

    describe('handleHover', () => {
        test('should hover by ref', async () => {
            const result = await handleHover(mockPage, { ref: 'e1' });
            expect(mockLocator.hover).toHaveBeenCalled();
            expect(result.success).toBe(true);
        });
    });

    describe('handleScroll', () => {
        test('should scroll to ref', async () => {
            const result = await handleScroll(mockPage, { ref: 'e1' });
            expect(mockLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
            expect(result.success).toBe(true);
        });

        test('should scroll page down by default', async () => {
            const result = await handleScroll(mockPage, {});
            expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 600);
            expect(result.message).toContain('down');
        });

        test('should scroll page up', async () => {
            await handleScroll(mockPage, { direction: 'up' });
            expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, -600);
        });
    });

    describe('handlePressKey', () => {
        test('should press keyboard key', async () => {
            const result = await handlePressKey(mockPage, { key: 'Enter' });
            expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
            expect(result.success).toBe(true);
        });
    });
});
