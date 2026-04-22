'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import {
    Shirt, Camera, Trash2, X, Loader2, Check, Pencil, Settings, Heart,
    Plane, ShoppingBag, MapPin, Calendar, Upload, User, Layers
} from 'lucide-react';
import PageShell from '@/components/PageShell';
import {
    getWardrobe,
    uploadGarmentPhoto,
    updateGarment,
    deleteGarment as deleteGarmentAction,
    confirmGarmentBrand,
    getWardrobeProfile,
    updateWardrobeProfile,
    uploadReferenceSelfie,
    getOutfits,
    likeOutfit,
    getTrips,
    getTrip as getTripAction,
    startTrip,
    completeTrip,
    setTripCapsule,
    removeFromTripCapsule,
    getShoppingList,
    markShoppingItemPurchased,
    dismissShoppingItem
} from '../actions';

// --- Helpers ---

const TYPE_FILTERS = [
    { key: null, label: 'All' },
    { key: 'top', label: 'Tops' },
    { key: 'bottom', label: 'Bottoms' },
    { key: 'outerwear', label: 'Outerwear' },
    { key: 'shoes', label: 'Shoes' },
    { key: 'accessory', label: 'Accessories' }
];

const TABS = [
    { key: 'garments', label: 'Garments', icon: Shirt },
    { key: 'outfits', label: 'Outfits', icon: Layers },
    { key: 'trips', label: 'Trips', icon: Plane },
    { key: 'shopping', label: 'Shopping', icon: ShoppingBag }
];

function pathToUrl(absolutePath) {
    if (!absolutePath) return null;
    const idx = absolutePath.indexOf('/wardrobe/');
    if (idx === -1) return null;
    const rest = absolutePath.substring(idx + '/wardrobe/'.length);
    return `/wardrobe_images/${rest}`;
}

function summarizeGarment(g) {
    const bits = [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'Unclassified';
}

function formatDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return iso; }
}

// --- Main page ---

