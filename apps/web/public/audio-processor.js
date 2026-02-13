class AudioRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 2048;
        this._bytesWritten = 0;
        this._buffer = new Float32Array(this.bufferSize);
        this.init = false;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (input.length > 0) {
            const channelData = input[0];

            // Downsample / Process logic if needed, but for now passing float stream
            // Send raw samples to main thread for PCM16 conversion
            this.port.postMessage(channelData);
        }
        return true;
    }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
