// What the vault pane says on the socket, kept in one place so the names
// cannot drift from the server again. The pane sent `message` and waited for
// `message`; the server in apps/interfaces listens for `chat:message` and
// answers with `agent:message`, so the pane was dead from March 2026 until
// these names were fixed.
export const VAULT_CHAT_SEND = 'chat:message';
export const VAULT_CHAT_REPLY = 'agent:message';
export const VAULT_CHAT_THINKING = 'agent:thinking';
export const VAULT_CHAT_ACK = 'chat:ack';
export const VAULT_CHAT_ERROR = 'agent:error';

// A status line, not an answer. The chat page hides these too.
const STATUS_PREFIXES = ['Thinking...', 'Still working...', 'Action **'];

/** The chat id for a vault pane. One room per vault, so replies come back. */
export function vaultChatId(vaultId) {
    return `vault-${vaultId}`;
}

/**
 * The payload the pane emits. `content` is the field the server reads, and
 * `metadata.vaultId` is what makes the turn search this vault: the agent
 * stores it as the chat's active topic, and searchDocuments scopes to that.
 */
export function vaultChatPayload({ vaultId, text }) {
    return {
        chatId: vaultChatId(vaultId),
        content: text,
        files: [],
        metadata: { vaultId }
    };
}

/** True when the message is a progress line rather than an answer. */
export function isStatusMessage(content) {
    if (typeof content !== 'string') return false;
    return STATUS_PREFIXES.some(p => content.startsWith(p));
}

/**
 * The text of an `agent:message`. Audio and images arrive as parts; the pane
 * shows text, so a media reply falls back to its content field.
 */
export function replyText(data) {
    if (!data) return '';
    if (data.parts && (data.type === 'audio' || data.type === 'image')) {
        const media = data.parts.find(p => p.inlineData);
        if (media) return data.content || `[${data.type}]`;
    }
    return data.content || '';
}
