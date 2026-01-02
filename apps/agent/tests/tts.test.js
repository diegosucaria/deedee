const { Agent } = require('../src/agent');
const { HttpInterface } = require('../src/http-interface');
const googleTTS = require('google-tts-api');

// Mock google-tts-api
jest.mock('google-tts-api', () => ({
  getAllAudioBase64: jest.fn().mockResolvedValue([{ base64: 'mockbase64', shortText: 'test' }])
}));

describe('Agent TTS', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    mockInterface = {
      send: jest.fn().mockResolvedValue(true),
      on: jest.fn()
    };
    
    agent = new Agent({
      googleApiKey: 'fake',
      interface: mockInterface
    });
  });

  test('replyWithAudio tool sends audio message', async () => {
    const result = await agent._executeTool('replyWithAudio', { text: 'Hello', language: 'en' }, { metadata: { chatId: '123' }, source: 'telegram' });
    
    expect(googleTTS.getAllAudioBase64).toHaveBeenCalledWith('Hello', expect.objectContaining({ lang: 'en' }));
    expect(mockInterface.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'audio',
      content: 'mockbase64',
      metadata: { chatId: '123' }
    }));
    expect(result).toEqual({ success: true, sent_segments: 1 });
  });
});
