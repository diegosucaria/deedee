'use client';

import { useState, useRef } from 'react';
import { Play, Pause, Check } from 'lucide-react';

const VOICES = [
    { id: 'Puck', name: 'Puck', description: 'Energetic & clear' },
    { id: 'Charon', name: 'Charon', description: 'Deep & authoritative' },
    { id: 'Kore', name: 'Kore', description: 'Warm & balanced' },
    { id: 'Fenrir', name: 'Fenrir', description: 'Fast & sharp' },
    { id: 'Aoede', name: 'Aoede', description: 'Soft & helpful' },
];

// Determine sample availability: we can use simple placeholder audio files or external URLs if allowed.
// For now, let's assume assets exist in /public/samples/ or use a mock URL.
// Since we don't have files yet, the Play button might just log or fail gracefully.
// User requested "play button to read a sample". We can try to use browser TTS as fallback? 
// No, user specifically wants to sample the *Gemini* voices.
// We'll point to a placeholder path, and user can add files later.

export default function VoiceSelector({ selectedVoice, onSelect }) {
    const [playing, setPlaying] = useState(null);
    const audioRef = useRef(null);

    const handlePlay = (voiceId, e) => {
        e.stopPropagation();

        if (playing === voiceId) {
            audioRef.current?.pause();
            setPlaying(null);
            return;
        }

        // Stop current
        if (audioRef.current) {
            audioRef.current.pause();
        }

        // Start new
        // Note: You need to place sample files in apps/web/public/samples/VOICE_ID.mp3
        const audio = new Audio(`/samples/${voiceId}.mp3`);
        audioRef.current = audio;

        audio.onended = () => setPlaying(null);
        audio.onerror = () => {
            alert(`Sample for ${voiceId} not found. Please add /public/samples/${voiceId}.mp3`);
            setPlaying(null);
        };

        audio.play().catch(e => console.error('Play error', e));
        setPlaying(voiceId);
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
                            {playing === voice.id ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
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