export default function WardrobePage() {
    const [activeTab, setActiveTab] = useState('garments');
    const [profileOpen, setProfileOpen] = useState(false);

    return (
        <PageShell icon={Shirt} title="Wardrobe" subtitle="Your clothes, cataloged.">
            <div className="flex items-center gap-2 mb-4 -mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto">
                <div className="flex gap-2 flex-1">
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setActiveTab(t.key)}
                            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                                activeTab === t.key
                                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                            }`}
                        >
                            <t.icon className="w-3.5 h-3.5" />
                            {t.label}
                        </button>
                    ))}
                </div>
                <button
                    onClick={() => setProfileOpen(true)}
                    className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200"
                    title="Profile settings"
                >
                    <Settings className="w-4 h-4" />
                </button>
            </div>

            {activeTab === 'garments' && <GarmentsTab />}
            {activeTab === 'outfits' && <OutfitsTab />}
            {activeTab === 'trips' && <TripsTab />}
            {activeTab === 'shopping' && <ShoppingTab />}

            <AnimatePresence>
                {profileOpen && <ProfileSheet onClose={() => setProfileOpen(false)} />}
            </AnimatePresence>
        </PageShell>
    );
}

// --- Garments tab ---

function GarmentsTab() {
    const [garments, setGarments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [typeFilter, setTypeFilter] = useState(null);
    const [selected, setSelected] = useState(null);
    const fileInputRef = useRef(null);

    const loadData = useCallback(async () => {
        setLoading(true);
        const res = await getWardrobe({ limit: 500 });
        setGarments(res.success ? (res.data || []) : []);
        setLoading(false);
    }, []);

    useEffect(() => {
        loadData();
        const socket = io();
        const upsert = (g) => {
            setGarments(prev => {
                const idx = prev.findIndex(x => x.id === g.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = g; return next; }
                return [g, ...prev];
            });
            setSelected(prev => prev?.id === g.id ? g : prev);
        };
        socket.on('wardrobe:garment:detected', upsert);
        socket.on('wardrobe:garment:attributes', upsert);
        socket.on('wardrobe:garment:enriched', upsert);
        socket.on('wardrobe:garment:update', upsert);
        socket.on('wardrobe:garment:delete', ({ id }) => {
            setGarments(prev => prev.filter(g => g.id !== id));
            setSelected(prev => prev?.id === id ? null : prev);
        });
        return () => socket.disconnect();
    }, [loadData]);

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
        <>
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
                {uploadStatus && <span className="text-xs text-zinc-400">{uploadStatus}</span>}
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
                                        <p className="text-xs text-white truncate">{summarizeGarment(g)}</p>
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
        </>
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

// --- Outfits tab ---

function OutfitsTab() {
    const [outfits, setOutfits] = useState([]);
    const [garmentIndex, setGarmentIndex] = useState({});
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all'); // all | liked

    const load = useCallback(async () => {
        setLoading(true);
        const [outRes, garRes] = await Promise.all([
            getOutfits({ liked: filter === 'liked' ? true : null }),
            getWardrobe({ limit: 500 })
        ]);
        setOutfits(outRes.success ? (outRes.data || []) : []);
        const idx = {};
        for (const g of (garRes.success ? (garRes.data || []) : [])) idx[g.id] = g;
        setGarmentIndex(idx);
        setLoading(false);
    }, [filter]);

    useEffect(() => { load(); }, [load]);

    const toggleLike = async (outfit) => {
        const res = await likeOutfit(outfit.id, !outfit.liked);
        if (res.success && res.data?.outfit) {
            setOutfits(prev => prev.map(o => o.id === outfit.id ? res.data.outfit : o));
        }
    };

    return (
        <>
            <div className="flex items-center gap-2 mb-4">
                <button
                    onClick={() => setFilter('all')}
                    className={`px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                        filter === 'all' ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                    }`}
                >
                    All
                </button>
                <button
                    onClick={() => setFilter('liked')}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                        filter === 'liked' ? 'bg-rose-500/20 border-rose-500/50 text-rose-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                    }`}
                >
                    <Heart className="w-3.5 h-3.5" /> Liked
                </button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
            ) : outfits.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                    <Layers className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="mb-1">No outfits saved yet.</p>
                    <p className="text-xs">Ask in chat: &ldquo;recommend an outfit for dinner tonight&rdquo;.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {outfits.map(o => (
                        <div
                            key={o.id}
                            className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex items-center gap-3"
                        >
                            {o.rendered_image_path ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={pathToUrl(o.rendered_image_path)}
                                    alt=""
                                    className="w-16 h-20 object-cover rounded-lg shrink-0"
                                />
                            ) : (
                                <div className="w-16 h-20 shrink-0 bg-zinc-950 rounded-lg grid grid-cols-2 gap-0.5 p-0.5">
                                    {(o.garment_ids || []).slice(0, 4).map(gid => {
                                        const g = garmentIndex[gid];
                                        const url = g ? pathToUrl(g.crop_image_path || g.source_image_path) : null;
                                        return (
                                            <div key={gid} className="bg-zinc-900 rounded overflow-hidden">
                                                {url && (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={url} alt="" className="w-full h-full object-cover" />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white truncate">{o.name || 'Outfit'}</p>
                                <p className="text-xs text-zinc-500 truncate">
                                    {(o.garment_ids || []).length} item{(o.garment_ids || []).length === 1 ? '' : 's'}
                                    {o.occasion ? ` · ${o.occasion}` : ''}
                                </p>
                            </div>
                            <button
                                onClick={() => toggleLike(o)}
                                className={`p-2 rounded-lg ${o.liked ? 'text-rose-400' : 'text-zinc-600 hover:text-zinc-300'}`}
                                title={o.liked ? 'Unlike' : 'Like'}
                            >
                                <Heart className="w-5 h-5" fill={o.liked ? 'currentColor' : 'none'} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

// --- Trips tab ---

function TripsTab() {
    const [trips, setTrips] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        const res = await getTrips({});
        setTrips(res.success ? (res.data || []) : []);
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const openTrip = async (tripId) => {
        const res = await getTripAction(tripId);
        if (res.success) setSelected(res.data);
    };

    return (
        <>
            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
            ) : trips.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                    <Plane className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="mb-1">No trips planned yet.</p>
                    <p className="text-xs">Ask in chat: &ldquo;pack for a trip to Porto May 1-7&rdquo;.</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {trips.map(t => (
                        <button
                            key={t.id}
                            onClick={() => openTrip(t.id)}
                            className="w-full text-left rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 p-3 flex items-center gap-3"
                        >
                            <div className={`w-2 h-10 rounded-full ${
                                t.status === 'active' ? 'bg-emerald-500' :
                                t.status === 'planned' ? 'bg-indigo-500' :
                                'bg-zinc-700'
                            }`} />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white truncate">
                                    <MapPin className="w-3 h-3 inline mr-1 -mt-0.5 text-zinc-500" />
                                    {t.destination || 'Untitled trip'}
                                </p>
                                <p className="text-xs text-zinc-500 truncate">
                                    <Calendar className="w-3 h-3 inline mr-1 -mt-0.5" />
                                    {formatDate(t.start_date)} – {formatDate(t.end_date)}
                                    <span className="ml-2">· {t.status}</span>
                                    <span className="ml-2">· {(t.planned_capsule || []).length} planned / {(t.actual_capsule || []).length} packed</span>
                                </p>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            <AnimatePresence>
                {selected && (
                    <TripDetail
                        trip={selected}
                        onClose={() => setSelected(null)}
                        onRefresh={async () => {
                            const res = await getTripAction(selected.id);
                            if (res.success) setSelected(res.data);
                            load();
                        }}
                    />
                )}
            </AnimatePresence>
        </>
    );
}

function TripDetail({ trip, onClose, onRefresh }) {
    const [garmentIndex, setGarmentIndex] = useState({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        getWardrobe({ limit: 500 }).then(res => {
            const idx = {};
            for (const g of (res.success ? (res.data || []) : [])) idx[g.id] = g;
            setGarmentIndex(idx);
        });
    }, []);

    const daily = trip.weather_snapshot?.daily_plan || [];
    const days = trip.weather_snapshot?.days || [];
    const rationale = trip.weather_snapshot?.pack_rationale;
    const capsuleIds = (trip.status === 'planned' ? trip.planned_capsule : trip.actual_capsule) || [];

    const doAction = async (fn) => {
        setBusy(true);
        try { await fn(); await onRefresh(); } finally { setBusy(false); }
    };

    const removeFromCapsule = async (garmentId) => {
        await doAction(() => removeFromTripCapsule(trip.id, [garmentId]));
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
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white truncate">{trip.destination}</h2>
                    <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="text-xs text-zinc-400 mb-4">
                    {formatDate(trip.start_date)} – {formatDate(trip.end_date)} · <span className={`${
                        trip.status === 'active' ? 'text-emerald-400' :
                        trip.status === 'planned' ? 'text-indigo-400' : 'text-zinc-500'
                    }`}>{trip.status}</span>
                </div>

                <div className="flex gap-2 mb-4">
                    {trip.status === 'planned' && (
                        <button
                            disabled={busy}
                            onClick={() => doAction(() => startTrip(trip.id))}
                            className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg min-h-[36px]"
                        >
                            Start trip
                        </button>
                    )}
                    {trip.status === 'active' && (
                        <button
                            disabled={busy}
                            onClick={() => doAction(() => completeTrip(trip.id))}
                            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg min-h-[36px]"
                        >
                            Mark completed
                        </button>
                    )}
                </div>

                {rationale && (
                    <p className="text-xs text-zinc-400 italic mb-4 p-3 rounded-lg bg-zinc-900 border border-zinc-800">
                        {rationale}
                    </p>
                )}

                {days.length > 0 && (
                    <div className="mb-4">
                        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Forecast</h3>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                            {days.map((d, i) => (
                                <div key={i} className="shrink-0 w-20 p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-center">
                                    <p className="text-[10px] text-zinc-500">{formatDate(d.date)}</p>
                                    <p className="text-xs text-white">{Math.round(d.tempMin)}°–{Math.round(d.tempMax)}°</p>
                                    <p className="text-[10px] text-zinc-400 truncate">{d.condition}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="mb-4">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
                        {trip.status === 'planned' ? 'Planned capsule' : 'Actual capsule'} · {capsuleIds.length} item(s)
                    </h3>
                    {capsuleIds.length === 0 ? (
                        <p className="text-xs text-zinc-600">Nothing here yet.</p>
                    ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {capsuleIds.map(gid => {
                                const g = garmentIndex[gid];
                                const url = g ? pathToUrl(g.crop_image_path || g.source_image_path) : null;
                                return (
                                    <div key={gid} className="relative group aspect-[3/4] bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800">
                                        {url ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={url} alt="" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                                <Shirt className="w-5 h-5" />
                                            </div>
                                        )}
                                        {trip.status === 'active' && (
                                            <button
                                                onClick={() => removeFromCapsule(gid)}
                                                className="absolute inset-0 bg-black/0 hover:bg-black/60 transition flex items-center justify-center opacity-0 group-hover:opacity-100"
                                                title="Remove from capsule"
                                            >
                                                <Trash2 className="w-4 h-4 text-red-400" />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {daily.length > 0 && (
                    <div>
                        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Daily plan</h3>
                        <div className="space-y-2">
                            {daily.map((d, i) => (
                                <div key={i} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                                    <p className="text-xs text-zinc-400 mb-1">{formatDate(d.date)}</p>
                                    <div className="flex gap-1 flex-wrap">
                                        {(d.garment_ids || []).map(gid => {
                                            const g = garmentIndex[gid];
                                            return (
                                                <span key={gid} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                                                    {g ? summarizeGarment(g) : gid}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
}

// --- Shopping tab ---

function ShoppingTab() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('wanted');

    const load = useCallback(async () => {
        setLoading(true);
        const res = await getShoppingList({ status: filter === 'all' ? null : filter });
        setItems(res.success ? (res.data || []) : []);
        setLoading(false);
    }, [filter]);

    useEffect(() => { load(); }, [load]);

    const markPurchased = async (id) => {
        await markShoppingItemPurchased(id);
        load();
    };

    const dismiss = async (id) => {
        await dismissShoppingItem(id);
        load();
    };

    const priorityColor = p => ({
        high: 'text-rose-400 border-rose-500/40 bg-rose-500/10',
        medium: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
        low: 'text-zinc-400 border-zinc-700 bg-zinc-900'
    })[p] || 'text-zinc-400 border-zinc-700 bg-zinc-900';

    return (
        <>
            <div className="flex items-center gap-2 mb-4">
                {['wanted', 'purchased', 'dismissed', 'all'].map(f => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-3 py-2 rounded-full text-sm min-h-[36px] border transition capitalize ${
                            filter === f ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                        }`}
                    >
                        {f}
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
            ) : items.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                    <ShoppingBag className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="mb-1">Nothing on the list.</p>
                    <p className="text-xs">Outfit suggestions add missing pieces here automatically.</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {items.map(item => (
                        <div
                            key={item.id}
                            className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex items-start gap-3"
                        >
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white">{item.description}</p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    {item.type && <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{item.type}</span>}
                                    {item.primary_color && <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{item.primary_color}</span>}
                                    <span className={`text-[10px] px-2 py-0.5 rounded border ${priorityColor(item.priority)}`}>{item.priority}</span>
                                    {item.suggested_context?.outfit_id && (
                                        <span className="text-[10px] text-zinc-500">for outfit {item.suggested_context.outfit_id}</span>
                                    )}
                                </div>
                            </div>
                            {item.status === 'wanted' && (
                                <div className="flex gap-1 shrink-0">
                                    <button
                                        onClick={() => markPurchased(item.id)}
                                        className="p-2 rounded-lg text-emerald-400 hover:bg-emerald-500/10"
                                        title="Mark purchased"
                                    >
                                        <Check className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => dismiss(item.id)}
                                        className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                                        title="Dismiss"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                            {item.status !== 'wanted' && (
                                <span className="text-[10px] text-zinc-500 capitalize mt-1">{item.status}</span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

// --- Profile sheet ---

function ProfileSheet({ onClose }) {
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [brandsDraft, setBrandsDraft] = useState('');
    const [notesDraft, setNotesDraft] = useState('');
    const [editing, setEditing] = useState(null); // 'brands' | 'notes' | null
    const selfieInputRef = useRef(null);

    useEffect(() => {
        (async () => {
            const res = await getWardrobeProfile();
            if (res.success) {
                setProfile(res.data || {});
                setBrandsDraft((res.data?.preferred_brands || []).join(', '));
                setNotesDraft(res.data?.style_notes || '');
            }
            setLoading(false);
        })();
    }, []);

    const selfieUrl = profile?.reference_image_path ? pathToUrl(profile.reference_image_path) : null;

    const handleSelfieSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true);
        setUploadStatus('Uploading selfie...');
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const res = await uploadReferenceSelfie(base64, file.type);
            if (res.success) {
                setProfile(res.data?.profile || profile);
                setUploadStatus('Saved.');
            } else {
                setUploadStatus(`Error: ${res.error}`);
            }
        } catch (err) {
            setUploadStatus(`Error: ${err.message}`);
        } finally {
            setBusy(false);
            setTimeout(() => setUploadStatus(''), 3000);
            if (selfieInputRef.current) selfieInputRef.current.value = '';
        }
    };

    const saveBrands = async () => {
        const list = brandsDraft.split(',').map(s => s.trim()).filter(Boolean);
        const res = await updateWardrobeProfile({ preferred_brands: list });
        if (res.success) {
            setProfile(res.data?.profile || { ...profile, preferred_brands: list });
        }
        setEditing(null);
    };

    const saveNotes = async () => {
        const res = await updateWardrobeProfile({ style_notes: notesDraft });
        if (res.success) {
            setProfile(res.data?.profile || { ...profile, style_notes: notesDraft });
        }
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
                <input
                    ref={selfieInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleSelfieSelect}
                    className="hidden"
                />

                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white">Wardrobe profile</h2>
                    <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-10 text-zinc-500">
                        <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                ) : (
                    <div className="space-y-5">
                        <section>
                            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Reference selfie</h3>
                            <p className="text-xs text-zinc-500 mb-3">
                                Used to render virtual-mirror previews of you wearing outfits. Full-body is best.
                            </p>
                            <div className="flex items-center gap-3">
                                <div className="w-24 h-32 shrink-0 rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden flex items-center justify-center">
                                    {selfieUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={selfieUrl} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                        <User className="w-8 h-8 text-zinc-600" />
                                    )}
                                </div>
                                <div className="flex-1">
                                    <button
                                        onClick={() => selfieInputRef.current?.click()}
                                        disabled={busy}
                                        className="inline-flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg min-h-[36px]"
                                    >
                                        <Upload className="w-4 h-4" />
                                        {selfieUrl ? 'Replace' : 'Upload'}
                                    </button>
                                    {uploadStatus && <p className="text-xs text-zinc-400 mt-2">{uploadStatus}</p>}
                                </div>
                            </div>
                        </section>

                        <section>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Preferred brands</h3>
                                {editing !== 'brands' && (
                                    <button
                                        onClick={() => setEditing('brands')}
                                        className="text-xs text-indigo-400 hover:text-indigo-300"
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>
                            {editing === 'brands' ? (
                                <div className="space-y-2">
                                    <input
                                        value={brandsDraft}
                                        onChange={e => setBrandsDraft(e.target.value)}
                                        placeholder="Lacoste, Lululemon, …"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white"
                                    />
                                    <p className="text-[10px] text-zinc-600">Comma-separated. These bias brand detection when the visual signal is strong enough.</p>
                                    <div className="flex gap-2">
                                        <button onClick={saveBrands} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg">Save</button>
                                        <button onClick={() => { setEditing(null); setBrandsDraft((profile?.preferred_brands || []).join(', ')); }} className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded-lg">Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-2">
                                    {(profile?.preferred_brands || []).length === 0 ? (
                                        <p className="text-xs text-zinc-600">No preferred brands.</p>
                                    ) : (
                                        (profile?.preferred_brands || []).map(b => (
                                            <span key={b} className="text-xs px-2 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300">
                                                {b}
                                            </span>
                                        ))
                                    )}
                                </div>
                            )}
                        </section>

                        <section>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Style notes</h3>
                                {editing !== 'notes' && (
                                    <button
                                        onClick={() => setEditing('notes')}
                                        className="text-xs text-indigo-400 hover:text-indigo-300"
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>
                            {editing === 'notes' ? (
                                <div className="space-y-2">
                                    <textarea
                                        value={notesDraft}
                                        onChange={e => setNotesDraft(e.target.value)}
                                        rows={3}
                                        placeholder="Prefer darker colors on weekdays, no loud prints, …"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white"
                                    />
                                    <div className="flex gap-2">
                                        <button onClick={saveNotes} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg">Save</button>
                                        <button onClick={() => { setEditing(null); setNotesDraft(profile?.style_notes || ''); }} className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded-lg">Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-sm text-zinc-300">
                                    {profile?.style_notes || <span className="text-zinc-600 italic">No notes.</span>}
                                </p>
                            )}
                        </section>
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
}
