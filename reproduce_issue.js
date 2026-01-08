
const { GoogleGenAI } = require('@google/genai');

async function test() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.error('GOOGLE_API_KEY not found. Skipping live test.');
        // In a real scenario, we would exit, but for this reproduction we want to show the code structure that SHOULD work.
        console.log('If the key was present, we would run:');
        console.log(`
      const session = client.chats.create({ model: 'gemini-2.0-flash-exp' });
      // The FIX: Passing the array directly
      await session.sendMessageStream(functionResponseParts);
    `);
        process.exit(0);
    }

    const client = new GoogleGenAI({ apiKey });

    // Create a chat session
    const session = client.chats.create({
        model: 'gemini-2.0-flash-exp',
    });

    // Simulate a tool response part
    const functionResponseParts = [{
        functionResponse: {
            name: 'testTool',
            response: { result: 'Success' }
        }
    }];

    console.log('Testing sendMessageStream with FIXED format (parts array)');
    try {
        const result = await session.sendMessageStream(functionResponseParts);
        console.log('Stream started. Iterating...');

        // Simulate the fix logic
        let stream = result.stream || result;
        if (!stream[Symbol.asyncIterator] && result.stream) {
            stream = result.stream;
        }

        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
            for await (const chunk of stream) {
                let text;
                if (typeof chunk.text === 'function') {
                    text = chunk.text();
                } else {
                    text = chunk.text;
                }
                console.log('Chunk text:', text);
            }
        }
        console.log('Success!');
    } catch (e) {
        console.error('Failed:', e.message);
    }
}

test();
