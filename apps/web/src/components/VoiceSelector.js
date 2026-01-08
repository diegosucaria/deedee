'use client';

import { useState, useRef } from 'react';
import { Play, Pause, Check, Loader2 } from 'lucide-react';
import { previewVoice } from '../app/actions';

const VOICES = [
    { id: 'Puck', name: 'Puck', description: 'Energetic & clear' },
    { id: 'Charon', name: 'Charon', description: 'Deep & authoritative' },
    { id: 'Kore', name: 'Kore', description: 'Warm & balanced' },
    { id: 'Fenrir', name: 'Fenrir', description: 'Fast & sharp' },
    { id: 'Aoede', name: 'Aoede', description: 'Soft & helpful' },
];

export default function VoiceSelector({ selectedVoice, onSelect }) {
    const [playing, setPlaying] = useState(null);
    const [loading, setLoading] = useState(null);
    const audioRef = useRef(null);

    const handlePlay = async (voiceId, e) => {
        e.stopPropagation();

        if (playing === voiceId) {
            audioRef.current?.pause();
            setPlaying(null);
            return;
        }

        if (audioRef.current) {
            audioRef.current.pause();
            setPlaying(null);
        }

        setLoading(voiceId);

        // Generate Live Sample if not cached (simple logic for now: always generate)
        const res = await previewVoice(voiceId, `Hi, I am ${voiceId}. This is what I sound like.`);

        if (!res.success) {
            alert('Failed to generate sample: ' + res.error);
            setLoading(null);
            return;
        }

        const mimeType = res.mimeType || 'audio/wav';
        const audio = new Audio(`data:${mimeType};base64,${res.audio_base64}`);
        audioRef.current = audio;

        audio.onended = () => {
            setPlaying(null);
            setLoading(null);
        };

        // Handle error during playback
        audio.onerror = (err) => {
            console.error('Audio playback error:', err);
            setPlaying(null);
            setLoading(null);
        };

        try {
            await audio.play();
            setPlaying(voiceId);
        } catch (err) {
            console.error('Play failed:', err);
        } finally {
            setLoading(null);
        }
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {VOICES.map(voice => (
                <div
                    key={voice.id}
                    onClick={() => onSelect(voice.id)}
                    className={`cursor-pointer group flex items-start justify-between p-4 rounded-lg border transition-all ${selectedVoice === voice.id
                        ? 'bg-indigo-500/10 border-indigo-500/50 hover:bg-indigo-500/20'
                        : 'bg-zinc-800/30 border-zinc-700/50 hover:bg-zinc-800/80 hover:border-zinc-600'
                        }`}
                >
                    <div>
                        <h3 className={`font-medium ${selectedVoice === voice.id ? 'text-indigo-300' : 'text-zinc-200'}`}>
                            {voice.name}
                        </h3>
                        <p className="text-sm text-zinc-400 mt-1">{voice.description}</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={(e) => handlePlay(voice.id, e)}
                            className="p-2 rounded-full bg-zinc-700/50 hover:bg-zinc-600/80 text-zinc-300 transition-colors"
                            title="Preview Voice"
                        >
                            {loading === voice.id ? (
                                <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                            ) : playing === voice.id ? (
                                <Pause className="w-4 h-4 fill-current" />
                            ) : (
                                <Play className="w-4 h-4 fill-current" />
                            )}
                        </button>

                        {selectedVoice === voice.id && (
                            <Check className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5 ml-1" />
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
