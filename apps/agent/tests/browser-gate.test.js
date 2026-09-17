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
        for (const l of ['Pay $20', 'Buy now', 'Place order', 'Send', 'Post', 'Transfer', 'Delete', 'Cancel booking', 'Pagar', 'Enviar mensaje', 'Confirmar compra', 'Book now', 'Submit payment', 'Make payment', 'Confirm deletion', 'Subscribe', 'Comment', 'Invite', 'Confirm cancellation']) {
            expect(consequenceHit(l)).toBe(true);
        }
        for (const l of ['Sign in', 'Next', 'Continue', 'Search', 'Send code', 'Resend verification link', 'Enviar código', 'Payment methods', 'Facebook', 'Posts', 'Cancel', 'Enviar', 'Reenviar código', 'Comments']) {
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
        expect(browserAction('browser_type', { target: 'e7', element: 'Notes box', text: 'x', submit: true }, state)).toMatch(/not seen/);
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

    test('"\n" and "\r" are Enter to Playwright, alone and with a modifier', () => {
        const state = freshPage();
        state.observe('browser_type', { target: 'e9', text: '4111' }, actionResult());
        for (const key of ['\n', '\r', 'Shift+\n', 'Shift+\r']) {
            expect(browserAction('browser_press_key', { key }, state)).toMatch(/web form that pays/);
        }
        expect(browserAction('browser_press_key', { key: 'Control+\n' }, state)).toMatch(/send shortcut/);
        expect(browserAction('browser_press_key', { key: '\n' }, new BrowserPageState())).toMatch(/not seen/);
        // In a login field the same keys run.
        state.observe('browser_type', { target: 'e5', text: 'x' }, actionResult());
        expect(browserAction('browser_press_key', { key: '\n' }, state)).toBeNull();
    });

    test('typing slowly presses Enter for each newline in the text', () => {
        const state = freshPage();
        expect(browserAction('browser_type', { target: 'e9', element: 'Card number', text: '4111\n', slowly: true }, state)).toMatch(/web form that pays/);
        expect(browserAction('browser_type', { target: 'e9', element: 'Card number', text: '4111\r', slowly: true }, state)).toMatch(/web form that pays/);
        expect(browserAction('browser_type', { target: 'e9', element: 'Card number', text: '4111', slowly: true }, state)).toBeNull();
        // Filled at once, a newline is just text.
        expect(browserAction('browser_type', { target: 'e9', element: 'Card number', text: '4111\n' }, state)).toBeNull();
        expect(browserAction('browser_type', { target: 'e5', element: 'Password', text: 'x\n', slowly: true }, state)).toBeNull();
    });

    test('a button inside a form with payment fields asks whatever its label says', () => {
        const state = freshPage(`- generic [ref=e1]:
  - form "Checkout" [ref=e2]:
    - textbox "Card number" [ref=e3]
    - textbox "CVV" [ref=e4]
    - button "Submit payment" [ref=e5]
    - button "Make payment" [ref=e6]
    - button "Finish it" [ref=e10]
    - button "Back" [ref=e11]
  - button "Confirm deletion" [ref=e7]
  - button "Comment" [ref=e8]
  - button "Subscribe" [ref=e9]
  - link "Home" [ref=e12]`);
        for (const target of ['e5', 'e6', 'e7', 'e8', 'e9', 'e10']) {
            expect(browserAction('browser_click', { target }, state)).not.toBeNull();
        }
        expect(browserAction('browser_click', { target: 'e11' }, state)).toBeNull();
        expect(browserAction('browser_click', { target: 'e12' }, state)).toBeNull();
    });

    test('a selector target is not matched to the snapshot, so the model cannot call Pay "Continue"', () => {
        const state = freshPage(`- generic [ref=e1]:
  - form "Checkout" [ref=e2]:
    - button "Pay $500" [ref=e9]`);
        expect(browserAction('browser_click', { target: 'e9', element: 'Continue' }, state)).toMatch(/Pay/);
        expect(browserAction('browser_click', { target: '#btn-1' }, state)).toMatch(/cannot match/);
        expect(browserAction('browser_click', { target: '#pay' }, state)).toMatch(/#pay/);
        expect(browserAction('browser_click', { target: 'button:has-text("Pay")', element: 'Continue' }, state)).toMatch(/Pay/);
        expect(browserAction('browser_click', { target: '#go' }, new BrowserPageState())).toMatch(/not seen/);
        // Enter after a selector click on that page asks too.
        state.observe('browser_click', { target: '#card' }, actionResult());
        expect(browserAction('browser_press_key', { key: 'Enter' }, state)).not.toBeNull();
        // On a page with nothing to pay, a selector click runs.
        const plain = freshPage(`- generic [ref=e1]:
  - link "Next page" [ref=e2]`);
        expect(browserAction('browser_click', { target: 'a.next' }, plain)).toBeNull();
    });

    test('a Spanish login whose submit says "Enviar" runs; "Enviar mensaje" asks', () => {
        const state = freshPage(`- generic [ref=e1]:
  - generic [ref=e3]:
    - textbox "Usuario" [ref=e4]
    - textbox "Contraseña" [ref=e5]
    - button "Enviar" [ref=e6]`);
        expect(browserAction('browser_click', { target: 'e6', element: 'Enviar' }, state)).toBeNull();
        expect(browserAction('browser_type', { target: 'e5', text: 'x', submit: true }, state)).toBeNull();
        const msg = freshPage(`- generic [ref=e1]:
  - generic [ref=e3]:
    - textbox "Mensaje" [ref=e4]
    - button "Enviar mensaje" [ref=e6]`);
        expect(browserAction('browser_click', { target: 'e6' }, msg)).toMatch(/Enviar mensaje/);
        expect(browserAction('browser_type', { target: 'e4', text: 'x', submit: true }, msg)).toMatch(/web form/);
    });

    test('a bank login with an account or card number is not a payment form', () => {
        const state = freshPage(`- generic [ref=e1]:
  - generic [ref=e3]:
    - textbox "Account number" [ref=e4]
    - textbox "Password" [ref=e5]
    - button "Continue" [ref=e6]`);
        expect(browserAction('browser_type', { target: 'e5', text: 'x', submit: true }, state)).toBeNull();
        expect(browserAction('browser_click', { target: 'e6', element: 'Continue' }, state)).toBeNull();
        // A card form with a CVV still asks, password field or not.
        const card = freshPage(`- generic [ref=e1]:
  - generic [ref=e3]:
    - textbox "Card number" [ref=e4]
    - textbox "CVV" [ref=e5]
    - textbox "PIN" [ref=e7]
    - button "Continue" [ref=e6]`);
        expect(browserAction('browser_click', { target: 'e6', element: 'Continue' }, card)).toMatch(/web form/);
    });

    test('a login next to footer or share buttons runs: the page is not the form', () => {
        const page = freshPage(`- banner [ref=e1]:
  - link "Home" [ref=e2]
- main [ref=e3]:
  - textbox "Email" [ref=e5]
  - button "Continue" [ref=e6]
- contentinfo [ref=e7]:
  - textbox "Your email" [ref=e8]
  - button "Subscribe" [ref=e9]
  - button "Share" [ref=e10]`);
        expect(browserAction('browser_click', { target: 'e6', element: 'Continue' }, page)).toBeNull();
        expect(browserAction('browser_type', { target: 'e5', text: 'x', submit: true }, page)).toBeNull();
        // The footer button itself still asks.
        expect(browserAction('browser_click', { target: 'e9' }, page)).toMatch(/Subscribe/);

        const wrapped = freshPage(`- generic [ref=e1]:
  - textbox "Email" [ref=e2]
  - textbox "Password" [ref=e3]
  - button "Sign in" [ref=e4]
  - button "Share" [ref=e5]`);
        expect(browserAction('browser_type', { target: 'e3', text: 'x', submit: true }, wrapped)).toBeNull();
        wrapped.observe('browser_type', { target: 'e3', text: 'x' }, { output: '### Page\n- Page URL: https://shop.example/checkout' });
        expect(browserAction('browser_press_key', { key: 'Enter' }, wrapped)).toBeNull();

        const nested = freshPage(`- generic [ref=e1]:
  - generic [ref=e2]:
    - textbox "Email" [ref=e3]
    - textbox "Password" [ref=e4]
    - button "Sign in" [ref=e5]
    - button "Share" [ref=e6]
  - button "Continue" [ref=e7]`);
        expect(browserAction('browser_type', { target: 'e4', text: 'x', submit: true }, nested)).toBeNull();
    });

    test('a compose, contact or post form asks on a bare "Enviar", "Submit" or Enter', () => {
        const compose = freshPage(`- generic [ref=e1]:
  - dialog "Mensaje nuevo" [ref=e2]:
    - combobox "Para" [ref=e3]
    - textbox "Asunto" [ref=e4]
    - textbox "Cuerpo del mensaje" [ref=e6]
    - button "Enviar" [ref=e5]`);
        expect(browserAction('browser_click', { target: 'e5' }, compose)).toMatch(/Enviar/);
        compose.observe('browser_type', { target: 'e6', text: 'x' }, { output: '### Page\n- Page URL: https://shop.example/checkout' });
        expect(browserAction('browser_press_key', { key: 'Enter' }, compose)).toMatch(/web form/);

        const contact = freshPage(`- generic [ref=e1]:
  - form "Contact us" [ref=e2]:
    - textbox "Your message" [ref=e3]
    - button "Submit" [ref=e4]`);
        expect(browserAction('browser_click', { target: 'e4' }, contact)).toMatch(/Submit/);
        expect(browserAction('browser_type', { target: 'e3', text: 'x', submit: true }, contact)).toMatch(/web form/);

        const form = freshPage(`- generic [ref=e1]:
  - form [ref=e2]:
    - textbox "Nombre" [ref=e3]
    - button "Enviar" [ref=e4]`);
        expect(browserAction('browser_click', { target: 'e4' }, form)).toMatch(/Enviar/);

        const social = freshPage(`- generic [ref=e1]:
  - article [ref=e2]:
    - button "Retweet" [ref=e3]
    - button "Repost" [ref=e4]`);
        expect(browserAction('browser_click', { target: 'e3' }, social)).toMatch(/Retweet/);
        expect(browserAction('browser_click', { target: 'e4' }, social)).toMatch(/Repost/);

        // A flat page with no form around the button still judges the page's fields.
        const flat = freshPage(`- generic [ref=e1]:
  - textbox "To" [ref=e2]
  - textbox "Message" [ref=e3]
  - button "Continue" [ref=e4]`);
        expect(browserAction('browser_click', { target: 'e4' }, flat)).toMatch(/web form/);
        // A search form's "Submit" runs.
        const search = freshPage(`- generic [ref=e1]:
  - form [ref=e2]:
    - textbox "Search" [ref=e3]
    - button "Submit" [ref=e4]`);
        expect(browserAction('browser_click', { target: 'e4' }, search)).toBeNull();
    });

    test('the real link shape: relative to the server cwd, resolved when the link is read', () => {
        const read = jest.fn(() => PAGE);
        let cwd = null;
        const state = new BrowserPageState({ baseDir: () => cwd, readFile: read });
        cwd = '/app/apps/agent';
        state.observe('browser_navigate', { url: 'https://shop.example/' }, { output: '### Page\n- Page URL: https://shop.example/\n### Snapshot\n- [Snapshot](../../data/browser_profile/output/page-1.yml)' });
        expect(read).toHaveBeenCalledWith('/app/data/browser_profile/output/page-1.yml');
        expect(state.hasPage).toBe(true);
    });

    test('the agent resolves links against the cwd the manager spawned the browser in', () => {
        const { Agent } = require('../src/agent');
        const self = { mcp: { configPath: '/app/data/mcp_config.json', serverCwds: { browser: '/app/apps/agent' } } };
        expect(Agent.prototype._browserServerDir.call(self)).toBe('/app/apps/agent');
        expect(Agent.prototype._browserServerDir.call({ mcp: { serverCwds: {} } })).toBeNull();
    });
});
