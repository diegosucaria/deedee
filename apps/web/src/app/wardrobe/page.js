'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { Shirt, Camera, Upload, Trash2, X, Loader2, Check, Pencil } from 'lucide-react';
import PageShell from '@/components/PageShell';
import {
    getWardrobe,
    uploadGarmentPhoto,
    updateGarment,
    deleteGarment as deleteGarmentAction,
    confirmGarmentBrand
} from '../actions';

const TYPE_FILTERS = [
    { key: null, label: 'All' },
    { key: 'top', label: 'Tops' },
    { key: 'bottom', label: 'Bottoms' },
    { key: 'outerwear', label: 'Outerwear' },
    { key: 'shoes', label: 'Shoes' },
    { key: 'accessory', label: 'Accessories' }
];

function pathToUrl(absolutePath) {
    if (!absolutePath) return null;
    const idx = absolutePath.indexOf('/wardrobe/');
    if (idx === -1) return null;
    const rest = absolutePath.substring(idx + '/wardrobe/'.length);
    return `/wardrobe_images/${rest}`;
}

function summarize(g) {
    const bits = [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'Unclassified';
}

export default function WardrobePage() {
    const [garments, setGarments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [typeFilter, setTypeFilter] = useState(null);
    const [selected, setSelected] = useState(null);
    const fileInputRef = useRef(null);

    async function loadData() {
        setLoading(true);
        const res = await getWardrobe({ limit: 500 });
        setGarments(res.success ? (res.data || []) : []);
        setLoading(false);
    }

    useEffect(() => {
        loadData();
        const socket = io();
        const upsert = (g) => {
            setGarments(prev => {
                const idx = prev.findIndex(x => x.id === g.id);
                if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = g;
                    return next;
                }
                return [g, ...prev];
            });
            setSelected(prev => prev?.id === g.id ? g : prev);
        };
        socket.on('wardrobe:garment:detected', upsert);
        socket.on('wardrobe:garment:attributes', upsert);
        socket.on('wardrobe:garment:update', upsert);
        socket.on('wardrobe:garment:delete', ({ id }) => {
            setGarments(prev => prev.filter(g => g.id !== id));
            setSelected(prev => prev?.id === id ? null : prev);
        });
        return () => socket.disconnect();
    }, []);

    const visible = typeFilter ? garments.filter(g => g.type === typeFilter) : garments;
    const enrichingCount = garments.filter(g => g.enrichment_status === 'enriching').length;

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
            setUploadStatus('Uploading...');
            const result = await uploadGarmentPhoto(base64, file.type);
            if (result.success) {
                const newOnes = result.data?.garments || [];
                setUploadStatus(`Added ${newOnes.length} garment(s).`);
                if (newOnes.length) {
                    setGarments(prev => [
                        ...newOnes.filter(n => !prev.find(p => p.id === n.id)),
                        ...prev
                    ]);
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

    return (
        <PageShell icon={Shirt} title="Wardrobe" subtitle="Your clothes, cataloged.">
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2 mb-4">
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex items-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl min-h-[44px]"
                >
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                    {uploading ? 'Uploading' : 'Add photo'}
                </button>
                {uploadStatus && (
                    <span className="text-xs text-zinc-400">{uploadStatus}</span>
                )}
            </div>

            {enrichingCount > 0 && (
                <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-300">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Analyzing {enrichingCount} garment{enrichingCount === 1 ? '' : 's'}...
                </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-3 mb-4 -mx-4 px-4 md:mx-0 md:px-0">
                {TYPE_FILTERS.map(f => (
                    <button
                        key={f.label}
                        onClick={() => setTypeFilter(f.key)}
                        className={`shrink-0 px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                            typeFilter === f.key
                                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
            ) : visible.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                    <Shirt className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="mb-1">No garments yet.</p>
                    <p className="text-xs">Tap &ldquo;Add photo&rdquo; to catalog your first item.</p>
                </div>
            ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {visible.map(g => {
                        const imgUrl = pathToUrl(g.crop_image_path || g.source_image_path);
                        const enriching = g.enrichment_status === 'enriching';
                        return (
                            <button
                                key={g.id}
                                onClick={() => setSelected(g)}
                                className="group aspect-[3/4] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 relative text-left"
                            >
                                {imgUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={imgUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                        <Shirt className="w-8 h-8" />
                                    </div>
                                )}
                                {enriching && (
                                    <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/70 text-[10px] text-indigo-300">
                                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Analyzing
                                    </div>
                                )}
                                {g.enrichment_status === 'needs_brand_confirm' && g.meta?.brandCandidate?.brand && (
                                    <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-[10px] text-amber-300">
                                        {g.meta.brandCandidate.brand}?
                                    </div>
                                )}
                                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                                    {enriching ? (
                                        <div className="flex gap-1">
                                            <span className="h-3 w-12 rounded bg-zinc-700/80 animate-pulse" />
                                            <span className="h-3 w-8 rounded bg-zinc-700/60 animate-pulse" />
                                        </div>
                                    ) : (
                                        <p className="text-xs text-white truncate">{summarize(g)}</p>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            <AnimatePresence>
                {selected && (
                    <GarmentDetail
                        garment={selected}
                        onClose={() => setSelected(null)}
                        onChange={async (patch) => {
                            const res = await updateGarment(selected.id, patch);
                            if (res.success && res.data?.garment) setSelected(res.data.garment);
                        }}
                        onDelete={async () => {
                            if (!confirm('Delete this garment?')) return;
                            const res = await deleteGarmentAction(selected.id);
                            if (res.success) setSelected(null);
                        }}
                        onConfirmBrand={async (accept) => {
                            const res = await confirmGarmentBrand(selected.id, accept);
                            if (res.success && res.data?.garment) setSelected(res.data.garment);
                        }}
                    />
                )}
            </AnimatePresence>
        </PageShell>
    );
}

const EDITABLE_TEXT = [
    { key: 'type', label: 'Type' },
    { key: 'subtype', label: 'Subtype' },
    { key: 'primary_color', label: 'Color' },
    { key: 'pattern', label: 'Pattern' },
    { key: 'material_guess', label: 'Material' },
    { key: 'brand', label: 'Brand' },
    { key: 'model', label: 'Model' },
    { key: 'size', label: 'Size' }
];

function GarmentDetail({ garment, onClose, onChange, onDelete, onConfirmBrand }) {
    const [editing, setEditing] = useState(null);
    const [draft, setDraft] = useState('');
    const imgUrl = pathToUrl(garment.source_image_path);
    const brandCandidate = garment.enrichment_status === 'needs_brand_confirm'
        ? garment.meta?.brandCandidate : null;

    const save = async (key) => {
        await onChange({ [key]: draft || null });
        setEditing(null);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center"
            onClick={onClose}
        >
            <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 28 }}
                className="w-full md:max-w-lg bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl p-4 max-h-[90vh] overflow-y-auto"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-semibold text-white">Garment</h2>
                    <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {imgUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imgUrl} alt="" className="w-full rounded-xl mb-4 object-cover max-h-80" />
                )}

                {brandCandidate?.brand && (
                    <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
                        <p className="text-sm text-amber-200 mb-2">
                            Possible brand: <strong>{brandCandidate.brand}</strong>
                            {brandCandidate.model ? ` (${brandCandidate.model})` : ''}
                        </p>
                        {brandCandidate.visualIdentifier && (
                            <p className="text-xs text-amber-300/70 mb-2">&ldquo;{brandCandidate.visualIdentifier}&rdquo;</p>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => onConfirmBrand(true)}
                                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg min-h-[36px]"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => onConfirmBrand(false)}
                                className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg min-h-[36px]"
                            >
                                Reject
                            </button>
                        </div>
                    </div>
                )}

                <div className="space-y-2 mb-4">
                    {EDITABLE_TEXT.map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-2 py-2 border-b border-zinc-900">
                            <span className="text-xs text-zinc-500 w-20 shrink-0">{label}</span>
                            {editing === key ? (
                                <div className="flex-1 flex gap-2">
                                    <input
                                        autoFocus
                                        value={draft}
                                        onChange={e => setDraft(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && save(key)}
                                        className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-sm text-white"
                                    />
                                    <button onClick={() => save(key)} className="p-2 text-emerald-400 hover:text-emerald-300">
                                        <Check className="w-4 h-4" />
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => { setEditing(key); setDraft(garment[key] || ''); }}
                                    className="flex-1 text-left text-sm text-white flex items-center gap-2 group min-h-[32px]"
                                >
                                    <span className={garment[key] ? '' : 'text-zinc-600 italic'}>
                                        {garment[key] || 'not set'}
                                    </span>
                                    <Pencil className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100" />
                                </button>
                            )}
                        </div>
                    ))}

                    <SliderRow
                        label="Warmth"
                        value={garment.warmth}
                        onCommit={v => onChange({ warmth: v })}
                    />
                    <SliderRow
                        label="Formality"
                        value={garment.formality}
                        onCommit={v => onChange({ formality: v })}
                    />
                </div>

                <div className="flex gap-2">
                    <button
                        onClick={onDelete}
                        className="flex items-center gap-2 px-4 py-3 text-red-400 hover:text-red-300 text-sm min-h-[44px]"
                    >
                        <Trash2 className="w-4 h-4" /> Delete
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
}

function SliderRow({ label, value, onCommit }) {
    return (
        <div className="flex items-center gap-2 py-2 border-b border-zinc-900">
            <span className="text-xs text-zinc-500 w-20 shrink-0">{label}</span>
            <div className="flex-1 flex items-center gap-2">
                {[1, 2, 3, 4, 5].map(n => (
                    <button
                        key={n}
                        onClick={() => onCommit(n)}
                        className={`w-8 h-8 rounded-full text-xs ${
                            value === n
                                ? 'bg-indigo-500 text-white'
                                : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                        }`}
                    >
                        {n}
                    </button>
                ))}
            </div>
        </div>
    );
}
