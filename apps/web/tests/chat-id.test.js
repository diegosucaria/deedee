// The chat page must look a chat up under its real id. Next 14 passes the
// route segment still encoded, and the page encodes it again for the API.
const { chatIdFromParam } = require('../src/lib/chat-id.js');

test('a WhatsApp id arrives encoded and is decoded once', () => {
    expect(chatIdFromParam('10000000000%40s.whatsapp.net')).toBe('10000000000@s.whatsapp.net');
    expect(chatIdFromParam('scheduled_Daily%20digest_1700000000000')).toBe('scheduled_Daily digest_1700000000000');
});

test('a plain id is unchanged, and a broken one is used as it came', () => {
    expect(chatIdFromParam('0b6d1f3e-2c7a-4a8e-9a1b-111111111111')).toBe('0b6d1f3e-2c7a-4a8e-9a1b-111111111111');
    expect(chatIdFromParam('bad%E0%A4%A')).toBe('bad%E0%A4%A');
    expect(chatIdFromParam(undefined)).toBe('');
});
