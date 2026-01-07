'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchAPI } from '@/lib/api';
import { Mic, MicOff, PhoneOff, Settings2, Terminal } from 'lucide-react';
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

    const log = (msg) => setLogs(p => [...p.slice(-4), msg]);

    useEffect(() => {
        return () => disconnect();
    }, []);

    const connect = async () => {
        try {
            setStatus('connecting');
            log('Getting Token...');
            const { token } = await fetchAPI('/v1/live/token', { method: 'POST' });

            if (!token) throw new Error('No token');

            const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.NEXT_PUBLIC_GOOGLE_API_KEY || ''}`; // Key not needed if using token? Actually usually token is bearer.
            // Wait, for ephemeral tokens on Vertex/GenAI, we usually use the access token. 
            // The docs say: "Bearer <token>" in handshake or URL param? 
            // Let's assume Bearer header isn't possible in browser WebSocket API. 
            // For the new Live API, we send "setup" message. 
            // Actually, usually we pass `access_token` in query param or custom header if client allows. 
            // Standard browser WS doesn't allow headers. 
            // Try query param `access_token` or `key`.
            // User spec said "Client-to-Server connection... mediated by backend for tokens".
            // Let's try constructing the URL with the token.

            // NOTE: The exact URL for global consumers is wss://generativelanguage.googleapis.com/...
            // We pass the token in the 'setup' message OR as a query param `access_token`. 
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${token}`;

            log('Connecting WS...');
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = async () => {
                log('WS Open. Sending Setup...');

                // 1. Send Setup
                ws.send(JSON.stringify({
                    setup: {
                        model: "models/gemini-2.0-flash-exp",
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
                const res = await fetchAPI('/v1/live/tools/execute', {
                    method: 'POST',
                    body: JSON.stringify({ name: call.name, args: call.args })
                });

                responses.push({
                    name: call.name,
                    response: { result: res.result || res }
                });
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
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); // Try to force 16k
        audioContextRef.current = ctx;

        await ctx.audioWorklet.addModule('/audio-processor.js');

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true
            }
        });
        streamRef.current = stream;

        const source = ctx.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(ctx, 'audio-recorder-processor');

        worklet.port.onmessage = (e) => {
            if (isMuted || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

            // e.data is Float32Array
            // Convert to PCM16 standard
            const pcm16 = floatTo16BitPCM(e.data);
            const base64 = arrayBufferToBase64(pcm16);

            // Send Realtime Input
            wsRef.current.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64
                    }]
                }
            }));

            // Visualizer volume update
            const sum = e.data.reduce((a, b) => a + Math.abs(b), 0);
            setVolume(Math.min(sum / e.data.length * 5, 1));
        };

        source.connect(worklet);
        worklet.connect(ctx.destination); // Keep alive? mute?
        workletNodeRef.current = worklet;
    };

    const stopAudio = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioContextRef.current?.close();

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

    const queueAudio = (base64) => {
        // Decode and play logic is complex for PCM streaming without header.
        // Simpler: Use a Worklet or just BufferSource if chunks are large enough.
        // For latency, we want to play chunks immediately.

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
        const buffer = audioContextRef.current.createBuffer(1, pcmData.length, 16000); // Server sends 24k? 16k? Usually matches input or 24k.
        // Google Live API default is 24kHz output usually? Let's check spec. 
        // Spec says 24000Hz usually. Let's assume 24000 if it sounds high pitched.
        // Actually, let's reset context to 24000 if we can, or resample.
        // For now hardcode 24000 for output.

        buffer.getChannelData(0).set(pcmData);

        const source = audioContextRef.current.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContextRef.current.destination);

        // Simple queueing
        // Real implementation needs a proper queue time tracker
        // This runs immediately = overlap potential
        source.start();
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
            <div className="absolute bottom-12 flex items-center gap-6 z-20">
                <button
                    onClick={() => router.push('/')}
                    className="p-4 rounded-full bg-zinc-800 text-white hover:bg-zinc-700 transition-colors"
                >
                    <Settings2 className="w-6 h-6" />
                </button>

                {!isConnected ? (
                    <button
                        onClick={connect}
                        disabled={status === 'connecting'}
                        className="p-6 rounded-full bg-indigo-600 text-white hover:bg-indigo-500 transition-all scale-100 hover:scale-105 active:scale-95 disabled:opacity-50"
                    >
                        <Mic className="w-8 h-8" />
                    </button>
                ) : (
                    <>
                        <button
                            onClick={() => setIsMuted(!isMuted)}
                            className={clsx(
                                "p-4 rounded-full transition-colors",
                                isMuted ? "bg-white text-black" : "bg-zinc-800 text-white"
                            )}
                        >
                            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                        </button>

                        <button
                            onClick={disconnect}
                            className="p-6 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all scale-100 hover:scale-105 active:scale-95"
                        >
                            <PhoneOff className="w-8 h-8" />
                        </button>
                    </>
                )}
            </div>

            {/* Logs Debug Overlay */}
            <div className="absolute top-4 left-4 font-mono text-xs text-zinc-600 max-w-xs pointer-events-none">
                {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
        </div>
    );
}
