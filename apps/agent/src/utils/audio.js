
/**
 * Creates a WAV file header.
 * @param {number} dataLength - Length of the audio data in bytes.
 * @param {number} sampleRate - Sample rate in Hz (default: 24000).
 * @param {number} numChannels - Number of channels (default: 1).
 * @param {number} bitsPerSample - Bits per sample (default: 16).
 * @returns {Buffer} The WAV header buffer.
 */
function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
    const buffer = Buffer.alloc(44);

    // RIFF identifier
    buffer.write('RIFF', 0);
    // file length
    buffer.writeUInt32LE(36 + dataLength, 4);
    // RIFF type
    buffer.write('WAVE', 8);
    // format chunk identifier
    buffer.write('fmt ', 12);
    // format chunk length
    buffer.writeUInt32LE(16, 16);
    // sample format (raw)
    buffer.writeUInt16LE(1, 20);
    // channel count
    buffer.writeUInt16LE(numChannels, 22);
    // sample rate
    buffer.writeUInt32LE(sampleRate, 24);
    // byte rate (sampleRate * blockAlign)
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
    // block align (channel count * bytes per sample)
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
    // bits per sample
    buffer.writeUInt16LE(bitsPerSample, 34);
    // data chunk identifier
    buffer.write('data', 36);
    // data chunk length
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
}

module.exports = { createWavHeader };
