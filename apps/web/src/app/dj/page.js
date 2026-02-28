'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getVinylCrate, uploadVinylPhoto, updateVinyl } from '../actions';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { Upload, Disc3, Music, ExternalLink, Loader2, Search, X, AlertTriangle, Check, Pencil } from 'lucide-react';

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
    const fileInputRef = useRef(null);

    async function loadCrate() {
        setLoading(true);
        const res = await getVinylCrate(200);
        if (res.success) setVinyls(res.data || []);
        else setVinyls([]);
        setLoading(false);
    }

    useEffect(() => {
        loadCrate();
        const socket = io();
        socket.on('dj:vinyl:update', (newVinyl) => {
            setVinyls((prev) => {
                const exists = prev.findIndex(v => v.id === newVinyl.id);
                if (exists >= 0) {
                    const updated = [...prev];
                    updated[exists] = newVinyl;
                    return updated;
                }
                return [newVinyl, ...prev];
            });
        });
        return () => socket.disconnect();
    }, []);

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
            setUploadStatus('Analyzing vinyl & enriching metadata...');
            const result = await uploadVinylPhoto(base64, file.type);
            if (result.success) {
                setUploadStatus(`Added ${result.data.vinyls?.length || 0} vinyl(s)!`);
                await loadCrate();
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

    const parseMeta = (vinyl) => {
        try {
            if (typeof vinyl.meta === 'string') return JSON.parse(vinyl.meta);
            if (vinyl.meta) return vinyl.meta;
        } catch { /* ignore */ }
        return {};
    };

    const parseTracks = (vinyl) => {
        try {
            if (typeof vinyl.tracks === 'string') return JSON.parse(vinyl.tracks);
            if (Array.isArray(vinyl.tracks)) return vinyl.tracks;
        } catch { /* ignore */ }
        return [];
    };

    const getConfidenceInfo = (confidence) => {
        if (confidence >= 0.8) return { label: 'High', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: Check };
        if (confidence >= 0.5) return { label: 'Medium', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', icon: AlertTriangle };
        return { label: 'Low', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: AlertTriangle };
    };

    const filteredVinyls = searchQuery.trim()
        ? vinyls.filter((v) => {
            const q = searchQuery.toLowerCase();
            const meta = parseMeta(v);
            return (
                v.artist?.toLowerCase().includes(q) ||
                v.title?.toLowerCase().includes(q) ||
                v.label?.toLowerCase().includes(q) ||
                v.catalog_number?.toLowerCase().includes(q) ||
                meta.genre?.toLowerCase().includes(q) ||
                meta.style?.toLowerCase().includes(q)
            );
        })
        : vinyls;

    const openDetail = (vinyl) => {
        setSelectedVinyl(vinyl);
        setEditing(false);
        setEditFields({});
    };

    const startEditing = () => {
        const meta = parseMeta(selectedVinyl);
        const tracks = parseTracks(selectedVinyl);
        setEditFields({
            artist: selectedVinyl.artist || '',
            title: selectedVinyl.title || '',
            label: selectedVinyl.label || '',
            catalog_number: selectedVinyl.catalog_number || '',
            bpm: selectedVinyl.bpm || 0,
            key: selectedVinyl.key || '',
            tracks: tracks,
            meta: meta
        });
        setEditing(true);
    };

    const handleSave = async () => {
        if (!selectedVinyl) return;
        setSaving(true);
        const result = await updateVinyl(selectedVinyl.id, editFields);
        if (result.success) {
            await loadCrate();
            setSelectedVinyl(result.data?.vinyl || { ...selectedVinyl, ...editFields });
            setEditing(false);
        }
        setSaving(false);
    };

    const updateTrackField = (idx, field, value) => {
        const newTracks = [...(editFields.tracks || [])];
        newTracks[idx] = { ...newTracks[idx], [field]: field === 'bpm' ? Number(value) || 0 : value };
        setEditFields({ ...editFields, tracks: newTracks });
    };

    return (
        <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
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
                        {filteredVinyls.length}{searchQuery ? ` / ${vinyls.length}` : ''} Records
                    </span>
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} disabled={uploading} />
                    <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-purple-600/20">
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        {uploading ? 'Processing...' : 'Upload Vinyl'}
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                    type="text"
                    placeholder="Search by artist, title, label, genre..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-10 py-2.5 bg-muted border border-zinc-700/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 transition-all"
                />
                {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            {/* Upload Status */}
            <AnimatePresence>
                {uploadStatus && (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                        className={`px-4 py-3 rounded-lg text-sm font-medium ${uploadStatus.startsWith('Error') ? 'bg-red-500/10 text-red-400 border border-red-500/20' : uploading ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                        {uploadStatus}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Grid */}
            {loading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 animate-pulse">
                    {[...Array(10)].map((_, i) => <div key={i} className="aspect-square bg-muted rounded-lg" />)}
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                    {filteredVinyls.map((vinyl) => {
                        const meta = parseMeta(vinyl);
                        const tracks = parseTracks(vinyl);
                        const confidence = meta.enrichmentConfidence || 0;
                        const confInfo = getConfidenceInfo(confidence);

                        return (
                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} key={vinyl.id}
                                className="group relative flex flex-col space-y-2 cursor-pointer"
                                onClick={() => openDetail(vinyl)}>
                                <div className="aspect-square relative overflow-hidden rounded-lg shadow-sm border border-zinc-700/50 bg-muted">
                                    <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title}
                                        className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105" loading="lazy" />

                                    {/* Confidence indicator */}
                                    {confidence > 0 && confidence < 0.8 && (
                                        <div className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[9px] font-medium border ${confInfo.bg} ${confInfo.color}`}>
                                            <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />{confInfo.label}
                                        </div>
                                    )}

                                    {/* Hover Overlay */}
                                    <div className="absolute inset-0 bg-black/75 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white p-3 text-center gap-1.5">
                                        <p className="font-bold text-sm">{vinyl.title}</p>
                                        <p className="text-xs text-white/80">{vinyl.artist}</p>
                                        <p className="text-[10px] uppercase tracking-widest text-white/50">{vinyl.label}</p>

                                        {tracks.length > 0 && (
                                            <div className="mt-1.5 text-[9px] text-white/60 w-full max-h-20 overflow-hidden space-y-0.5">
                                                {tracks.slice(0, 4).map((t, i) => (
                                                    <div key={i} className="flex items-center justify-between gap-1 px-1">
                                                        <span className="flex items-center gap-1 truncate">
                                                            <Music className="w-2 h-2 shrink-0" />
                                                            <span className="truncate">{t.position || ''} {t.title || t}</span>
                                                        </span>
                                                        {t.bpm > 0 && <span className="text-purple-300 font-mono shrink-0">{t.bpm}</span>}
                                                    </div>
                                                ))}
                                                {tracks.length > 4 && <div className="text-center">+{tracks.length - 4} more</div>}
                                            </div>
                                        )}

                                        <p className="text-[10px] mt-1 text-purple-300">Click to view details</p>
                                    </div>
                                </div>

                                <div className="space-y-0.5">
                                    <h3 className="font-semibold text-sm truncate">{vinyl.title}</h3>
                                    <p className="text-xs text-muted-foreground truncate">{vinyl.artist}</p>
                                    {meta.genre && (
                                        <p className="text-[10px] text-amber-400/70 truncate">{meta.genre}</p>
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
                    <button onClick={() => fileInputRef.current?.click()}
                        className="mx-auto mt-4 flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-all">
                        <Upload className="w-4 h-4" /> Upload Your First Vinyl
                    </button>
                </div>
            )}

            {!loading && filteredVinyls.length === 0 && vinyls.length > 0 && (
                <div className="text-center py-12 text-muted-foreground">
                    <Search className="w-10 h-10 mx-auto opacity-20 mb-3" />
                    <p>No records match &quot;{searchQuery}&quot;</p>
                </div>
            )}

            {/* Detail / Edit Modal */}
            <AnimatePresence>
                {selectedVinyl && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
                        onClick={(e) => { if (e.target === e.currentTarget) { setSelectedVinyl(null); setEditing(false); } }}>
                        <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">

                            <VinylDetailModal
                                vinyl={selectedVinyl}
                                editing={editing}
                                editFields={editFields}
                                saving={saving}
                                onClose={() => { setSelectedVinyl(null); setEditing(false); }}
                                onEdit={startEditing}
                                onSave={handleSave}
                                onCancel={() => setEditing(false)}
                                setEditFields={setEditFields}
                                updateTrackField={updateTrackField}
                                parseMeta={parseMeta}
                                parseTracks={parseTracks}
                                getConfidenceInfo={getConfidenceInfo}
                            />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function VinylDetailModal({ vinyl, editing, editFields, saving, onClose, onEdit, onSave, onCancel, setEditFields, updateTrackField, parseMeta, parseTracks, getConfidenceInfo }) {
    const meta = parseMeta(vinyl);
    const tracks = parseTracks(vinyl);
    const confidence = meta.enrichmentConfidence || 0;
    const confInfo = getConfidenceInfo(confidence);

    const InputField = ({ label, field, type = 'text', metaField = false }) => {
        const value = metaField
            ? (editFields.meta?.[field] ?? meta[field] ?? '')
            : (editFields[field] ?? vinyl[field] ?? '');

        return (
            <div className="space-y-1">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">{label}</label>
                {editing ? (
                    <input type={type} value={value}
                        onChange={(e) => {
                            const val = type === 'number' ? Number(e.target.value) || 0 : e.target.value;
                            if (metaField) {
                                setEditFields({ ...editFields, meta: { ...editFields.meta, [field]: val } });
                            } else {
                                setEditFields({ ...editFields, [field]: val });
                            }
                        }}
                        className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-600 rounded text-sm text-foreground focus:outline-none focus:border-purple-500" />
                ) : (
                    <p className="text-sm text-foreground">{String(value || '—')}</p>
                )}
            </div>
        );
    };

    return (
        <div className="p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex gap-4 items-start flex-1">
                    <div className="w-28 h-28 rounded-lg overflow-hidden shrink-0 border border-zinc-700/50">
                        <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title} className="w-full h-full object-cover" />
                    </div>
                    <div className="space-y-1 min-w-0">
                        {editing ? (
                            <>
                                <input value={editFields.title ?? vinyl.title ?? ''} onChange={(e) => setEditFields({ ...editFields, title: e.target.value })}
                                    className="text-xl font-bold w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-foreground focus:outline-none focus:border-purple-500" />
                                <input value={editFields.artist ?? vinyl.artist ?? ''} onChange={(e) => setEditFields({ ...editFields, artist: e.target.value })}
                                    className="text-sm w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-muted-foreground focus:outline-none focus:border-purple-500" />
                            </>
                        ) : (
                            <>
                                <h2 className="text-xl font-bold text-foreground truncate">{vinyl.title}</h2>
                                <p className="text-sm text-muted-foreground">{vinyl.artist}</p>
                            </>
                        )}
                        {confidence > 0 && (
                            <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${confInfo.bg} ${confInfo.color} mt-1`}>
                                {confidence < 0.8 ? <AlertTriangle className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                                Metadata confidence: {confInfo.label} ({Math.round(confidence * 100)}%)
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {!editing && (
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
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <InputField label="Label" field="label" />
                <InputField label="Catalog #" field="catalog_number" />
                <InputField label="Genre" field="genre" metaField />
                <InputField label="Style" field="style" metaField />
                <InputField label="Year" field="year" type="number" metaField />
            </div>

            {/* Tracklist */}
            <div className="space-y-2">
                <h3 className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <Music className="w-3 h-3" /> Tracklist
                </h3>
                {(editing ? editFields.tracks || tracks : tracks).length > 0 ? (
                    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700/30 overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-zinc-700/30">
                                    <th className="px-3 py-2 text-left w-12">#</th>
                                    <th className="px-3 py-2 text-left">Title</th>
                                    <th className="px-3 py-2 text-right w-20">BPM</th>
                                    <th className="px-3 py-2 text-right w-16">Key</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(editing ? editFields.tracks || tracks : tracks).map((track, i) => (
                                    <tr key={i} className="border-b border-zinc-700/20 last:border-0 hover:bg-zinc-800/50">
                                        <td className="px-3 py-2 text-muted-foreground font-mono text-xs">
                                            {editing ? (
                                                <input value={track.position || ''} onChange={(e) => updateTrackField(i, 'position', e.target.value)}
                                                    className="w-10 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-xs focus:outline-none focus:border-purple-500" />
                                            ) : (
                                                track.position || (i + 1)
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-foreground">
                                            {editing ? (
                                                <input value={track.title || ''} onChange={(e) => updateTrackField(i, 'title', e.target.value)}
                                                    className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-sm focus:outline-none focus:border-purple-500" />
                                            ) : (
                                                typeof track === 'string' ? track : track.title
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono">
                                            {editing ? (
                                                <input type="number" value={track.bpm || 0} onChange={(e) => updateTrackField(i, 'bpm', e.target.value)}
                                                    className="w-16 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:border-purple-500" />
                                            ) : (
                                                track.bpm > 0 ? <span className="text-purple-300">{track.bpm}</span> : <span className="text-zinc-600">—</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono">
                                            {editing ? (
                                                <input value={track.key || ''} onChange={(e) => updateTrackField(i, 'key', e.target.value)}
                                                    className="w-14 bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:border-purple-500" />
                                            ) : (
                                                track.key ? <span className="text-indigo-300">{track.key}</span> : <span className="text-zinc-600">—</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">No tracklist available</p>
                )}
            </div>

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
                <div className="flex gap-3 justify-end pt-2 border-t border-zinc-700/30">
                    <button onClick={onCancel} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-zinc-800 transition-colors">
                        Cancel
                    </button>
                    <button onClick={onSave} disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-all">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        Save Changes
                    </button>
                </div>
            )}
        </div>
    );
}
