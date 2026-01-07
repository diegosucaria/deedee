'use client';

import { useState, useEffect, useRef } from 'react';
import { getLiveToken, executeLiveTool, getLiveConfig } from './actions';
import { Mic, MicOff, PhoneOff, Settings2, Terminal, X } from 'lucide-react';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';

export default function GeminiLivePage() {
    const router = useRouter();
    const [isConnected, setIsConnected] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [status, setStatus] = useState('idle'); // idle, connecting, active, error
    const [volume, setVolume] = useState(0);
    const [logs, setLogs] = useState([]);

    const audioContextRef = useRef(null);
    const wsRef = useRef(null);
    const workletNodeRef = useRef(null);
    const streamRef = useRef(null);
    const audioQueueRef = useRef([]);
    const isPlayingRef = useRef(false);
    const nextStartTimeRef = useRef(0);


    const log = (msg) => setLogs(p => [...p.slice(-4), msg]);

    useEffect(() => {
        return () => disconnect();
    }, []);

    const connect = async () => {
        try {
            setStatus('connecting');
            log('Getting Config & Token...');

            // Parallel fetch for speed
            const [config, auth] = await Promise.all([
                getLiveConfig(),
                getLiveToken()
            ]);

            if (!auth.success || !auth.token) throw new Error(auth.error || 'No token');

            // NOTE: The exact URL for global consumers is wss://generativelanguage.googleapis.com/...
            // We pass the token in the 'setup' message OR as a query param `access_token`. 
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${auth.token}`;

            log(`Connecting (${config.model})...`);
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = async () => {
                log('WS Open. Sending Setup...');

                // 1. Send Setup
                ws.send(JSON.stringify({
                    setup: {
                        model: config.model,
                        generation_config: {
                            response_modalities: ["AUDIO"]
                        },
                        tools: [
                            // We can fetch these from backend or hardcode common ones
                            { google_search: {} },
                            {
                                function_declarations: [
                                    {
                                        name: "turn_on_light",
                                        description: "Turn on a light in the house",
                                        parameters: { type: "OBJECT", properties: { room: { type: "STRING" } } }
                                    }
                                ]
                            }
                        ]
                    }
                }));

                // 2. Start Audio
                await startAudio();
                setIsConnected(true);
                setStatus('active');
            };

            ws.onmessage = async (event) => {
                let data;
                if (event.data instanceof Blob) {
                    data = JSON.parse(await event.data.text());
                } else {
                    data = JSON.parse(event.data);
                }

                // Audio Output
                if (data.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                    const base64Info = data.serverContent.modelTurn.parts[0].inlineData;
                    if (base64Info.mimeType.startsWith('audio/')) {
                        queueAudio(base64Info.data);
                    }
                }

                // Interruption
                if (data.serverContent?.interrupted) {
                    log('Interrupted. Clearing audio queue.');
                    clearAudioQueue();
                }

                // Tool Call
                if (data.toolCall) {
                    log(`Tool Call: ${data.toolCall.functionCalls[0].name}`);
                    handleToolCall(data.toolCall);
                }
            };

            ws.onerror = (e) => {
                console.error(e);
                log('WS Error');
                setStatus('error');
            };

            ws.onclose = () => {
                log('WS Closed');
                setIsConnected(false);
                setStatus('idle');
                stopAudio();
            };

        } catch (e) {
            console.error(e);
            log(`Error: ${e.message}`);
            setStatus('error');
        }
    };

    const handleToolCall = async (toolCall) => {
        const responses = [];
        for (const call of toolCall.functionCalls) {
            try {
                // Proxy to Backend
                const res = await executeLiveTool(call.name, call.args);

                if (res.success) {
                    responses.push({
                        name: call.name,
                        response: { result: res.result }
                    });
                } else {
                    throw new Error(res.error);
                }
            } catch (e) {
                responses.push({
                    name: call.name,
                    response: { error: e.message }
                });
            }
        }

        // Send Response
        wsRef.current?.send(JSON.stringify({
            toolResponse: {
                functionResponses: responses
            }
        }));
    };

    const startAudio = async () => {
        // Use system default sample rate for Context to avoid hardware issues
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = ctx;
        nextStartTimeRef.current = 0; // Reset scheduler


        await ctx.audioWorklet.addModule('/audio-processor.js');

        // Input: Try to get 24kHz if possible (matches Gemini default), otherwise we'll capture whatever
        // and tell Gemini 24k (if browser resamples) or we rely on constraints.
        // Most browsers usually honor sampleRate constraint by resampling if HW doesn't support it.
        const TARGET_RATE = 24000;

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: TARGET_RATE,
                echoCancellation: true,
                noiseSuppression: true
            }
        });
        streamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(ctx, 'audio-recorder-processor');

        worklet.port.onmessage = (e) => {
            if (isMuted || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

            // e.data is Float32Array from Worklet
            // Note: Worklet runs at ctx.sampleRate (e.g. 44.1k or 48k). 
            // If we asked getUserMedia for 24k and got it, ctx might still be 48k? 
            // Actually, if we want to send 24k, we should probably just tell Gemini what the ACTUAL rate is.
            // But for now, let's assume constraints worked or we set 24k context.
            // Let's rely on constraint.

            const pcm16 = floatTo16BitPCM(e.data);
            const base64 = arrayBufferToBase64(pcm16);

            // Send Realtime Input
            // IMPORTANT: If ctx is 48k, we are sending 48k data. We must tell Gemini 48k.
            const actualRate = ctx.sampleRate; // This is the Single Source of Truth for what we are sending

            wsRef.current.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: `audio/pcm;rate=${actualRate}`,
                        data: base64
                    }]
                }
            }));

            // Visualizer volume update
            const sum = e.data.reduce((a, b) => a + Math.abs(b), 0);
            setVolume(Math.min(sum / e.data.length * 5, 1));
        };

        source.connect(worklet);
        worklet.connect(ctx.destination); // Keep alive
        workletNodeRef.current = worklet;
    };

    const stopAudio = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        try { audioContextRef.current?.close(); } catch (e) { }

        streamRef.current = null;
        audioContextRef.current = null;
    };

    const disconnect = () => {
        wsRef.current?.close();
        stopAudio();
        setIsConnected(false);
    };

    // Helpers
    const floatTo16BitPCM = (float32Array) => {
        const buffer = new ArrayBuffer(float32Array.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // Little endian
        }
        return buffer;
    };

    const arrayBufferToBase64 = (buffer) => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    };

    const activeSourceRef = useRef(null);

    const clearAudioQueue = () => {
        if (activeSourceRef.current) {
            try {
                activeSourceRef.current.stop();
                activeSourceRef.current.disconnect();
            } catch (e) { }
            activeSourceRef.current = null;
        }
        // Sync scheduler to current time to avoid large gaps or overlaps after clear
        if (audioContextRef.current) {
            nextStartTimeRef.current = audioContextRef.current.currentTime;
        }
    };


    const queueAudio = (base64) => {
        // Decoding Raw PCM:
        const binaryString = window.atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const float32 = new Float32Array(bytes.length / 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length / 2; i++) {
            const int16 = view.getInt16(i * 2, true);
            float32[i] = int16 / 32768;
        }

        playPCMChunk(float32);
    };

    const playPCMChunk = (pcmData) => {
        if (!audioContextRef.current) return;
        const ctx = audioContextRef.current;
        // Gemini Always sends 24kHz for now
        const buffer = ctx.createBuffer(1, pcmData.length, 24000);

        buffer.getChannelData(0).set(pcmData);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        // --- Scheduler Logic ---
        const currentTime = ctx.currentTime;

        // If next start time is behind current time (latency, gap), play immediately
        if (nextStartTimeRef.current < currentTime) {
            nextStartTimeRef.current = currentTime;
        }

        source.start(nextStartTimeRef.current);

        // Advance scheduler
        nextStartTimeRef.current += buffer.duration;

        activeSourceRef.current = source;
    };


    return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-black text-white relative overflow-hidden">
            {/* Background Orb */}
            <div
                className={clsx(
                    "absolute w-96 h-96 rounded-full blur-[100px] transition-all duration-300",
                    status === 'active' ? "bg-indigo-600/50 scale-110" : "bg-zinc-800/30 scale-100",
                    status === 'error' && "bg-red-600/40"
                )}
                style={{ transform: `scale(${1 + volume})` }}
            />

            {/* Status */}
            <div className="z-10 flex flex-col items-center gap-8">
                <div className="text-2xl font-light tracking-widest uppercase opacity-80">
                    {status === 'active' ? 'Listening' : status}
                </div>

                {/* Visualizer (Simple) */}
                <div className="flex gap-1 h-12 items-center">
                    {[...Array(5)].map((_, i) => (
                        <div
                            key={i}
                            className="w-2 bg-white rounded-full transition-all duration-75"
                            style={{
                                height: Math.max(8, volume * 100 * Math.random()) + 'px',
                                opacity: status === 'active' ? 1 : 0.2
                            }}
                        />
                    ))}
                </div>
            </div>

            {/* Controls */}

            {/* Exit Button */}
            <button
                onClick={() => router.push('/')}
                className="absolute top-6 right-6 p-4 rounded-full bg-zinc-900/50 text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-all z-50 backdrop-blur-md border border-white/5 hover:border-white/10 group"
            >
                <X className="w-5 h-5 group-hover:scale-110 transition-transform" />
            </button>

            {/* Controls */}
            <div className="absolute bottom-12 flex items-center gap-8 z-20">
                {!isConnected ? (
                    <button
                        onClick={connect}
                        disabled={status === 'connecting'}
                        className={clsx(
                            "group relative flex items-center justify-center w-20 h-20 rounded-full transition-all duration-300",
                            status === 'connecting'
                                ? "bg-zinc-800 cursor-wait opacity-80"
                                : "bg-white text-black hover:scale-105 active:scale-95 shadow-[0_0_40px_-10px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_-15px_rgba(255,255,255,0.4)]"
                        )}
                    >
                        {status === 'connecting' ? (
                            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <Mic className="w-8 h-8" />
                        )}
                    </button>
                ) : (
                    <div className="flex items-center gap-6 p-2 rounded-full bg-zinc-900/40 backdrop-blur-xl border border-white/5 shadow-2xl">
                        <button
                            onClick={() => setIsMuted(!isMuted)}
                            className={clsx(
                                "flex items-center justify-center w-16 h-16 rounded-full transition-all duration-200 border",
                                isMuted
                                    ? "bg-red-500/10 border-red-500/50 text-red-500 hover:bg-red-500/20"
                                    : "bg-white/5 border-white/5 text-white hover:bg-white/10"
                            )}
                        >
                            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                        </button>

                        <button
                            onClick={disconnect}
                            className="flex items-center justify-center w-16 h-16 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all duration-200 hover:rotate-90 hover:scale-105 active:scale-95 shadow-lg shadow-red-500/20"
                        >
                            <PhoneOff className="w-7 h-7" />
                        </button>
                    </div>
                )}
            </div>

            {/* Logs Debug Overlay */}
            <div className="absolute top-4 left-4 font-mono text-xs text-zinc-600 max-w-xs pointer-events-none">
                {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
        </div>
    );
}
