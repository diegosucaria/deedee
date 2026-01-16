/**
 * Maps Deedee/Gemini message history to OpenAI format
 * @param {Array} history - Array of messages in internal/Gemini format
 * @returns {Array} - Array of OpenAI compatible messages
 */
function geminiToOpenAIHistory(history) {
    return history.map(msg => {
        const role = msg.role === 'model' ? 'assistant' : (msg.role === 'user' ? 'user' : 'system');

        let content = '';
        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (msg.parts) {
            // Handle parts
            content = msg.parts
                .filter(p => p.text)
                .map(p => p.text)
                .join('\n');

            // OpenAI Vision handling (if multimedia) could go here
            // But for now Grok beta is mostly text or we extract text.
            // If image part exists:
            /*
            msg.parts.forEach(p => {
                if(p.inlineData) {
                    // convert to image_url content type... 
                }
            });
            */
        }

        // OpenAI 4o / Grok expects 'content' to be string or array.
        // For simplicity, we stick to text.
        return { role, content };
    });
}

/**
 * Maps a single chunk from OpenAI stream to Gemini format
 * @param {Object} chunk - OpenAI Stream Chunk
 * @returns {Object} - Gemini Candidate Object
 */
function openAIToGeminiChunk(chunk) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (!content) return null;

    return {
        candidates: [{
            content: {
                role: 'model',
                parts: [{ text: content }]
            }
        }]
    };
}

module.exports = {
    geminiToOpenAIHistory,
    openAIToGeminiChunk
};
