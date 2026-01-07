'use client';

import { useState, useEffect } from 'react';
import { Mic, X } from 'lucide-react';
import clsx from 'clsx';

export default function AudioSettingsDialog({ isOpen, onClose, onDeviceSelect, selectedDeviceId }) {
    const [devices, setDevices] = useState([]);

    useEffect(() => {
        if (isOpen) {
            navigator.mediaDevices.enumerateDevices().then(devs => {
                const audioInputs = devs.filter(d => d.kind === 'audioinput');
                setDevices(audioInputs);
            });
        }
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                        <Mic className="h-5 w-5 text-indigo-400" />
                        Microphone
                    </h2>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-zinc-800 transition-colors">
                        <X className="h-5 w-5 text-zinc-400" />
                    </button>
                </div>

                <div className="space-y-2">
                    {devices.map((device) => (
                        <button
                            key={device.deviceId}
                            onClick={() => onDeviceSelect(device.deviceId)}
                            className={clsx(
                                "w-full text-left px-4 py-3 rounded-xl transition-all border",
                                selectedDeviceId === device.deviceId
                                    ? "bg-indigo-500/10 border-indigo-500/50 text-indigo-300 shadow-sm"
                                    : "bg-zinc-800/50 border-transparent hover:bg-zinc-800 text-zinc-300 hover:text-white"
                            )}
                        >
                            <div className="font-medium truncate">{device.label || `Microphone ${device.deviceId.slice(0, 4)}...`}</div>
                        </button>
                    ))}
                    {devices.length === 0 && (
                        <div className="text-zinc-500 text-center py-4">No microphones found.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
