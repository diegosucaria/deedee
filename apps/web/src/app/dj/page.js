'use client';

import { useState, useEffect, useRef } from 'react';
import { getVinylCrate, uploadVinylPhoto, updateVinyl, deleteVinyl as deleteVinylAction, reEnrichVinyl, retryEnrichVinyl, refreshVinylValue, getCrates, createCrate, updateCrate as updateCrateAction, deleteCrate as deleteCrateAction, getCrateVinyls, addVinylToCrate, removeVinylFromCrate } from '../actions';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { Upload, Disc3, Music, ExternalLink, Loader2, Search, X, AlertTriangle, Check, Pencil, Trash2, LayoutGrid, List, ArrowUpDown, RefreshCw, Plus, FolderPlus, TrendingUp, BookOpen, Sparkles, Camera } from 'lucide-react';

export default function DJCratePage() {
    const [vinyls, setVinyls] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedVinyl, setSelectedVinyl] = useState(null);
    const [editing, setEditing] = useState(false);
    const [editFields, setEditFields] = useState({});
    const [saving, setSaving] = useState(false);
    const [viewMode, setViewMode] = useState('crate'); // 'crate' | 'tracks'
    const [sortConfig, setSortConfig] = useState({ key: 'bpm', dir: 'desc' });
    const [enrichingIds, setEnrichingIds] = useState(new Set());
    const [refreshingValue, setRefreshingValue] = useState(false);
    // Collections
    const [crates, setCrates] = useState([]);
    const [activeCrateId, setActiveCrateId] = useState(null);
    const [crateVinyls, setCrateVinyls] = useState(null);
    const [showCrateModal, setShowCrateModal] = useState(false);
    const [editingCrate, setEditingCrate] = useState(null);
    const [showAddToCrateMenu, setShowAddToCrateMenu] = useState(null);
    const fileInputRef = useRef(null);

    async function loadData() {
        setLoading(true);
        const [vinylsRes, cratesRes] = await Promise.all([
            getVinylCrate(200),
            getCrates()
        ]);
        if (vinylsRes.success) setVinyls(vinylsRes.data || []);
        else setVinyls([]);
        if (cratesRes.success) setCrates(cratesRes.data || []);
        setLoading(false);
    }

    useEffect(() => {
        loadData();
        const socket = io();
        socket.on('dj:vinyl:update', (v) => {
            setEnrichingIds(prev => { const s = new Set(prev); s.delete(v.id); return s; });
            setVinyls((prev) => {
                const idx = prev.findIndex(x => x.id === v.id);
                if (idx >= 0) { const u = [...prev]; u[idx] = v; return u; }
                return [v, ...prev];
            });
            setSelectedVinyl(sel => sel?.id === v.id ? v : sel);
        });
        socket.on('dj:vinyl:delete', ({ id }) => {
            setVinyls((prev) => prev.filter(v => v.id !== id));
            setSelectedVinyl((sel) => sel?.id === id ? null : sel);
        });
        socket.on('dj:vinyl:enriching', (data) => {
            if (data.id) setEnrichingIds(prev => new Set([...prev, data.id]));
        });
        return () => socket.disconnect();
    }, []);

    // Fetch crate vinyls when active crate changes
    useEffect(() => {
        if (!activeCrateId) { setCrateVinyls(null); return; }
        getCrateVinyls(activeCrateId).then(res => {
            if (res.success) setCrateVinyls(res.data || []);
        });
    }, [activeCrateId]);

    const handleFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        setUploadStatus('Reading image...');
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            setUploadStatus('Analyzing image...');
            const result = await uploadVinylPhoto(base64, file.type);
            if (result.success) {
                const newVinyls = result.data?.vinyls || [];
                setUploadStatus(`Processing ${newVinyls.length} vinyl(s)...`);
                // Optimistically add placeholders — Socket.io will update when enrichment completes
                if (newVinyls.length > 0) {
                    setVinyls(prev => [...newVinyls.filter(nv => !prev.find(p => p.id === nv.id)), ...prev.map(p => {
                        const updated = newVinyls.find(nv => nv.id === p.id);
                        return updated || p;
                    })]);
                }
            } else {
                setUploadStatus(`Error: ${result.error}`);
            }
        } catch (err) {
            setUploadStatus(`Error: ${err.message}`);
        } finally {
            setUploading(false);
            setTimeout(() => setUploadStatus(''), 4000);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleRetryEnrich = async (vinylId) => {
        await retryEnrichVinyl(vinylId);
    };

    const handleRefreshValue = async () => {
        if (!selectedVinyl) return;
        setRefreshingValue(true);
        try {
            const result = await refreshVinylValue(selectedVinyl.id);
            if (result.success && result.data?.vinyl) {
                setSelectedVinyl(result.data.vinyl);
                setVinyls(prev => prev.map(v => v.id === selectedVinyl.id ? result.data.vinyl : v));
            }
        } catch (e) {
            console.error('Refresh value failed:', e);
        }
        setRefreshingValue(false);
    };

    const parseMeta = (v) => { try { return typeof v.meta === 'string' ? JSON.parse(v.meta) : (v.meta || {}); } catch { return {}; } };
    const parseTracks = (v) => { try { if (typeof v.tracks === 'string') return JSON.parse(v.tracks); return Array.isArray(v.tracks) ? v.tracks : []; } catch { return []; } };

    const getConfidenceInfo = (c) => {
        if (c >= 0.8) return { label: 'High', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' };
        if (c >= 0.5) return { label: 'Medium', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' };
        return { label: 'Low', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' };
    };

    const activeVinylPool = crateVinyls !== null ? crateVinyls : vinyls;

    const filteredVinyls = searchQuery.trim()
        ? activeVinylPool.filter((v) => {
            const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
            const m = parseMeta(v);
            const tracks = parseTracks(v);
            const trackTitles = tracks.map((t) => (typeof t === 'string' ? t : (t.title || '')).toLowerCase()).join(' ');
            const haystack = [
                v.artist, v.title, v.label, v.catalog_number,
                m.genre, m.style, trackTitles
            ].map((s) => (s || '').toLowerCase()).join(' ');
            return tokens.every((token) => haystack.includes(token));
        })
        : activeVinylPool;

    const openDetail = (v) => { setSelectedVinyl(v); setEditing(false); setEditFields({}); };

    const startEditing = () => {
        const m = parseMeta(selectedVinyl);
        setEditFields({
            artist: selectedVinyl.artist || '', title: selectedVinyl.title || '',
            label: selectedVinyl.label || '', catalog_number: selectedVinyl.catalog_number || '',
            tracks: parseTracks(selectedVinyl), meta: m
        });
        setEditing(true);
    };

    const handleSave = async () => {
        if (!selectedVinyl) return;
        setSaving(true);
        const result = await updateVinyl(selectedVinyl.id, editFields);
        if (result.success) {
            await loadData();
            setSelectedVinyl(result.data?.vinyl || { ...selectedVinyl, ...editFields });
            setEditing(false);
        }
        setSaving(false);
    };

    const updateTrackField = (idx, field, value) => {
        const t = [...(editFields.tracks || [])];
        t[idx] = { ...t[idx], [field]: field === 'bpm' ? Number(value) || 0 : value };
        setEditFields({ ...editFields, tracks: t });
    };

    const handleDelete = async () => {
        if (!selectedVinyl) return;
        if (!confirm(`Delete "${selectedVinyl.artist} - ${selectedVinyl.title}"? This will also remove the cover image.`)) return;
        const result = await deleteVinylAction(selectedVinyl.id);
        if (result.success) {
            setVinyls((prev) => prev.filter(v => v.id !== selectedVinyl.id));
            setSelectedVinyl(null);
            setEditing(false);
        }
    };

    const handleReEnrich = async () => {
        if (!selectedVinyl) return;
        const vinylId = selectedVinyl.id;
        setEnrichingIds(prev => new Set(prev).add(vinylId));
        try {
            await reEnrichVinyl(vinylId);
            await loadData();
        } catch (e) {
            console.error('Re-enrich failed:', e);
        }
        setEnrichingIds(prev => { const next = new Set(prev); next.delete(vinylId); return next; });
    };

    // Flatten all tracks from all (filtered) vinyls for the track view
    const allTracks = filteredVinyls.flatMap((v) => {
        const tracks = parseTracks(v);
        const meta = parseMeta(v);
        return tracks.map((t, i) => ({
            ...t,
            bpm: typeof t === 'string' ? 0 : (t.bpm || 0),
            key: typeof t === 'string' ? '' : (t.key || ''),
            title: typeof t === 'string' ? t : (t.title || ''),
            position: typeof t === 'string' ? `${i + 1}` : (t.position || `${i + 1}`),
            vinylArtist: v.artist,
            vinylTitle: v.title,
            vinylLabel: v.label,
            vinylId: v.id,
            genre: meta.genre || '',
            vinyl: v
        }));
    });

    // Sort tracks
    const sortedTracks = [...allTracks].sort((a, b) => {
        const { key, dir } = sortConfig;
        let av = a[key], bv = b[key];
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
    });

    const toggleSort = (key) => {
        setSortConfig((prev) => ({
            key,
            dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc'
        }));
    };

    return (
        <div className="p-4 sm:p-6 md:p-10 max-w-7xl mx-auto space-y-4 sm:space-y-6">
            {/* Header */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground flex items-center gap-2 sm:gap-3">
                        <Disc3 className="w-6 h-6 sm:w-8 sm:h-8 text-purple-400" />
                        Vinyl Crate
                    </h1>
                    <div className="flex items-center gap-2">
                        <span className="text-xs sm:text-sm font-medium bg-purple-500/10 text-purple-400 px-2 sm:px-3 py-1 rounded-full border border-purple-500/20">
                            {filteredVinyls.length}{searchQuery ? `/${vinyls.length}` : ''}
                        </span>
                        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} disabled={uploading} />
                        <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                            className="flex items-center gap-1.5 px-3 sm:px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-xs sm:text-sm font-medium transition-all shadow-lg shadow-purple-600/20">
                            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                            <span className="hidden sm:inline">{uploading ? 'Processing...' : 'Upload Vinyl'}</span>
                        </button>
                    </div>
                </div>

                {/* Search + View Toggle */}
                <div className="flex flex-wrap gap-2">
                    <div className="relative flex-1 min-w-[140px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input type="text" placeholder="Search..."
                            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-10 py-2 sm:py-2.5 bg-muted border border-zinc-700/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 transition-all" />
                        {searchQuery && (
                            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1">
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                    <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden shrink-0">
                        <button onClick={() => setViewMode('crate')}
                            className={`p-2.5 transition-colors ${viewMode === 'crate' ? 'bg-purple-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                            title="Crate View">
                            <LayoutGrid className="w-4 h-4" />
                        </button>
                        <button onClick={() => setViewMode('tracks')}
                            className={`p-2.5 transition-colors ${viewMode === 'tracks' ? 'bg-purple-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                            title="Track View">
                            <List className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Crate Strip */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
                {crates.length > 0 && (
                    <button onClick={() => { setActiveCrateId(null); setCrateVinyls(null); }}
                        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${activeCrateId === null ? 'bg-purple-600 text-white border-purple-500' : 'bg-muted text-muted-foreground border-zinc-700/50 hover:text-foreground'}`}>
                        All Vinyls <span className="ml-1.5 text-[10px] opacity-60">{vinyls.length}</span>
                    </button>
                )}
                {crates.map(crate => (
                    <button key={crate.id}
                        onClick={() => setActiveCrateId(crate.id)}
                        onContextMenu={(e) => { e.preventDefault(); setEditingCrate(crate); setShowCrateModal(true); }}
                        className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${activeCrateId === crate.id ? 'bg-purple-600 text-white border-purple-500' : 'bg-muted text-muted-foreground border-zinc-700/50 hover:text-foreground'}`}>
                        {crate.icon && <span>{crate.icon}</span>}
                        {crate.name}
                        {crate.type === 'smart' && <Sparkles className="w-2.5 h-2.5 text-indigo-300/70" />}
                        {activeCrateId === crate.id && (
                            <span onClick={(e) => { e.stopPropagation(); setEditingCrate(crate); setShowCrateModal(true); }}
                                className="ml-0.5 p-0.5 rounded-full hover:bg-white/20 transition-colors" title="Edit Crate">
                                <Pencil className="w-2.5 h-2.5" />
                            </span>
                        )}
                    </button>
                ))}
                <button onClick={() => { setEditingCrate(null); setShowCrateModal(true); }}
                    className="shrink-0 flex items-center gap-1.5 p-1.5 rounded-full border border-dashed border-zinc-700/50 text-muted-foreground hover:text-foreground hover:border-zinc-500 hover:bg-muted transition-colors"
                    title="Create Crate">
                    <Plus className="w-3.5 h-3.5" />
                    {crates.length === 0 && <span className="text-xs pr-1">New Crate</span>}
                </button>
            </div>

            {/* Upload Status */}
            <AnimatePresence>
                {uploadStatus && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                        className={`px-3 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-medium ${uploadStatus.startsWith('Error') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : uploading ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                        {uploadStatus}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Enrichment Status */}
            <AnimatePresence>
                {enrichingIds.size > 0 && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                        className="flex items-center gap-3 px-3 sm:px-4 py-2.5 rounded-lg text-xs sm:text-sm font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        <span>Enriching {enrichingIds.size} vinyl{enrichingIds.size > 1 ? 's' : ''} — searching Discogs, MusicBrainz, Beatport...</span>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Grid — 2 cols mobile, scales up */}
            {loading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6 animate-pulse">
                    {[...Array(8)].map((_, i) => <div key={i} className="aspect-square bg-muted rounded-lg" />)}
                </div>
            ) : viewMode === 'crate' ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
                    {filteredVinyls.map((vinyl) => {
                        const meta = parseMeta(vinyl);
                        const tracks = parseTracks(vinyl);
                        const conf = meta.enrichmentConfidence || 0;
                        const confInfo = getConfidenceInfo(conf);
                        const isEnriching = enrichingIds.has(vinyl.id) || vinyl.enrichment_status === 'enriching';
                        const isFailed = vinyl.enrichment_status === 'failed';

                        return (
                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} key={vinyl.id}
                                className="group relative flex flex-col space-y-1.5 cursor-pointer active:scale-[0.98] transition-transform"
                                onClick={() => openDetail(vinyl)}>
                                <div className="aspect-square relative overflow-hidden rounded-lg shadow-sm border border-zinc-700/50 bg-muted">
                                    <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title}
                                        className={`object-cover w-full h-full transition-transform duration-300 group-hover:scale-105 ${isEnriching ? 'opacity-60' : ''}`} loading="lazy" />

                                    {/* Enriching overlay */}
                                    {isEnriching && (
                                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center rounded-lg">
                                            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
                                        </div>
                                    )}

                                    {/* Failed badge */}
                                    {isFailed && (
                                        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-red-900/80 text-[9px] text-red-300 border border-red-700/50 cursor-pointer hover:bg-red-800/80 z-10"
                                            onClick={(e) => { e.stopPropagation(); handleRetryEnrich(vinyl.id); }}>
                                            Retry
                                        </div>
                                    )}

                                    {/* Confidence badge */}
                                    {!isEnriching && conf > 0 && conf < 0.8 && (
                                        <div className={`absolute top-1 right-1 px-1 py-0.5 rounded text-[8px] sm:text-[9px] font-medium border ${confInfo.bg} ${confInfo.color}`}>
                                            <AlertTriangle className="w-2 h-2 sm:w-2.5 sm:h-2.5 inline mr-0.5" />{confInfo.label}
                                        </div>
                                    )}

                                    {/* RPM badge */}
                                    {meta.rpm > 0 && (
                                        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-zinc-900/70 text-[8px] sm:text-[9px] font-mono text-zinc-300 border border-zinc-600/30">
                                            {meta.rpm} RPM
                                        </div>
                                    )}

                                    {/* Add to Crate button — hidden on touch, shown on hover */}
                                    {crates.filter(c => c.type === 'manual').length > 0 && !isEnriching && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowAddToCrateMenu(showAddToCrateMenu === vinyl.id ? null : vinyl.id); }}
                                            className="absolute top-1 right-1 p-1 rounded bg-zinc-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-purple-600/80 z-10"
                                            style={conf > 0 && conf < 0.8 ? { right: '3.5rem' } : {}}
                                            title="Add to Crate">
                                            <FolderPlus className="w-3 h-3" />
                                        </button>
                                    )}

                                    {/* Add to Crate dropdown */}
                                    {showAddToCrateMenu === vinyl.id && (
                                        <div className="absolute top-8 right-1 z-20 bg-zinc-900 border border-zinc-700/50 rounded-lg shadow-xl py-1 min-w-[120px]"
                                            onClick={(e) => e.stopPropagation()}>
                                            {crates.filter(c => c.type === 'manual').map(crate => (
                                                <button key={crate.id}
                                                    onClick={async (e) => {
                                                        e.stopPropagation();
                                                        await addVinylToCrate(crate.id, vinyl.id);
                                                        setShowAddToCrateMenu(null);
                                                        if (activeCrateId === crate.id) {
                                                            const res = await getCrateVinyls(crate.id);
                                                            if (res.success) setCrateVinyls(res.data || []);
                                                        }
                                                    }}
                                                    className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-zinc-800 transition-colors flex items-center gap-1.5">
                                                    {crate.icon && <span>{crate.icon}</span>}
                                                    {crate.name}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* Hover overlay — hidden on touch */}
                                    {!isEnriching && (
                                        <div className="hidden sm:flex absolute inset-0 bg-black/75 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex-col items-center justify-center text-white p-3 text-center gap-1">
                                            <p className="font-bold text-sm">{vinyl.title}</p>
                                            <p className="text-xs text-white/80">{vinyl.artist}</p>
                                            <p className="text-[10px] uppercase tracking-widest text-white/50">{vinyl.label}</p>
                                            {tracks.length > 0 && (
                                                <div className="mt-1 text-[9px] text-white/60 w-full max-h-16 overflow-hidden space-y-0.5">
                                                    {tracks.slice(0, 3).map((t, i) => (
                                                        <div key={i} className="flex items-center justify-between gap-1 px-1">
                                                            <span className="truncate"><Music className="w-2 h-2 inline mr-0.5" />{t.position || ''} {typeof t === 'string' ? t : (t.title || '')}</span>
                                                            <span className="shrink-0 space-x-1">
                                                                {t.bpm > 0 && <span className="text-purple-300 font-mono">{t.bpm}</span>}
                                                                {t.key && <span className="text-indigo-300 font-mono">{t.key}</span>}
                                                            </span>
                                                        </div>
                                                    ))}
                                                    {tracks.length > 3 && <div>+{tracks.length - 3} more</div>}
                                                </div>
                                            )}
                                            <p className="text-[10px] mt-1 text-purple-300/70">Tap to view</p>
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-0.5 min-w-0">
                                    <h3 className="font-semibold text-xs sm:text-sm truncate">{vinyl.title || 'Enriching...'}</h3>
                                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{vinyl.artist || ''}</p>
                                    {meta.genre && <p className="text-[9px] sm:text-[10px] text-amber-400/70 truncate">{meta.genre}</p>}
                                </div>
                            </motion.div>
                        );
                    })}
                </div>
            ) : (
                /* === TRACK VIEW === */
                <div className="bg-zinc-900/50 rounded-lg border border-zinc-700/30 overflow-x-auto">
                    <table className="w-full text-sm min-w-[600px]">
                        <thead>
                            <tr className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground border-b border-zinc-700/30">
                                <th className="px-3 py-2.5 text-left cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('title')}>
                                    <span className="flex items-center gap-1">Track <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                                <th className="px-3 py-2.5 text-left cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('vinylArtist')}>
                                    <span className="flex items-center gap-1">Artist <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                                <th className="px-3 py-2.5 text-left hidden sm:table-cell cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('vinylTitle')}>
                                    <span className="flex items-center gap-1">Release <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                                <th className="px-3 py-2.5 text-right w-16 cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('bpm')}>
                                    <span className="flex items-center justify-end gap-1">BPM <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                                <th className="px-3 py-2.5 text-right w-14 cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('key')}>
                                    <span className="flex items-center justify-end gap-1">Key <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                                <th className="px-3 py-2.5 text-left hidden md:table-cell cursor-pointer hover:text-foreground select-none" onClick={() => toggleSort('genre')}>
                                    <span className="flex items-center gap-1">Genre <ArrowUpDown className="w-3 h-3" /></span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedTracks.map((track, i) => (
                                <tr key={`${track.vinylId}-${track.position}-${i}`}
                                    className="border-b border-zinc-700/20 last:border-0 hover:bg-zinc-800/50 cursor-pointer transition-colors"
                                    onClick={() => openDetail(track.vinyl)}>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-mono text-muted-foreground w-5 shrink-0">{track.position}</span>
                                            <span className="text-foreground truncate">{track.title}</span>
                                        </div>
                                    </td>
                                    <td className="px-3 py-2 text-muted-foreground truncate">{track.vinylArtist}</td>
                                    <td className="px-3 py-2 text-muted-foreground truncate hidden sm:table-cell">{track.vinylTitle}</td>
                                    <td className="px-3 py-2 text-right font-mono">
                                        {track.bpm > 0 ? <span className="text-purple-300">{track.bpm}</span> : <span className="text-zinc-600">{"\u2014"}</span>}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono">
                                        {track.key ? <span className="text-indigo-300">{track.key}</span> : <span className="text-zinc-600">{"\u2014"}</span>}
                                    </td>
                                    <td className="px-3 py-2 text-amber-400/70 truncate hidden md:table-cell">{track.genre}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {sortedTracks.length === 0 && (
                        <div className="text-center py-8 text-muted-foreground text-sm">No tracks in your crate yet.</div>
                    )}
                </div>
            )}

            {/* Empty state */}
            {!loading && vinyls.length === 0 && (
                <div className="text-center py-16 sm:py-20 text-muted-foreground space-y-3">
                    <Disc3 className="w-12 h-12 sm:w-16 sm:h-16 mx-auto opacity-20" />
                    <p className="text-base sm:text-lg">Your crate is empty.</p>
                    <p className="text-xs sm:text-sm">Upload a photo of a vinyl cover or label.</p>
                    <button onClick={() => fileInputRef.current?.click()}
                        className="mx-auto mt-3 flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-all">
                        <Upload className="w-4 h-4" /> Upload Your First Vinyl
                    </button>
                </div>
            )}

            {!loading && filteredVinyls.length === 0 && vinyls.length > 0 && (
                <div className="text-center py-10 sm:py-12 text-muted-foreground">
                    <Search className="w-8 h-8 sm:w-10 sm:h-10 mx-auto opacity-20 mb-2" />
                    <p className="text-sm">No records match &quot;{searchQuery}&quot;</p>
                </div>
            )}

            {/* Crate Modal */}
            <AnimatePresence>
                {showCrateModal && (
                    <CrateModal
                        crate={editingCrate}
                        vinyls={vinyls}
                        onClose={() => { setShowCrateModal(false); setEditingCrate(null); }}
                        onSave={async (data) => {
                            if (editingCrate) {
                                await updateCrateAction(editingCrate.id, data);
                            } else {
                                await createCrate(data);
                            }
                            const res = await getCrates();
                            if (res.success) setCrates(res.data || []);
                            setShowCrateModal(false);
                            setEditingCrate(null);
                        }}
                        onDelete={async () => {
                            if (editingCrate) {
                                await deleteCrateAction(editingCrate.id);
                                if (activeCrateId === editingCrate.id) { setActiveCrateId(null); setCrateVinyls(null); }
                                const res = await getCrates();
                                if (res.success) setCrates(res.data || []);
                            }
                            setShowCrateModal(false);
                            setEditingCrate(null);
                        }}
                        parseMeta={parseMeta}
                    />
                )}
            </AnimatePresence>

            {/* Detail / Edit Modal */}
            <AnimatePresence>
                {selectedVinyl && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center"
                        onClick={(e) => { if (e.target === e.currentTarget) { setSelectedVinyl(null); setEditing(false); } }}>
                        <motion.div
                            initial={{ y: 100, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: 100, opacity: 0 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            className="bg-zinc-900 border border-zinc-700/50 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto sm:mx-4">

                            {/* Mobile drag handle */}
                            <div className="sm:hidden flex justify-center pt-2 pb-1">
                                <div className="w-10 h-1 rounded-full bg-zinc-600" />
                            </div>

                            <VinylDetailModal
                                vinyl={selectedVinyl} editing={editing} editFields={editFields} saving={saving}
                                onClose={() => { setSelectedVinyl(null); setEditing(false); }}
                                onEdit={startEditing} onSave={handleSave} onCancel={() => setEditing(false)}
                                onDelete={handleDelete}
                                onReEnrich={handleReEnrich}
                                reEnriching={enrichingIds.has(selectedVinyl?.id)}
                                refreshingValue={refreshingValue}
                                onRefreshValue={handleRefreshValue}
                                crates={crates}
                                onAddToCrate={async (crateId) => {
                                    await addVinylToCrate(crateId, selectedVinyl.id);
                                    if (activeCrateId === crateId) {
                                        const res = await getCrateVinyls(crateId);
                                        if (res.success) setCrateVinyls(res.data || []);
                                    }
                                }}
                                activeCrateId={activeCrateId}
                                onRemoveFromCrate={activeCrateId ? async () => {
                                    await removeVinylFromCrate(activeCrateId, selectedVinyl.id);
                                    const res = await getCrateVinyls(activeCrateId);
                                    if (res.success) setCrateVinyls(res.data || []);
                                } : null}
                                setEditFields={setEditFields} updateTrackField={updateTrackField}
                                parseMeta={parseMeta} parseTracks={parseTracks} getConfidenceInfo={getConfidenceInfo}
                            />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function VinylDetailModal({ vinyl, editing, editFields, saving, onClose, onEdit, onSave, onCancel, onDelete, onReEnrich, reEnriching, refreshingValue, onRefreshValue, crates, onAddToCrate, activeCrateId, onRemoveFromCrate, setEditFields, updateTrackField, parseMeta, parseTracks, getConfidenceInfo }) {
    const meta = parseMeta(vinyl);
    const tracks = parseTracks(vinyl);
    const conf = meta.enrichmentConfidence || 0;
    const confInfo = getConfidenceInfo(conf);
    const isEnriching = vinyl.enrichment_status === 'enriching';
    const [showCrateMenu, setShowCrateMenu] = useState(false);

    const Field = ({ label, field, type = 'text', metaField = false }) => {
        const value = metaField ? (editFields.meta?.[field] ?? meta[field] ?? '') : (editFields[field] ?? vinyl[field] ?? '');
        return (
            <div className="space-y-1">
                <label className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider">{label}</label>
                {editing ? (
                    <input type={type} value={value}
                        onChange={(e) => {
                            const val = type === 'number' ? Number(e.target.value) || 0 : e.target.value;
                            if (metaField) setEditFields({ ...editFields, meta: { ...editFields.meta, [field]: val } });
                            else setEditFields({ ...editFields, [field]: val });
                        }}
                        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-sm text-foreground focus:outline-none focus:border-purple-500" />
                ) : (
                    <p className="text-sm text-foreground">{String(value || '\u2014')}</p>
                )}
            </div>
        );
    };

    return (
        <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex gap-3 sm:gap-4 items-start flex-1 min-w-0">
                    <div className="w-20 h-20 sm:w-28 sm:h-28 rounded-lg overflow-hidden shrink-0 border border-zinc-700/50 relative group/cover">
                        <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title} className="w-full h-full object-cover" />
                        {meta.originalCoverUrl && meta.originalCoverUrl !== vinyl.cover_image_url && (
                            <a href={meta.originalCoverUrl} target="_blank" rel="noopener"
                                className="absolute bottom-1 right-1 p-1 rounded bg-black/70 text-zinc-300 hover:text-white hover:bg-black/90 transition-all opacity-0 group-hover/cover:opacity-100 sm:opacity-0 sm:group-hover/cover:opacity-100"
                                title="View original photo"
                                onClick={(e) => e.stopPropagation()}>
                                <Camera className="w-3 h-3" />
                            </a>
                        )}
                    </div>
                    <div className="space-y-1 min-w-0 flex-1">
                        {editing ? (
                            <>
                                <input value={editFields.title ?? vinyl.title ?? ''} onChange={(e) => setEditFields({ ...editFields, title: e.target.value })}
                                    className="text-lg sm:text-xl font-bold w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-foreground focus:outline-none focus:border-purple-500" />
                                <input value={editFields.artist ?? vinyl.artist ?? ''} onChange={(e) => setEditFields({ ...editFields, artist: e.target.value })}
                                    className="text-sm w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-muted-foreground focus:outline-none focus:border-purple-500" />
                            </>
                        ) : (
                            <>
                                <h2 className="text-lg sm:text-xl font-bold text-foreground truncate">{vinyl.title}</h2>
                                <p className="text-sm text-muted-foreground truncate">{vinyl.artist}</p>
                            </>
                        )}
                        {/* Badges row */}
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            {conf > 0 && (
                                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-medium border ${confInfo.bg} ${confInfo.color}`}>
                                    {conf < 0.8 ? <AlertTriangle className="w-2.5 h-2.5" /> : <Check className="w-2.5 h-2.5" />}
                                    {Math.round(conf * 100)}%
                                </span>
                            )}
                            {meta.rpm > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[9px] sm:text-[10px] font-mono text-zinc-400 border border-zinc-700/50">
                                    {meta.rpm} RPM
                                </span>
                            )}
                            {meta.year > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[9px] sm:text-[10px] text-zinc-400 border border-zinc-700/50">
                                    {meta.year}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {!editing && !isEnriching && (
                        <button onClick={onEdit} className="p-2 rounded-lg hover:bg-zinc-800 text-muted-foreground hover:text-foreground transition-colors" title="Edit">
                            <Pencil className="w-4 h-4" />
                        </button>
                    )}
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-zinc-800 text-muted-foreground hover:text-foreground transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Metadata Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
                <Field label="Label" field="label" />
                <Field label="Catalog #" field="catalog_number" />
                <Field label="Genre" field="genre" metaField />
                <Field label="Style" field="style" metaField />
                <Field label="Year" field="year" type="number" metaField />
                <Field label="RPM" field="rpm" type="number" metaField />
            </div>

            {/* Tracklist */}
            <div className="space-y-2">
                <h3 className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Music className="w-3 h-3" /> Tracklist
                </h3>
                {(editing ? editFields.tracks || tracks : tracks).length > 0 ? (
                    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700/30 overflow-x-auto">
                        <table className="w-full text-sm min-w-[400px]">
                            <thead>
                                <tr className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground border-b border-zinc-700/30">
                                    <th className="px-2 sm:px-3 py-2 text-left w-10">#</th>
                                    <th className="px-2 sm:px-3 py-2 text-left">Title</th>
                                    <th className="px-2 sm:px-3 py-2 text-right w-16">BPM</th>
                                    <th className="px-2 sm:px-3 py-2 text-right w-14">Key</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(editing ? editFields.tracks || tracks : tracks).map((track, i) => (
                                    <tr key={i} className="border-b border-zinc-700/20 last:border-0 hover:bg-zinc-800/50">
                                        <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-muted-foreground font-mono text-xs">
                                            {editing ? (
                                                <input value={track.position || ''} onChange={(e) => updateTrackField(i, 'position', e.target.value)}
                                                    className="w-8 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-purple-500" />
                                            ) : (track.position || (i + 1))}
                                        </td>
                                        <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-foreground text-xs sm:text-sm">
                                            {editing ? (
                                                <input value={track.title || ''} onChange={(e) => updateTrackField(i, 'title', e.target.value)}
                                                    className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs sm:text-sm focus:outline-none focus:border-purple-500" />
                                            ) : (typeof track === 'string' ? track : track.title)}
                                        </td>
                                        <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-right font-mono text-xs">
                                            {editing ? (
                                                <input type="number" value={track.bpm || 0} onChange={(e) => updateTrackField(i, 'bpm', e.target.value)}
                                                    className="w-14 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-[10px] text-right focus:outline-none focus:border-purple-500" />
                                            ) : (track.bpm > 0 ? <span className="text-purple-300">{track.bpm}</span> : <span className="text-zinc-600">{'\u2014'}</span>)}
                                        </td>
                                        <td className="px-2 sm:px-3 py-1.5 sm:py-2 text-right font-mono text-xs">
                                            {editing ? (
                                                <input value={track.key || ''} onChange={(e) => updateTrackField(i, 'key', e.target.value)}
                                                    className="w-12 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-[10px] text-right focus:outline-none focus:border-purple-500" />
                                            ) : (track.key ? <span className="text-indigo-300">{track.key}</span> : <span className="text-zinc-600">{'\u2014'}</span>)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="text-xs sm:text-sm text-muted-foreground">No tracklist available</p>
                )}
            </div>

            {/* Hidden Gems: Market Value */}
            {meta.priceGuide && (
                <div className="space-y-2">
                    <h3 className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <TrendingUp className="w-3 h-3 text-emerald-400" /> Market Value
                    </h3>
                    <div className="flex gap-3 bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/30">
                        <div className="text-center flex-1">
                            <p className="text-emerald-400 font-mono text-sm font-semibold">{meta.priceGuide.currency} {meta.priceGuide.median?.toFixed(2)}</p>
                            <p className="text-[10px] text-muted-foreground">Median</p>
                        </div>
                        <div className="text-center flex-1">
                            <p className="text-zinc-400 font-mono text-sm">{meta.priceGuide.lowest?.toFixed(2)}</p>
                            <p className="text-[10px] text-muted-foreground">Low</p>
                        </div>
                        <div className="text-center flex-1">
                            <p className="text-zinc-400 font-mono text-sm">{meta.priceGuide.highest?.toFixed(2)}</p>
                            <p className="text-[10px] text-muted-foreground">High</p>
                        </div>
                        <div className="text-center flex-1">
                            <p className="text-zinc-400 font-mono text-sm">{meta.priceGuide.numForSale}</p>
                            <p className="text-[10px] text-muted-foreground">Listings</p>
                        </div>
                    </div>
                    {meta.priceGuide.lastChecked && (
                        <p className="text-[9px] text-muted-foreground">Last checked {new Date(meta.priceGuide.lastChecked).toLocaleDateString()}</p>
                    )}
                </div>
            )}

            {/* Hidden Gems: History */}
            {meta.history && (
                <div className="space-y-2">
                    <h3 className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <BookOpen className="w-3 h-3 text-amber-400" /> About this Release
                    </h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{meta.history}</p>
                </div>
            )}

            {/* External Links */}
            {(meta.discogsUrl || meta.beatportUrl) && (
                <div className="flex gap-3">
                    {meta.discogsUrl && (
                        <a href={meta.discogsUrl} target="_blank" rel="noopener" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 underline">
                            <ExternalLink className="w-3 h-3" /> Discogs
                        </a>
                    )}
                    {meta.beatportUrl && (
                        <a href={meta.beatportUrl} target="_blank" rel="noopener" className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1 underline">
                            <ExternalLink className="w-3 h-3" /> Beatport
                        </a>
                    )}
                </div>
            )}

            {/* Edit Actions */}
            {editing && (
                <div className="flex gap-3 justify-end pt-3 border-t border-zinc-700/30">
                    <button onClick={onCancel} className="px-3 sm:px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-zinc-800 transition-colors">Cancel</button>
                    <button onClick={onSave} disabled={saving}
                        className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-all">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Save
                    </button>
                </div>
            )}

            {/* Actions — separated from close/edit for safety */}
            {!editing && (
                <div className="flex items-center justify-between pt-3 border-t border-zinc-700/30">
                    <div className="flex items-center gap-1">
                        <button onClick={onReEnrich} disabled={reEnriching || isEnriching}
                            className="flex items-center gap-2 px-3 py-2 text-xs text-purple-400/70 hover:text-purple-400 hover:bg-purple-900/20 disabled:opacity-50 rounded-lg transition-colors">
                            {reEnriching || isEnriching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            {reEnriching || isEnriching ? 'Enriching...' : 'Re-enrich'}
                        </button>
                        <button onClick={onRefreshValue} disabled={refreshingValue || isEnriching}
                            className="flex items-center gap-2 px-3 py-2 text-xs text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-900/20 disabled:opacity-50 rounded-lg transition-colors">
                            {refreshingValue ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
                            {refreshingValue ? 'Fetching...' : (meta.priceGuide ? 'Refresh Value' : 'Check Value')}
                        </button>
                        {crates.filter(c => c.type === 'manual').length > 0 && (
                            <div className="relative">
                                <button onClick={() => setShowCrateMenu(!showCrateMenu)}
                                    className="flex items-center gap-2 px-3 py-2 text-xs text-indigo-400/70 hover:text-indigo-400 hover:bg-indigo-900/20 rounded-lg transition-colors">
                                    <FolderPlus className="w-3.5 h-3.5" />
                                    Add to Crate
                                </button>
                                {showCrateMenu && (
                                    <div className="absolute bottom-full mb-1 left-0 z-20 bg-zinc-900 border border-zinc-700/50 rounded-lg shadow-xl py-1 min-w-[140px]">
                                        {crates.filter(c => c.type === 'manual').map(crate => (
                                            <button key={crate.id}
                                                onClick={async () => { await onAddToCrate(crate.id); setShowCrateMenu(false); }}
                                                className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground hover:bg-zinc-800 transition-colors flex items-center gap-1.5">
                                                {crate.icon && <span>{crate.icon}</span>}
                                                {crate.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {onRemoveFromCrate && (
                            <button onClick={async () => { await onRemoveFromCrate(); onClose(); }}
                                className="flex items-center gap-2 px-3 py-2 text-xs text-orange-400/70 hover:text-orange-400 hover:bg-orange-900/20 rounded-lg transition-colors">
                                <X className="w-3.5 h-3.5" />
                                Remove from Crate
                            </button>
                        )}
                    </div>
                    <button onClick={onDelete}
                        className="flex items-center gap-2 px-3 py-2 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
}

function CrateModal({ crate, vinyls, onClose, onSave, onDelete, parseMeta }) {
    const [name, setName] = useState(crate?.name || '');
    const [type, setType] = useState(crate?.type || 'manual');
    const [icon, setIcon] = useState(crate?.icon || '');
    const [rules, setRules] = useState(crate?.rules || {});
    const [saving, setSaving] = useState(false);

    const updateRule = (key, value) => setRules(prev => ({ ...prev, [key]: value }));

    // Count matching vinyls for smart crate preview
    const matchCount = type === 'smart' ? vinyls.filter(v => {
        const meta = parseMeta(v);
        const tracks = typeof v.tracks === 'string' ? JSON.parse(v.tracks || '[]') : (v.tracks || []);
        if (rules.genre && !meta.genre?.toLowerCase().includes(rules.genre.toLowerCase())) return false;
        if (rules.style && !meta.style?.toLowerCase().includes(rules.style.toLowerCase())) return false;
        if (rules.label && !v.label?.toLowerCase().includes(rules.label.toLowerCase())) return false;
        if (rules.rpm && meta.rpm && meta.rpm !== Number(rules.rpm)) return false;
        if (rules.yearMin && meta.year && meta.year < Number(rules.yearMin)) return false;
        if (rules.yearMax && meta.year && meta.year > Number(rules.yearMax)) return false;
        if (rules.bpmMin || rules.bpmMax) {
            const has = tracks.some(t => {
                const bpm = t.bpm || 0;
                if (!bpm) return false;
                if (rules.bpmMin && bpm < Number(rules.bpmMin)) return false;
                if (rules.bpmMax && bpm > Number(rules.bpmMax)) return false;
                return true;
            });
            if (!has) return false;
        }
        return true;
    }).length : 0;

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        await onSave({ name: name.trim(), type, icon: icon || null, rules: type === 'smart' ? rules : null });
        setSaving(false);
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                className="bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-5 space-y-4">
                <h2 className="text-lg font-bold">{crate ? 'Edit Crate' : 'New Crate'}</h2>

                {/* Name */}
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">Name</label>
                    <div className="flex gap-2">
                        <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Icon" maxLength={2}
                            className="w-12 px-2 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-center focus:outline-none focus:border-purple-500" />
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Crate name"
                            className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-purple-500" autoFocus />
                    </div>
                </div>

                {/* Type toggle */}
                <div className="space-y-1">
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">Type</label>
                    <div className="flex rounded-lg border border-zinc-700/50 overflow-hidden">
                        <button onClick={() => setType('manual')}
                            className={`flex-1 py-2 text-xs font-medium transition-colors ${type === 'manual' ? 'bg-purple-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                            Manual
                        </button>
                        <button onClick={() => setType('smart')}
                            className={`flex-1 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${type === 'smart' ? 'bg-purple-600 text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}>
                            <Sparkles className="w-3 h-3" /> Smart
                        </button>
                    </div>
                </div>

                {/* Smart rules */}
                {type === 'smart' && (
                    <div className="space-y-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/30">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground uppercase tracking-wider">Filter Rules</label>
                            <span className="text-[10px] text-purple-400">{matchCount} match{matchCount !== 1 ? 'es' : ''}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">Genre</label>
                                <input value={rules.genre || ''} onChange={(e) => updateRule('genre', e.target.value)} placeholder="e.g. Techno"
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">Style</label>
                                <input value={rules.style || ''} onChange={(e) => updateRule('style', e.target.value)} placeholder="e.g. Deep House"
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">Year Min</label>
                                <input type="number" value={rules.yearMin || ''} onChange={(e) => updateRule('yearMin', e.target.value ? Number(e.target.value) : '')}
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">Year Max</label>
                                <input type="number" value={rules.yearMax || ''} onChange={(e) => updateRule('yearMax', e.target.value ? Number(e.target.value) : '')}
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">BPM Min</label>
                                <input type="number" value={rules.bpmMin || ''} onChange={(e) => updateRule('bpmMin', e.target.value ? Number(e.target.value) : '')}
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">BPM Max</label>
                                <input type="number" value={rules.bpmMax || ''} onChange={(e) => updateRule('bpmMax', e.target.value ? Number(e.target.value) : '')}
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">Label</label>
                                <input value={rules.label || ''} onChange={(e) => updateRule('label', e.target.value)} placeholder="e.g. Warp"
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500" />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-muted-foreground">RPM</label>
                                <select value={rules.rpm || ''} onChange={(e) => updateRule('rpm', e.target.value ? Number(e.target.value) : '')}
                                    className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-xs focus:outline-none focus:border-purple-500">
                                    <option value="">Any</option>
                                    <option value="33">33 RPM</option>
                                    <option value="45">45 RPM</option>
                                    <option value="78">78 RPM</option>
                                </select>
                            </div>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between pt-2">
                    {crate ? (
                        <button onClick={onDelete} className="text-xs text-red-400/60 hover:text-red-400 transition-colors">Delete Crate</button>
                    ) : <div />}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-zinc-800 transition-colors">Cancel</button>
                        <button onClick={handleSave} disabled={saving || !name.trim()}
                            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-all">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            {crate ? 'Save' : 'Create'}
                        </button>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}
