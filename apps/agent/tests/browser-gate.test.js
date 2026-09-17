/**
 * Browser gate after taint (owner decision A, "gate submit only"): logins,
 * typing and searching run; paying, ordering, sending, deleting and booking
 * ask, including Enter pressed inside such a form.
 */
const path = require('path');
const { BrowserPageState, browserAction, parseSnapshot, consequenceHit } = require('../src/utils/browser-gate');

// The shape @playwright/mcp returns: `browser_snapshot` inline, actions as a file link.
const PAGE = `- generic [active] [ref=e1]:
  - heading "Shop" [level=1] [ref=e2]
  - form "Sign in" [ref=e3]:
    - textbox "Email" [ref=e4]
    - textbox "Password" [ref=e5]
    - button "Sign in" [ref=e6]
  - form [ref=e7]:
    - generic [ref=e8]:
      - text: Card number
      - textbox "Card number" [ref=e9]
    - button "Continue" [ref=e10]
  - search [ref=e20]:
    - searchbox "Search products" [ref=e21]
  - button "Pay $20" [ref=e11]
  - link "Next page" [ref=e12]`;

function snapshotResult(yaml, url = 'https://shop.example/checkout') {
    return { output: `### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\`` };
}

function actionResult(url = 'https://shop.example/checkout', extra = '') {
    return { output: `### Ran Playwright code\n\`\`\`js\nawait page.click()\n\`\`\`\n### Page\n- Page URL: ${url}\n${extra}` };
}

function freshPage(yaml = PAGE) {
    const state = new BrowserPageState();
    state.observe('browser_snapshot', {}, snapshotResult(yaml));
    return state;
}

describe('snapshot parsing', () => {
    test('roles, names and refs, with indentation', () => {
        const nodes = parseSnapshot(PAGE);
        expect(nodes.find(n => n.ref === 'e6')).toMatchObject({ role: 'button', name: 'Sign in', indent: 4 });
        expect(nodes.find(n => n.role === 'text')).toMatchObject({ name: 'Card number', ref: null });
    });

    test('label words', () => {
        for (const l of ['Pay $20', 'Buy now', 'Place order', 'Send', 'Post', 'Transfer', 'Delete', 'Cancel booking', 'Pagar', 'Enviar', 'Confirmar compra', 'Book now']) {
            expect(consequenceHit(l)).toBe(true);
        }
        for (const l of ['Sign in', 'Next', 'Continue', 'Search', 'Send code', 'Resend verification link', 'Enviar código', 'Payment methods', 'Facebook', 'Posts', 'Cancel']) {
            expect(consequenceHit(l)).toBe(false);
        }
    });
});

