'use client';

import { useState, useEffect, useRef } from 'react';
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
        socket.on('dj:vinyl:update', (v) => {
            setVinyls((prev) => {
                const idx = prev.findIndex(x => x.id === v.id);
                if (idx >= 0) { const u = [...prev]; u[idx] = v; return u; }
                return [v, ...prev];
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
            setUploadStatus('Analyzing & enriching...');
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

    const parseMeta = (v) => { try { return typeof v.meta === 'string' ? JSON.parse(v.meta) : (v.meta || {}); } catch { return {}; } };
    const parseTracks = (v) => { try { if (typeof v.tracks === 'string') return JSON.parse(v.tracks); return Array.isArray(v.tracks) ? v.tracks : []; } catch { return []; } };

    const getConfidenceInfo = (c) => {
        if (c >= 0.8) return { label: 'High', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' };
        if (c >= 0.5) return { label: 'Medium', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' };
        return { label: 'Low', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' };
    };

    const filteredVinyls = searchQuery.trim()
        ? vinyls.filter((v) => {
            const q = searchQuery.toLowerCase();
            const m = parseMeta(v);
            return v.artist?.toLowerCase().includes(q) || v.title?.toLowerCase().includes(q) ||
                v.label?.toLowerCase().includes(q) || v.catalog_number?.toLowerCase().includes(q) ||
                m.genre?.toLowerCase().includes(q) || m.style?.toLowerCase().includes(q);
        })
        : vinyls;

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
            await loadCrate();
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

                {/* Search Bar */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input type="text" placeholder="Search artist, title, label, genre..."
                        value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-10 py-2 sm:py-2.5 bg-muted border border-zinc-700/50 rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 transition-all" />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
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

            {/* Grid — 2 cols mobile, scales up */}
            {loading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6 animate-pulse">
                    {[...Array(8)].map((_, i) => <div key={i} className="aspect-square bg-muted rounded-lg" />)}
                </div>
            ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 md:gap-6">
                    {filteredVinyls.map((vinyl) => {
                        const meta = parseMeta(vinyl);
                        const tracks = parseTracks(vinyl);
                        const conf = meta.enrichmentConfidence || 0;
                        const confInfo = getConfidenceInfo(conf);

                        return (
                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} key={vinyl.id}
                                className="group relative flex flex-col space-y-1.5 cursor-pointer active:scale-[0.98] transition-transform"
                                onClick={() => openDetail(vinyl)}>
                                <div className="aspect-square relative overflow-hidden rounded-lg shadow-sm border border-zinc-700/50 bg-muted">
                                    <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title}
                                        className="object-cover w-full h-full transition-transform duration-300 group-hover:scale-105" loading="lazy" />

                                    {/* Confidence badge */}
                                    {conf > 0 && conf < 0.8 && (
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

                                    {/* Hover overlay — hidden on touch */}
                                    <div className="hidden sm:flex absolute inset-0 bg-black/75 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex-col items-center justify-center text-white p-3 text-center gap-1">
                                        <p className="font-bold text-sm">{vinyl.title}</p>
                                        <p className="text-xs text-white/80">{vinyl.artist}</p>
                                        <p className="text-[10px] uppercase tracking-widest text-white/50">{vinyl.label}</p>
                                        {tracks.length > 0 && (
                                            <div className="mt-1 text-[9px] text-white/60 w-full max-h-16 overflow-hidden space-y-0.5">
                                                {tracks.slice(0, 3).map((t, i) => (
                                                    <div key={i} className="flex items-center justify-between gap-1 px-1">
                                                        <span className="truncate"><Music className="w-2 h-2 inline mr-0.5" />{t.position || ''} {t.title || t}</span>
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
                                </div>

                                <div className="space-y-0.5 min-w-0">
                                    <h3 className="font-semibold text-xs sm:text-sm truncate">{vinyl.title}</h3>
                                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{vinyl.artist}</p>
                                    {meta.genre && <p className="text-[9px] sm:text-[10px] text-amber-400/70 truncate">{meta.genre}</p>}
                                </div>
                            </motion.div>
                        );
                    })}
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

function VinylDetailModal({ vinyl, editing, editFields, saving, onClose, onEdit, onSave, onCancel, setEditFields, updateTrackField, parseMeta, parseTracks, getConfidenceInfo }) {
    const meta = parseMeta(vinyl);
    const tracks = parseTracks(vinyl);
    const conf = meta.enrichmentConfidence || 0;
    const confInfo = getConfidenceInfo(conf);

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
                    <div className="w-20 h-20 sm:w-28 sm:h-28 rounded-lg overflow-hidden shrink-0 border border-zinc-700/50">
                        <img src={vinyl.cover_image_url || '/vinyl_covers/default.png'} alt={vinyl.title} className="w-full h-full object-cover" />
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
        </div>
    );
}
