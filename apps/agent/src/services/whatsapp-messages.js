/**
 * Reader for WhatsApp messages held by the interfaces service.
 *
 * The WhatsApp session files (credentials and the message database) live on
 * the interfaces volume, which the agent does not mount. Anything the agent
 * needs from them comes through /internal/* on that service, with
 * DEEDEE_INTERNAL_TOKEN as the bearer.
 */
const axios = require('axios');

/**
 * One-to-one WhatsApp messages of one local day.
 * Returns [] when the service is unreachable or has nothing: memory
 * consolidation still runs on the agent's own messages.
 * @param {string} date YYYY-MM-DD
 * @param {string} session WhatsApp session name ('user' mirrors the owner's phone)
 */
async function fetchWhatsAppMessagesByDate(date, session = 'user') {
    const baseUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
    try {
        const { data } = await axios.get(`${baseUrl}/internal/whatsapp/messages-by-date`, {
            params: { date, session },
            headers: { Authorization: `Bearer ${process.env.DEEDEE_INTERNAL_TOKEN}` },
            timeout: 15000
        });
        return Array.isArray(data?.messages) ? data.messages : [];
    } catch (e) {
        console.warn(`[WhatsAppMessages] ${date}: could not read messages from interfaces: ${e.message}`);
        return [];
    }
}

module.exports = { fetchWhatsAppMessagesByDate };