describe('owner decision A: gate submit only', () => {
    test('a login flow (type, type, click sign in) runs with no approval', () => {
        const state = freshPage();
        expect(browserAction('browser_type', { target: 'e4', element: 'Email', text: 'EMAIL_SECRET' }, state)).toBeNull();
        state.observe('browser_type', { target: 'e4', element: 'Email', text: 'EMAIL_SECRET' }, actionResult());
        expect(browserAction('browser_type', { target: 'e5', element: 'Password', text: 'PASSWORD_SECRET' }, state)).toBeNull();
        state.observe('browser_type', { target: 'e5', element: 'Password', text: 'PASSWORD_SECRET' }, actionResult());
        expect(browserAction('browser_click', { target: 'e6', element: 'Sign in button' }, state)).toBeNull();
        // Enter in the password field submits the sign-in form: also free.
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toBeNull();
        expect(browserAction('browser_type', { target: 'e5', text: 'x', submit: true }, state)).toBeNull();
    });

    test('a pay click asks, even when the model describes the button as something else', () => {
        const state = freshPage();
        expect(browserAction('browser_click', { target: 'e11', element: 'Continue button' }, state)).toMatch(/click "Pay \$20"/);
        expect(browserAction('browser_click', { target: 'e11' }, state)).toMatch(/Pay \$20/);
    });

    test('a generic Continue inside a card form asks; Next page and search run', () => {
        const state = freshPage();
        expect(browserAction('browser_click', { target: 'e10', element: 'Continue' }, state)).toMatch(/form that pays/);
        expect(browserAction('browser_click', { target: 'e12', element: 'Next page' }, state)).toBeNull();
        state.observe('browser_type', { target: 'e21', text: 'shoes' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toBeNull();
    });

    test('Enter inside a payment form asks like its submit button', () => {
        const state = freshPage();
        state.observe('browser_type', { target: 'e9', element: 'Card number', text: '4111' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toMatch(/press Enter in a web form that pays/);
        expect(browserAction('browser_press_key', { key: 'NumpadEnter' }, state)).toMatch(/form that pays/);
        expect(browserAction('browser_type', { target: 'e9', text: '4111', submit: true }, state)).toMatch(/form that pays/);
    });

    test('a form with no name is judged by its fields and buttons', () => {
        const state = freshPage(`- form [ref=e1]:
  - textbox "To" [ref=e2]
  - textbox "Message" [ref=e3]
  - button "Send" [ref=e4]`);
        state.observe('browser_type', { target: 'e3', text: 'hi' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toMatch(/form that pays, orders, sends/);
    });

    test('without a form element, the nearest group holding a button decides', () => {
        const state = freshPage(`- main [ref=e1]:
  - generic [ref=e2]:
    - textbox "Username" [ref=e3]
    - button "Next" [ref=e4]
  - generic [ref=e5]:
    - textbox "Amount" [ref=e6]
    - button "Transfer" [ref=e7]`);
        state.observe('browser_type', { target: 'e3', text: 'u' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toBeNull();
        state.observe('browser_type', { target: 'e6', text: '100' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toMatch(/form that pays/);
    });

    test('Tab then Enter: focus is unknown, so the page decides', () => {
        const state = freshPage();
        state.observe('browser_type', { target: 'e4', text: 'x' }, actionResult());
        state.observe('browser_press_key', { key: 'Tab' }, actionResult());
        expect(state.focus).toBeNull();
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toMatch(/focus unknown/);
        expect(browserAction('browser_press_key', { key: ' ' }, state)).toMatch(/focus unknown/);
        // A page with nothing to pay or send lets it through.
        const login = freshPage(`- form "Sign in" [ref=e1]:
  - textbox "Email" [ref=e2]
  - button "Next" [ref=e3]`);
        login.observe('browser_press_key', { key: 'Tab' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, login)).toBeNull();
    });

    test('Enter or Space with focus on a pay button (after a click) asks; Space in a field runs', () => {
        const state = freshPage();
        // The owner approved a click on it earlier; focus stays on the button.
        state.observe('browser_click', { target: 'e11' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).toMatch(/Pay \$20/);
        expect(browserAction('browser_press_key', { key: 'Space' }, state)).toMatch(/Pay \$20/);
        state.observe('browser_type', { target: 'e4', text: 'x' }, actionResult());
        expect(browserAction('browser_press_key', { key: ' ' }, state)).toBeNull();
    });

    test('Ctrl+Enter and Cmd+Enter are send shortcuts and ask', () => {
        const state = freshPage();
        state.observe('browser_type', { target: 'e21', text: 'x' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Control+Enter' }, state)).toMatch(/send shortcut/);
        expect(browserAction('browser_press_key', { key: 'Meta+Enter' }, state)).toMatch(/send shortcut/);
    });

    test('a field the gate never saw: login and search descriptions run, others ask', () => {
        const state = new BrowserPageState();
        expect(browserAction('browser_type', { target: 'e7', element: 'Password field', text: 'x', submit: true }, state)).toBeNull();
        expect(browserAction('browser_type', { target: 'e7', element: 'Card number', text: 'x', submit: true }, state)).toMatch(/Card number/);
        expect(browserAction('browser_type', { target: 'e7', element: 'Comment box', text: 'x', submit: true }, state)).toMatch(/not seen/);
    });

    test('a navigation clears the old refs, so a stale ref is not trusted', () => {
        const state = freshPage();
        state.observe('browser_click', { target: 'e12' }, actionResult('https://shop.example/page/2'));
        expect(state.node('e11')).toBeNull();
        expect(state.focus).toBeNull();
    });

    test('dialogs: a consequence message asks, a harmless one runs, dismissing always runs', () => {
        const state = freshPage();
        state.observe('browser_click', { target: 'e12' }, actionResult('https://shop.example/checkout', '### Modal state\n- ["confirm" dialog with message "Delete account?"]: can be handled by browser_handle_dialog'));
        expect(browserAction('browser_handle_dialog', { accept: true }, state)).toMatch(/Delete account/);
        expect(browserAction('browser_handle_dialog', { accept: false }, state)).toBeNull();
        state.observe('browser_handle_dialog', { accept: false }, actionResult());
        state.observe('browser_click', { target: 'e12' }, actionResult('https://shop.example/checkout', '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by browser_handle_dialog'));
        expect(browserAction('browser_handle_dialog', { accept: true }, state)).toBeNull();
        expect(browserAction('browser_handle_dialog', { accept: true }, new BrowserPageState())).toMatch(/not seen/);
    });

    test('an action result links its snapshot file; the gate reads it relative to the server directory', () => {
        const read = jest.fn(() => PAGE);
        const state = new BrowserPageState({ baseDir: '/srv/agent', readFile: read });
        state.observe('browser_click', { target: 'e12' }, { output: '### Page\n- Page URL: https://shop.example/\n### Snapshot\n- [Snapshot](../data/browser_profile/output/page-2026-01-01T00-00-00-000Z.yml)' });
        expect(read).toHaveBeenCalledWith(path.resolve('/srv/agent', '../data/browser_profile/output/page-2026-01-01T00-00-00-000Z.yml'));
        expect(browserAction('browser_click', { target: 'e11', element: 'button' }, state)).toMatch(/Pay/);
        // Only page-*.yml links are read.
        state.observe('browser_snapshot', {}, { output: '### Snapshot\n- [Snapshot](../../etc/other.yml)' });
        expect(read).toHaveBeenCalledTimes(1);
    });
});
