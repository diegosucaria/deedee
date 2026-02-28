'use client';

import { useState, useEffect, useRef } from 'react';
import { getVinylCrate, uploadVinylPhoto } from '../actions';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { Upload, Disc3, Music, Clock, ExternalLink, Loader2 } from 'lucide-react';

export default function DJCratePage() {
    const [vinyls, setVinyls] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const fileInputRef = useRef(null);

    async function loadCrate() {
        setLoading(true);
        const res = await getVinylCrate(100);
        if (res.success) {
            setVinyls(res.data || []);
        } else {
            console.error('Failed to load crate:', res.error);
            setVinyls([]);
        }
        setLoading(false);
    }

    useEffect(() => {
        loadCrate();

        const socket = io();
        socket.on('connect', () => {
            console.log('[DJ] Connected to socket');
        });

        socket.on('dj:vinyl:update', (newVinyl) => {
            console.log('[DJ] New vinyl received via socket:', newVinyl);
            setVinyls((prev) => [newVinyl, ...prev]);
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    const handleFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        setUploadStatus('Reading image...');

        try {
            // Convert to base64
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            setUploadStatus('Analyzing vinyl & enriching metadata...');
            const result = await uploadVinylPhoto(base64, file.type);

            if (result.success) {
                setUploadStatus(`Added ${result.data.vinyls?.length || 0} vinyl(s)!`);
                // Socket will handle the live update, but also refresh
                await loadCrate();
            } else {
                setUploadStatus(`Error: ${result.error}`);
            }
        } catch (err) {
            setUploadStatus(`Error: ${err.message}`);
        } finally {
            setUploading(false);
            // Clear status after 4s
            setTimeout(() => setUploadStatus(''), 4000);
            // Reset file input
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const parseMeta = (vinyl) => {
        let meta = {};
        try {
            if (typeof vinyl.meta === 'string') meta = JSON.parse(vinyl.meta);
            else if (vinyl.meta) meta = vinyl.meta;
        } catch { /* ignore */ }
        return meta;
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
                        <Disc3 className="w-8 h-8 text-purple-400" />
                        Vinyl Crate
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        Your digitized collection. Upload a photo of any vinyl cover or label to add it.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm font-medium bg-purple-500/10 text-purple-400 px-3 py-1 rounded-full border border-purple-500/20">
                        {vinyls.length} Records
                    </span>

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileSelect}
                        disabled={uploading}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-purple-600/20"
                    >
                        {uploading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Upload className="w-4 h-4" />
                        )}
                        {uploading ? 'Processing...' : 'Upload Vinyl'}
                    </button>
                </div>
            </div>

            {/* Upload Status */}
            <AnimatePresence>
                {uploadStatus && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className={`px-4 py-3 rounded-lg text-sm font-medium ${uploadStatus.startsWith('Error')
                                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                                : uploading
                                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            }`}
                    >
                        {uploadStatus}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Grid */}
            {loading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 animate-pulse">
                    {[...Array(10)].map((_, i) => (
                        <div key={i} className="aspect-square bg-muted rounded-lg" />
                    ))}
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                    {vinyls.map((vinyl) => {
                        const meta = parseMeta(vinyl);
                        const tracks = (() => {
                            try {
                                if (typeof vinyl.tracks === 'string') return JSON.parse(vinyl.tracks);
                                return vinyl.tracks || [];
                            } catch { return []; }
                        })();

                        return (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                key={vinyl.id}
                                className="group relative flex flex-col space-y-2"
                            >
                                <div className="aspect-square relative overflow-hidden rounded-lg shadow-sm border border-zinc-700/50 bg-muted">
                                    <img
                                        src={vinyl.cover_image_url || '/vinyl_covers/default.png'}
                                        alt={vinyl.title}
                                        className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105"
                                        loading="lazy"
                                    />

                                    {/* Hover Overlay */}
                                    <div className="absolute inset-0 bg-black/75 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white p-4 text-center gap-2">
                                        <p className="font-bold text-sm">{vinyl.title}</p>
                                        <p className="text-xs text-white/80">{vinyl.artist}</p>
                                        <p className="text-[10px] uppercase tracking-widest text-white/50 mt-1">{vinyl.label}</p>
                                        {vinyl.catalog_number && (
                                            <p className="text-[10px] text-white/50 font-mono">{vinyl.catalog_number}</p>
                                        )}

                                        {/* Enriched Metadata */}
                                        <div className="flex items-center gap-3 mt-2 text-[10px]">
                                            {vinyl.bpm > 0 && (
                                                <span className="bg-purple-500/30 px-1.5 py-0.5 rounded text-purple-200 font-mono">{vinyl.bpm} BPM</span>
                                            )}
                                            {vinyl.key && (
                                                <span className="bg-indigo-500/30 px-1.5 py-0.5 rounded text-indigo-200 font-mono">{vinyl.key}</span>
                                            )}
                                            {meta.year > 0 && (
                                                <span className="bg-zinc-500/30 px-1.5 py-0.5 rounded text-zinc-300">{meta.year}</span>
                                            )}
                                        </div>

                                        {meta.genre && (
                                            <p className="text-[10px] text-amber-300/80 mt-1">{meta.genre}{meta.style ? ` / ${meta.style}` : ''}</p>
                                        )}

                                        {/* Tracklist Preview */}
                                        {tracks.length > 0 && (
                                            <div className="mt-2 text-[9px] text-white/50 max-h-16 overflow-hidden">
                                                {tracks.slice(0, 4).map((t, i) => (
                                                    <div key={i} className="flex items-center gap-1">
                                                        <Music className="w-2 h-2 shrink-0" />
                                                        <span className="truncate">{t}</span>
                                                    </div>
                                                ))}
                                                {tracks.length > 4 && <div>+{tracks.length - 4} more</div>}
                                            </div>
                                        )}

                                        {/* External Links */}
                                        <div className="flex gap-2 mt-2">
                                            {meta.discogsUrl && (
                                                <a href={meta.discogsUrl} target="_blank" rel="noopener" className="text-[9px] text-blue-300 hover:text-blue-200 flex items-center gap-0.5 underline">
                                                    <ExternalLink className="w-2.5 h-2.5" />Discogs
                                                </a>
                                            )}
                                            {meta.beatportUrl && (
                                                <a href={meta.beatportUrl} target="_blank" rel="noopener" className="text-[9px] text-green-300 hover:text-green-200 flex items-center gap-0.5 underline">
                                                    <ExternalLink className="w-2.5 h-2.5" />Beatport
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-0.5">
                                    <h3 className="font-semibold text-sm truncate">{vinyl.title}</h3>
                                    <p className="text-xs text-muted-foreground truncate">{vinyl.artist}</p>
                                    {(vinyl.bpm > 0 || vinyl.key) && (
                                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                            {vinyl.bpm > 0 && <span className="font-mono">{vinyl.bpm}bpm</span>}
                                            {vinyl.key && <span className="font-mono text-purple-400">{vinyl.key}</span>}
                                            {meta.genre && <span className="text-amber-400/70 truncate">{meta.genre}</span>}
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        );
                    })}
                </div>
            )}

            {!loading && vinyls.length === 0 && (
                <div className="text-center py-20 text-muted-foreground space-y-4">
                    <Disc3 className="w-16 h-16 mx-auto opacity-20" />
                    <p className="text-lg">Your crate is empty.</p>
                    <p className="text-sm">Upload a photo of a vinyl cover or label to start building your collection.</p>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="mx-auto mt-4 flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-all"
                    >
                        <Upload className="w-4 h-4" />
                        Upload Your First Vinyl
                    </button>
                </div>
            )}
        </div>
    );
}
