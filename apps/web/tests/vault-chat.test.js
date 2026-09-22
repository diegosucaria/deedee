// The vault pane's half of the socket contract. The pane used to emit
// `message` and listen for `message` / `agent:typing`; nothing on the server
// answered, so the typing dots never stopped.
const fs = require('fs');
const path = require('path');
const {
    VAULT_CHAT_SEND, VAULT_CHAT_REPLY, VAULT_CHAT_THINKING,
    vaultChatId, vaultChatPayload, isStatusMessage, replyText
} = require('../src/lib/vault-chat.js');

const COMPONENT = fs.readFileSync(path.join(__dirname, '../src/components/VaultChat.js'), 'utf8');

describe('what the vault pane sends', () => {
    test('the payload carries the text in the field the server reads', () => {
        const payload = vaultChatPayload({ vaultId: 'insurance', text: 'When does it renew?' });
        expect(payload.content).toBe('When does it renew?');
        expect(payload.text).toBeUndefined();
    });

    test('the payload names the vault, so the turn searches that vault', () => {
        expect(vaultChatPayload({ vaultId: 'insurance', text: 'hi' }).metadata.vaultId).toBe('insurance');
    });

    test('one room per vault, whatever the browser', () => {
        expect(vaultChatId('insurance')).toBe('vault-insurance');
        expect(vaultChatPayload({ vaultId: 'insurance', text: 'hi' }).chatId).toBe('vault-insurance');
    });

    test('the event names are the ones the socket server uses', () => {
        expect(VAULT_CHAT_SEND).toBe('chat:message');
        expect(VAULT_CHAT_REPLY).toBe('agent:message');
        expect(VAULT_CHAT_THINKING).toBe('agent:thinking');
    });
});

describe('what the vault pane shows', () => {
    test('a progress line is not an answer', () => {
        expect(isStatusMessage('Thinking... about your question')).toBe(true);
        expect(isStatusMessage('Still working...')).toBe(true);
        expect(isStatusMessage('Action **searchDocuments**')).toBe(true);
        expect(isStatusMessage('Your policy renews in March.')).toBe(false);
    });

    test('an answer with audio still shows its text', () => {
        const data = { type: 'audio', content: 'Here is the summary.', parts: [{ inlineData: { data: 'AAA' } }] };
        expect(replyText(data)).toBe('Here is the summary.');
        expect(replyText({ content: 'plain' })).toBe('plain');
    });
});

describe('the component uses the shared names', () => {
    test('it emits and listens through the contract module', () => {
        expect(COMPONENT).toContain("from '@/lib/vault-chat'");
        expect(COMPONENT).toContain('socketRef.current.emit(VAULT_CHAT_SEND');
        expect(COMPONENT).toContain('socket.on(VAULT_CHAT_REPLY');
    });

    test('the dead names are gone', () => {
        expect(COMPONENT).not.toContain("emit('message'");
        expect(COMPONENT).not.toContain("on('message'");
        expect(COMPONENT).not.toContain('agent:typing');
    });
});
