'use client';

import { useState, useEffect } from 'react';
import { getVinylCrate } from '../actions';
import { motion } from 'framer-motion';
import { io } from 'socket.io-client';

export default function DJCratePage() {
    const [vinyls, setVinyls] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadCrate();
    }, []);

    async function loadCrate() {
        setLoading(true);
        const data = await getVinylCrate(100);
        setVinyls(data || []);
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

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Vinyl Crate</h1>
                    <p className="text-muted-foreground mt-1">
                        Browse your digitized collection. To add new vinyls, send a photo to the chat with <span className="font-mono bg-muted px-1 rounded text-sm">/vinyl</span>.
                    </p>
                </div>
                <div className="text-right">
                    <span className="text-sm font-medium bg-primary/10 text-primary px-3 py-1 rounded-full">{vinyls.length} Records</span>
                </div>
            </div>

            {/* Grid */}
            {loading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 animate-pulse">
                    {[...Array(10)].map((_, i) => (
                        <div key={i} className="aspect-square bg-muted rounded-lg" />
                    ))}
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                    {vinyls.map((vinyl) => (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            key={vinyl.id}
                            className="group relative flex flex-col space-y-2"
                        >
                            <div className="aspect-square relative overflow-hidden rounded-lg shadow-sm border bg-muted">
                                <img
                                    src={vinyl.cover_image_url || '/vinyl_covers/default.png'}
                                    alt={vinyl.title}
                                    className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105"
                                    loading="lazy"
                                />

                                {/* Hover Overlay */}
                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white p-4 text-center">
                                    <div>
                                        <p className="font-bold text-sm">{vinyl.title}</p>
                                        <p className="text-xs text-white/80">{vinyl.artist}</p>
                                        <p className="text-[10px] mt-2 text-white/60 uppercase tracking-widest">{vinyl.label}</p>
                                        <p className="text-[10px] text-white/60">{vinyl.catalog_number}</p>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-0.5">
                                <h3 className="font-semibold text-sm truncate">{vinyl.title}</h3>
                                <p className="text-xs text-muted-foreground truncate">{vinyl.artist}</p>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}

            {!loading && vinyls.length === 0 && (
                <div className="text-center py-20 text-muted-foreground">
                    <p>Your crate is empty.</p>
                    <p className="text-sm mt-2">Upload a photo in chat to start digging.</p>
                </div>
            )}
        </div>
    );
}
