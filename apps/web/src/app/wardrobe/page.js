'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { getSocketUrl } from '@/hooks/useSocket';
import {
    Shirt, Camera, Trash2, X, Loader2, Check, Pencil, Settings, Heart,
    Plane, ShoppingBag, MapPin, Calendar, Upload, User, Layers, Sparkles, RefreshCw, Paperclip, Combine, Copy, Tag, Plus, ArrowUpDown
} from 'lucide-react';
import PageShell from '@/components/PageShell';
import {
    getWardrobe,
    uploadGarmentPhoto,
    updateGarment,
    deleteGarment as deleteGarmentAction,
    confirmGarmentBrand,
    reenrichGarment,
    generateGarmentImage,
    mergeGarments,
    duplicateGarment,
    deleteOutfit as deleteOutfitAction,
    updateOutfit,
    getOutfit,
    generateOutfitVariations,
    generateOutfitsForGarment,
    generateShoppingReferenceImage,
    getWardrobeProfile,
    updateWardrobeProfile,
    uploadReferenceSelfie,
    getOutfits,
    likeOutfit,
    getTrips,
    getTrip as getTripAction,
    startTrip,
    completeTrip,
    renderTripDailyOutfits,
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
    // Model (e.g. "ABC Slim-Fit Trouser 30L") is the strongest differentiator when
    // two garments share brand/subtype (a 5-pocket pant and a flat-front trouser
    // both map to subtype "chinos"). Fall back to brand when model is absent.
    const identity = g.model || g.brand || null;
    const bits = [g.type, g.subtype, g.primary_color, identity].filter(Boolean);
    return bits.length ? bits.join(' · ') : 'Unclassified';
}

function summarizeGarmentShort(g) {
    const bits = [g.subtype || g.type, g.primary_color].filter(Boolean);
    return bits.join(' · ') || 'Unclassified';
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
            <div className="flex items-center gap-2 mb-4 -mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto touch-pan-x">
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

const GARMENT_SORTS = [
    { key: 'recent', label: 'Recent' },
    { key: 'type', label: 'By type' },
    { key: 'formality', label: 'Formality' },
    { key: 'times_worn', label: 'Most worn' },
    { key: 'brand', label: 'Brand' }
];

const TYPE_ORDER = ['outerwear', 'top', 'bottom', 'shoes', 'accessory', 'underwear', 'other'];

function GarmentsTab() {
    const [garments, setGarments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [pendingUploads, setPendingUploads] = useState(0);
    const [uploadStatus, setUploadStatus] = useState('');
    const [typeFilter, setTypeFilter] = useState(null);
    const [sortBy, setSortBy] = useState('recent');
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
        // Bare io() connects to the page origin (web container, port 3000) where
        // no socket.io server lives — events from the agent never arrived. Use
        // the public SOCKET_URL (api gateway → interfaces) like the chat page.
        const socket = io(getSocketUrl(), {
            path: '/socket.io',
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 10,
            withCredentials: true,
        });
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

    // Write a garment row back to BOTH `garments` (grid) and `selected`
    // (dialog) in one step — both need to stay in sync or the user sees stale
    // data in one of them until the next refresh.
    const applyGarmentToState = useCallback((garment) => {
        setGarments(prev => prev.map(g => g.id === garment.id ? garment : g));
        setSelected(prev => prev?.id === garment.id ? garment : prev);
    }, []);

    // Apply a partial patch (or function that derives one from the current row)
    // to the same two state slices. Used for optimistic flags like
    // meta.generatingImage so the UI updates on click instead of after the
    // websocket round-trip.
    const optimisticallyPatchGarment = useCallback((id, patchOrFn) => {
        const merge = (prev) => {
            if (!prev) return prev;
            const patch = typeof patchOrFn === 'function' ? patchOrFn(prev) : patchOrFn;
            return { ...prev, ...patch };
        };
        setGarments(prev => prev.map(g => g.id === id ? merge(g) : g));
        setSelected(prev => prev?.id === id ? merge(prev) : prev);
    }, []);

    const filtered = typeFilter ? garments.filter(g => g.type === typeFilter) : garments;
    const visible = [...filtered].sort((a, b) => {
        if (sortBy === 'type') {
            const ai = TYPE_ORDER.indexOf(a.type || 'other');
            const bi = TYPE_ORDER.indexOf(b.type || 'other');
            if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            // Tiebreak by subtype so same-type items cluster by style.
            return (a.subtype || '').localeCompare(b.subtype || '');
        }
        if (sortBy === 'formality') {
            return (a.formality || 0) - (b.formality || 0);
        }
        if (sortBy === 'times_worn') {
            return (b.times_worn || 0) - (a.times_worn || 0);
        }
        if (sortBy === 'brand') {
            return (a.brand || '\uffff').localeCompare(b.brand || '\uffff');
        }
        // recent
        const ta = new Date(a.created_at || 0).getTime();
        const tb = new Date(b.created_at || 0).getTime();
        return tb - ta;
    });
    const enrichingCount = garments.filter(g => g.enrichment_status === 'enriching').length;

    const uploadOne = async (file) => {
        setPendingUploads(n => n + 1);
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const result = await uploadGarmentPhoto(base64, file.type);
            if (result.success) {
                const newOnes = result.data?.garments || [];
                const matched = result.data?.matched_existing || [];
                const parts = [];
                if (newOnes.length) parts.push(`Added ${newOnes.length} new`);
                if (matched.length) parts.push(`matched ${matched.length} existing`);
                if (parts.length === 0) parts.push('No items detected');
                setUploadStatus(`${file.name}: ${parts.join(', ')}.`);
                if (newOnes.length) {
                    setGarments(prev => [
                        ...newOnes.filter(n => !prev.find(p => p.id === n.id)),
                        ...prev
                    ]);
                }
            } else {
                setUploadStatus(`Error on ${file.name}: ${result.error}`);
            }
        } catch (err) {
            setUploadStatus(`Error on ${file.name}: ${err.message}`);
        } finally {
            setPendingUploads(n => n - 1);
            setTimeout(() => setUploadStatus(''), 4000);
        }
    };

    const handleFileSelect = (e) => {
        const files = Array.from(e.target.files || []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (files.length === 0) return;
        // Fire and forget — each upload runs in parallel and the button stays
        // available so the user can pick more without waiting.
        for (const f of files) uploadOne(f);
    };

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2 mb-4">
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl min-h-[44px]"
                >
                    <Camera className="w-4 h-4" />
                    Add photo
                </button>
                {pendingUploads > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-indigo-300">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Uploading {pendingUploads}…
                    </span>
                )}
                {uploadStatus && <span className="text-xs text-zinc-400">{uploadStatus}</span>}
            </div>

            {enrichingCount > 0 && (
                <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-300">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Analyzing {enrichingCount} garment{enrichingCount === 1 ? '' : 's'}...
                </div>
            )}

            <div className="flex items-center gap-2 mb-3 flex-wrap">
                <div className="flex gap-2 overflow-x-auto touch-pan-x flex-1 -mx-4 px-4 md:mx-0 md:px-0">
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
                <div className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800">
                    <ArrowUpDown className="w-3.5 h-3.5 text-zinc-500" />
                    <select
                        value={sortBy}
                        onChange={e => setSortBy(e.target.value)}
                        className="bg-transparent text-xs text-zinc-300 focus:outline-none"
                    >
                        {GARMENT_SORTS.map(s => (
                            <option key={s.key} value={s.key} className="bg-zinc-900 text-zinc-200">{s.label}</option>
                        ))}
                    </select>
                </div>
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
                        const imgUrl = pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path);
                        const enriching = g.enrichment_status === 'enriching';
                        const detecting = g.enrichment_status === 'detecting';
                        const generatingImage = !!g.meta?.generatingImage;
                        const badge = detecting ? 'Uploading' : generatingImage ? 'Generating image' : enriching ? 'Analyzing' : null;
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
                                {generatingImage && (
                                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                        <Loader2 className="w-6 h-6 text-violet-300 animate-spin" />
                                    </div>
                                )}
                                {badge && (
                                    <div className={`absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] ${
                                        generatingImage ? 'bg-violet-500/30 text-violet-200 border border-violet-500/40' :
                                        detecting ? 'bg-zinc-800/80 text-zinc-300 border border-zinc-600' :
                                        'bg-black/70 text-indigo-300'
                                    }`}>
                                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> {badge}
                                    </div>
                                )}
                                {!badge && g.enrichment_status === 'needs_brand_confirm' && g.meta?.brandCandidate?.brand && (
                                    <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-[10px] text-amber-300">
                                        {g.meta.brandCandidate.brand}?
                                    </div>
                                )}
                                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                                    {enriching || detecting ? (
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
                            const targetId = selected.id;
                            const res = await updateGarment(targetId, patch);
                            // Write through to BOTH the dialog and the grid. Prior
                            // versions only touched `selected`, leaving the grid
                            // stale until a socket broadcast landed — which was
                            // unreliable, so the user had to refresh to see changes.
                            if (res.success && res.data?.garment) {
                                applyGarmentToState(res.data.garment);
                            }
                            return res;
                        }}
                        onDelete={async () => {
                            if (!confirm('Delete this garment?')) return;
                            const targetId = selected.id;
                            const res = await deleteGarmentAction(targetId);
                            if (res.success) {
                                setGarments(prev => prev.filter(g => g.id !== targetId));
                                setSelected(prev => prev?.id === targetId ? null : prev);
                            }
                        }}
                        onConfirmBrand={async (accept) => {
                            const targetId = selected.id;
                            const res = await confirmGarmentBrand(targetId, accept);
                            if (res.success && res.data?.garment) {
                                applyGarmentToState(res.data.garment);
                            }
                        }}
                        onReenrich={async (hint, opts) => {
                            const targetId = selected.id;
                            // Optimistic: mark enriching so the grid skeleton shows
                            // immediately, not after the socket event arrives.
                            optimisticallyPatchGarment(targetId, { enrichment_status: 'enriching' });
                            const res = await reenrichGarment(targetId, hint, opts || {});
                            if (res.success && res.data?.garment) {
                                applyGarmentToState(res.data.garment);
                            } else {
                                // Back out the optimistic flag so we don't spin forever.
                                optimisticallyPatchGarment(targetId, { enrichment_status: 'complete' });
                            }
                            return res;
                        }}
                        onGenerateImage={async (opts) => {
                            const targetId = selected.id;
                            // Optimistic spinner: flip meta.generatingImage true now,
                            // the server's post-completion broadcast (or HTTP response)
                            // will clear it. Without this the grid shows no feedback
                            // until the websocket event lands.
                            optimisticallyPatchGarment(targetId, (prev) => ({
                                meta: { ...(prev?.meta || {}), generatingImage: true }
                            }));
                            const res = await generateGarmentImage(targetId, opts || {});
                            if (res.success && res.data?.garment) {
                                applyGarmentToState(res.data.garment);
                            } else {
                                optimisticallyPatchGarment(targetId, (prev) => {
                                    const meta = { ...(prev?.meta || {}) };
                                    delete meta.generatingImage;
                                    delete meta.generatingImageStartedAt;
                                    return { meta };
                                });
                            }
                            return res;
                        }}
                        otherGarments={garments.filter(g => g.id !== selected.id)}
                        onMerge={async (duplicateIds) => {
                            const targetId = selected.id;
                            const res = await mergeGarments(targetId, duplicateIds);
                            if (res.success && res.data?.garment) {
                                // Merged-away duplicates get dropped from the grid too.
                                setGarments(prev => prev.filter(g => g.id === targetId || !duplicateIds.includes(g.id)));
                                applyGarmentToState(res.data.garment);
                            }
                            return res;
                        }}
                        onDuplicate={async (base64, mimeType) => {
                            const sourceId = selected.id;
                            const res = await duplicateGarment(sourceId, base64, mimeType);
                            if (res.success && res.data?.garment) {
                                setGarments(prev => {
                                    if (prev.find(p => p.id === res.data.garment.id)) return prev;
                                    return [res.data.garment, ...prev];
                                });
                            }
                            return res;
                        }}
                        onGenerateOutfits={async (count) => {
                            const sourceId = selected.id;
                            return generateOutfitsForGarment(sourceId, count || 4);
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

function GarmentDetail({ garment, onClose, onChange, onDelete, onConfirmBrand, onReenrich, onGenerateImage, otherGarments = [], onMerge, onDuplicate, onGenerateOutfits }) {
    const [editing, setEditing] = useState(null);
    const [draft, setDraft] = useState('');
    const [savingField, setSavingField] = useState(null); // key currently being saved
    const [fieldError, setFieldError] = useState(null); // { key, message }
    const [hint, setHint] = useState('');
    const [hintImage, setHintImage] = useState(null); // { base64, mimeType, name }
    const [reenriching, setReenriching] = useState(false);
    const [reenrichError, setReenrichError] = useState('');
    const [generating, setGenerating] = useState(false);
    const [genError, setGenError] = useState('');
    const [showOriginal, setShowOriginal] = useState(false);
    const [mergeOpen, setMergeOpen] = useState(false);
    const [duplicating, setDuplicating] = useState(false);
    const [duplicateStatus, setDuplicateStatus] = useState('');
    const [generatingOutfits, setGeneratingOutfits] = useState(false);
    const [outfitsError, setOutfitsError] = useState('');
    const [generatedOutfits, setGeneratedOutfits] = useState([]);
    const [lightboxSrc, setLightboxSrc] = useState(null);
    const extraPhotoInputRef = useRef(null);
    const hintImageInputRef = useRef(null);
    const duplicateInputRef = useRef(null);
    const busy = savingField !== null || reenriching || generating || duplicating || generatingOutfits;
    const generatedUrl = pathToUrl(garment.generated_image_path);
    const originalUrl = pathToUrl(garment.crop_image_path || garment.source_image_path);
    const imgUrl = !showOriginal && generatedUrl ? generatedUrl : originalUrl;
    const enriching = garment.enrichment_status === 'enriching';
    const brandCandidate = garment.enrichment_status === 'needs_brand_confirm'
        ? garment.meta?.brandCandidate : null;

    const save = async (key) => {
        setSavingField(key);
        setFieldError(null);
        try {
            const res = await onChange({ [key]: draft || null });
            // onChange is allowed to return {success,error} but currently returns
            // undefined on success. Surface any explicit failure.
            if (res && res.success === false) {
                setFieldError({ key, message: res.error || 'Save failed' });
                return;
            }
            setEditing(null);
        } catch (e) {
            setFieldError({ key, message: e.message || 'Save failed' });
        } finally {
            setSavingField(null);
        }
    };

    const handleHintImageSelect = async (e) => {
        const file = e.target.files?.[0];
        if (hintImageInputRef.current) hintImageInputRef.current.value = '';
        if (!file) return;
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            setHintImage({ base64, mimeType: file.type, name: file.name });
        } catch (err) {
            setReenrichError(err.message);
        }
    };

    const handleReenrich = async () => {
        setReenriching(true);
        setReenrichError('');
        try {
            const opts = hintImage
                ? { extraImageBase64: hintImage.base64, mimeType: hintImage.mimeType }
                : {};
            const res = await onReenrich(hint, opts);
            if (!res?.success) setReenrichError(res?.error || 'Re-enrich failed');
            else { setHint(''); setHintImage(null); }
        } finally { setReenriching(false); }
    };

    const handleGenerate = async () => {
        setGenerating(true);
        setGenError('');
        try {
            const res = await onGenerateImage();
            if (!res?.success) setGenError(res?.error || 'Generate failed');
        } finally { setGenerating(false); }
    };

    const handleDuplicatePhotoSelect = async (e) => {
        const file = e.target.files?.[0];
        if (duplicateInputRef.current) duplicateInputRef.current.value = '';
        if (!file || !onDuplicate) return;
        setDuplicating(true);
        setDuplicateStatus('');
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const res = await onDuplicate(base64, file.type);
            if (res?.success) {
                setDuplicateStatus('Added — analyzing color in background.');
                setTimeout(() => setDuplicateStatus(''), 4000);
            } else {
                setDuplicateStatus(res?.error || 'Failed to duplicate.');
            }
        } catch (err) {
            setDuplicateStatus(err.message || 'Failed to duplicate.');
        } finally {
            setDuplicating(false);
        }
    };

    const handleGenerateOutfits = async () => {
        if (!onGenerateOutfits) return;
        setGeneratingOutfits(true);
        setOutfitsError('');
        try {
            const res = await onGenerateOutfits(4);
            if (res?.success) {
                const proposals = Array.isArray(res.data?.proposals) ? res.data.proposals : [];
                setGeneratedOutfits(proposals.map(p => p.outfit).filter(Boolean));
            } else {
                setOutfitsError(res?.error || 'Could not build outfits');
            }
        } catch (err) {
            setOutfitsError(err.message || 'Could not build outfits');
        } finally {
            setGeneratingOutfits(false);
        }
    };

    const handleExtraPhotoSelect = async (e) => {
        const file = e.target.files?.[0];
        if (extraPhotoInputRef.current) extraPhotoInputRef.current.value = '';
        if (!file) return;
        setGenerating(true);
        setGenError('');
        try {
            const extraImageBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const res = await onGenerateImage({ extraImageBase64, mimeType: file.type });
            if (!res?.success) setGenError(res?.error || 'Generate failed');
        } catch (err) {
            setGenError(err.message);
        } finally {
            setGenerating(false);
        }
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
                className="w-full md:max-w-lg bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl px-4 pb-4 max-h-[90vh] overflow-y-auto overscroll-contain"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-white">Garment</h2>
                    <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {imgUrl && (
                    <div className="relative mb-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={imgUrl}
                            alt=""
                            onClick={() => setLightboxSrc(imgUrl)}
                            className="w-full rounded-xl object-cover max-h-80 cursor-zoom-in"
                        />
                        {generatedUrl && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowOriginal(v => !v); }}
                                className="absolute top-2 right-2 px-2 py-1 rounded-full bg-black/70 text-[10px] text-white backdrop-blur"
                            >
                                {showOriginal ? 'Generated' : 'Original'}
                            </button>
                        )}
                    </div>
                )}

                <input
                    ref={extraPhotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleExtraPhotoSelect}
                    className="hidden"
                />
                <div className="flex flex-wrap gap-2 mb-4">
                    <button
                        onClick={handleGenerate}
                        disabled={busy || enriching}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600/90 hover:bg-violet-500 disabled:opacity-50 text-white text-xs min-h-[36px]"
                    >
                        {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                        {generatedUrl ? 'Regenerate image' : 'Generate clean image'}
                    </button>
                    <button
                        onClick={() => extraPhotoInputRef.current?.click()}
                        disabled={busy || enriching}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs min-h-[36px]"
                        title="Upload another photo of this garment as additional reference for the generator"
                    >
                        <Upload className="w-3.5 h-3.5" />
                        Use another photo
                    </button>
                    {genError && <span className="text-xs text-rose-400 self-center">{genError}</span>}
                </div>

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
                    {EDITABLE_TEXT.map(({ key, label }) => {
                        const saving = savingField === key;
                        const err = fieldError && fieldError.key === key ? fieldError.message : null;
                        return (
                            <div key={key} className="py-2 border-b border-zinc-900">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-zinc-500 w-20 shrink-0">{label}</span>
                                    {editing === key ? (
                                        <div className="flex-1 flex gap-2">
                                            <input
                                                autoFocus
                                                value={draft}
                                                onChange={e => setDraft(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && !saving && save(key)}
                                                disabled={saving}
                                                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-sm text-white disabled:opacity-50"
                                            />
                                            <button onClick={() => save(key)} disabled={saving} className="p-2 text-emerald-400 hover:text-emerald-300 disabled:opacity-50">
                                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => { setEditing(key); setDraft(garment[key] || ''); setFieldError(null); }}
                                            className="flex-1 text-left text-sm text-white flex items-center gap-2 group min-h-[32px]"
                                        >
                                            <span className={garment[key] ? '' : 'text-zinc-600 italic'}>
                                                {garment[key] || 'not set'}
                                            </span>
                                            <Pencil className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100" />
                                        </button>
                                    )}
                                </div>
                                {err && <p className="text-[11px] text-rose-400 mt-1 ml-[88px]">{err}</p>}
                            </div>
                        );
                    })}

                    <SliderRow
                        label="Warmth"
                        description="How insulating · 1 light (linen tee) → 5 heavy (parka)"
                        value={garment.warmth}
                        onCommit={v => onChange({ warmth: v })}
                    />
                    <SliderRow
                        label="Formality"
                        description="Dress code · 1 athletic/lounge → 3 smart casual → 5 formal"
                        value={garment.formality}
                        onCommit={v => onChange({ formality: v })}
                    />
                </div>

                <input
                    ref={hintImageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleHintImageSelect}
                    className="hidden"
                />
                <div className="mb-4 p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                    <p className="text-xs text-zinc-400 mb-2">
                        Re-analyze with a known model/brand and/or an extra reference photo. Leave both blank to just refresh attributes using the fields above.
                    </p>
                    <div className="flex gap-2">
                        <input
                            value={hint}
                            onChange={e => setHint(e.target.value)}
                            placeholder="e.g. ABC Warpstreme Jogger Regular"
                            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600"
                            disabled={busy || enriching}
                        />
                        <button
                            onClick={() => hintImageInputRef.current?.click()}
                            disabled={busy || enriching}
                            className={`inline-flex items-center justify-center px-2 rounded-lg border text-xs min-h-[36px] ${
                                hintImage
                                    ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                            } disabled:opacity-50`}
                            title={hintImage ? `Attached: ${hintImage.name}` : 'Attach a reference photo'}
                        >
                            <Paperclip className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={handleReenrich}
                            disabled={busy || enriching}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs min-h-[36px]"
                        >
                            {reenriching || enriching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            Re-enrich
                        </button>
                    </div>
                    {hintImage && (
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-emerald-300">
                            <Paperclip className="w-3 h-3" />
                            <span className="truncate flex-1">{hintImage.name}</span>
                            <button
                                onClick={() => setHintImage(null)}
                                className="text-zinc-500 hover:text-zinc-300"
                                title="Remove attachment"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    )}
                    {reenrichError && <p className="mt-2 text-xs text-rose-400">{reenrichError}</p>}
                </div>

                {onGenerateOutfits && (
                    <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs uppercase tracking-wide text-zinc-500">Outfit ideas</h3>
                            <button
                                onClick={handleGenerateOutfits}
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white"
                                title="Build complete outfits using this garment as the anchor"
                            >
                                {generatingOutfits ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                {generatedOutfits.length > 0 ? 'Regenerate' : 'Generate outfits with this'}
                            </button>
                        </div>
                        {outfitsError && <p className="text-xs text-rose-400 mb-2">{outfitsError}</p>}
                        {generatedOutfits.length > 0 ? (
                            <div className="space-y-1">
                                {generatedOutfits.map((o) => (
                                    <div key={o.id} className="flex items-center justify-between gap-2 text-xs text-zinc-300 bg-zinc-900/60 border border-zinc-800 rounded-md px-2.5 py-1.5">
                                        <span className="truncate">{o.name || 'Outfit'} · {(o.garment_ids || []).length} pieces</span>
                                        <span className="text-zinc-500 shrink-0">Saved</span>
                                    </div>
                                ))}
                                <p className="text-[10px] text-zinc-500 mt-1">Open the Outfits tab to view them in the mirror.</p>
                            </div>
                        ) : (
                            <p className="text-xs text-zinc-600">Builds 4 complete outfits pinned around this piece.</p>
                        )}
                    </div>
                )}

                <input
                    ref={duplicateInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleDuplicatePhotoSelect}
                    className="hidden"
                />
                <div className="flex items-center gap-2 flex-wrap">
                    {onDuplicate && (
                        <button
                            onClick={() => duplicateInputRef.current?.click()}
                            disabled={busy}
                            className="inline-flex items-center gap-2 px-4 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 text-sm rounded-lg min-h-[44px]"
                            title="Take/upload a photo of another unit of this garment (e.g. same shirt, different color). Inherits brand, model, type, material; re-detects color."
                        >
                            {duplicating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                            Add another like this
                        </button>
                    )}
                    <button
                        onClick={() => setMergeOpen(true)}
                        disabled={busy || otherGarments.length === 0}
                        className="inline-flex items-center gap-2 px-4 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 text-sm rounded-lg min-h-[44px]"
                        title={otherGarments.length === 0 ? 'No other garments to merge with' : busy ? 'Wait for the current operation to finish' : 'Fold one or more duplicate garments into this one'}
                    >
                        <Combine className="w-4 h-4" /> Merge with…
                    </button>
                    <button
                        onClick={onDelete}
                        disabled={busy}
                        className="flex items-center gap-2 px-4 py-3 text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed text-sm min-h-[44px]"
                        title={busy ? 'Wait for the current operation to finish' : 'Delete this garment'}
                    >
                        <Trash2 className="w-4 h-4" /> Delete
                    </button>
                </div>
                {duplicateStatus && (
                    <p className="mt-2 text-xs text-zinc-400">{duplicateStatus}</p>
                )}
            </motion.div>

            <AnimatePresence>
                {mergeOpen && (
                    <MergePicker
                        primary={garment}
                        candidates={otherGarments}
                        onCancel={() => setMergeOpen(false)}
                        onConfirm={async (duplicateIds) => {
                            const res = await onMerge(duplicateIds);
                            if (res?.success) setMergeOpen(false);
                            return res;
                        }}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence>
                {lightboxSrc && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-4"
                        onClick={() => setLightboxSrc(null)}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={lightboxSrc} alt="" className="max-w-full max-h-full object-contain" />
                        <button
                            onClick={(e) => { e.stopPropagation(); setLightboxSrc(null); }}
                            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
                            aria-label="Close"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

function MergePicker({ primary, candidates, onCancel, onConfirm }) {
    const [selected, setSelected] = useState(() => new Set());
    const [filter, setFilter] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    // Default sort: same type first (most likely duplicates), then everything else
    const sorted = [...candidates].sort((a, b) => {
        const aMatch = a.type === primary.type ? 0 : 1;
        const bMatch = b.type === primary.type ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return 0;
    });

    const visible = filter
        ? sorted.filter(g => {
            const hay = `${g.type || ''} ${g.subtype || ''} ${g.primary_color || ''} ${g.brand || ''} ${g.model || ''}`.toLowerCase();
            return hay.includes(filter.toLowerCase());
        })
        : sorted;

    const toggle = (id) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleConfirm = async () => {
        if (selected.size === 0) return;
        setBusy(true);
        setErr('');
        try {
            const res = await onConfirm(Array.from(selected));
            if (!res?.success) setErr(res?.error || 'Merge failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/70 flex items-end md:items-center justify-center"
            onClick={onCancel}
        >
            <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 28 }}
                className="w-full md:max-w-2xl bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl p-4 max-h-[90vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-lg font-semibold text-white">Merge into this garment</h2>
                    <button onClick={onCancel} className="p-2 text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <p className="text-xs text-zinc-500 mb-3">
                    Pick the duplicates of <strong className="text-zinc-300">{summarizeGarment(primary)}</strong>. They&apos;ll be deleted; outfits, trips and shopping items that referenced them will repoint to this one.
                </p>

                <input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filter by type, color, brand…"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 mb-3"
                />

                <div className="flex-1 overflow-y-auto overscroll-contain -mx-1 px-1">
                    {visible.length === 0 ? (
                        <p className="text-center text-xs text-zinc-600 py-10">No matching garments.</p>
                    ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {visible.map(g => {
                                const url = pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path);
                                const isSelected = selected.has(g.id);
                                return (
                                    <button
                                        key={g.id}
                                        onClick={() => toggle(g.id)}
                                        className={`relative aspect-[3/4] rounded-lg overflow-hidden border text-left transition ${
                                            isSelected
                                                ? 'border-indigo-500 ring-2 ring-indigo-500/50'
                                                : 'border-zinc-800 hover:border-zinc-700'
                                        }`}
                                    >
                                        {url ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={url} alt="" className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full bg-zinc-900 flex items-center justify-center text-zinc-700">
                                                <Shirt className="w-6 h-6" />
                                            </div>
                                        )}
                                        {isSelected && (
                                            <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-indigo-500 text-white flex items-center justify-center">
                                                <Check className="w-3 h-3" />
                                            </div>
                                        )}
                                        <div className="absolute inset-x-0 bottom-0 p-1 bg-gradient-to-t from-black/85 to-transparent">
                                            <p className="text-[10px] text-white truncate">{summarizeGarment(g)}</p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {err && <p className="text-xs text-rose-400 mt-2">{err}</p>}

                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-900">
                    <span className="text-xs text-zinc-500 flex-1">
                        {selected.size === 0 ? 'No duplicates selected' : `${selected.size} duplicate${selected.size === 1 ? '' : 's'} selected`}
                    </span>
                    <button
                        onClick={onCancel}
                        className="px-3 py-2 text-zinc-400 hover:text-white text-sm rounded-lg min-h-[36px]"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={selected.size === 0 || busy}
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg min-h-[36px]"
                    >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Combine className="w-4 h-4" />}
                        Merge {selected.size > 0 ? `(${selected.size})` : ''}
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
}

function SliderRow({ label, description, value, onCommit }) {
    return (
        <div className="py-2 border-b border-zinc-900">
            <div className="flex items-center gap-2">
                <span
                    className="text-xs text-zinc-500 w-20 shrink-0"
                    title={description || undefined}
                >
                    {label}
                </span>
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
            {description && (
                <p className="text-[10px] text-zinc-600 mt-1 ml-[88px]">{description}</p>
            )}
        </div>
    );
}

// --- Outfits tab ---

const OUTFIT_SORTS = [
    { key: 'recent', label: 'Recent' },
    { key: 'oldest', label: 'Oldest' },
    { key: 'liked_first', label: 'Liked first' }
];

function OutfitsTab() {
    const [outfits, setOutfits] = useState([]);
    const [garmentIndex, setGarmentIndex] = useState({});
    const [loading, setLoading] = useState(true);
    const [likedOnly, setLikedOnly] = useState(false);
    const [labelFilter, setLabelFilter] = useState(null); // null = all
    const [sortBy, setSortBy] = useState('recent');
    const [selectedOutfit, setSelectedOutfit] = useState(null);
    const [selectedGarment, setSelectedGarment] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        const [outRes, garRes] = await Promise.all([
            getOutfits({ liked: likedOnly ? true : null }),
            getWardrobe({ limit: 500 })
        ]);
        setOutfits(outRes.success ? (outRes.data || []) : []);
        const idx = {};
        for (const g of (garRes.success ? (garRes.data || []) : [])) idx[g.id] = g;
        setGarmentIndex(idx);
        setLoading(false);
    }, [likedOnly]);

    useEffect(() => { load(); }, [load]);

    // All labels currently in use, for the filter row.
    const allLabels = Array.from(new Set(
        outfits.flatMap(o => Array.isArray(o.labels) ? o.labels : [])
    )).sort();

    const toggleLike = async (outfit) => {
        const res = await likeOutfit(outfit.id, !outfit.liked);
        if (res.success && res.data?.outfit) {
            setOutfits(prev => prev.map(o => o.id === outfit.id ? res.data.outfit : o));
            setSelectedOutfit(prev => prev?.id === outfit.id ? res.data.outfit : prev);
        }
    };

    const handleDeleteOutfit = async (outfit) => {
        if (!confirm(`Delete outfit "${outfit.name || outfit.id}"?`)) return;
        const res = await deleteOutfitAction(outfit.id);
        if (res.success) {
            setOutfits(prev => prev.filter(o => o.id !== outfit.id));
            setSelectedOutfit(prev => prev?.id === outfit.id ? null : prev);
        }
    };

    const handleLabelsChange = async (outfit, labels) => {
        const res = await updateOutfit(outfit.id, { labels });
        if (res.success && res.data?.outfit) {
            setOutfits(prev => prev.map(o => o.id === outfit.id ? res.data.outfit : o));
            setSelectedOutfit(prev => prev?.id === outfit.id ? res.data.outfit : prev);
        }
    };

    const handleRename = async (outfit, name) => {
        const res = await updateOutfit(outfit.id, { name });
        if (res.success && res.data?.outfit) {
            setOutfits(prev => prev.map(o => o.id === outfit.id ? res.data.outfit : o));
            setSelectedOutfit(prev => prev?.id === outfit.id ? res.data.outfit : prev);
        }
    };

    const handleGenerateVariations = async (outfit) => {
        const res = await generateOutfitVariations(outfit.id);
        if (res.success && res.data?.outfit) {
            setOutfits(prev => prev.map(o => o.id === outfit.id ? res.data.outfit : o));
            setSelectedOutfit(prev => prev?.id === outfit.id ? res.data.outfit : prev);
        }
        return res;
    };

    const filtered = outfits.filter(o => {
        if (labelFilter && !(o.labels || []).includes(labelFilter)) return false;
        return true;
    });
    const sorted = [...filtered].sort((a, b) => {
        if (sortBy === 'liked_first') {
            if (!!a.liked !== !!b.liked) return a.liked ? -1 : 1;
        }
        const ta = new Date(a.last_suggested_at || a.created_at || 0).getTime();
        const tb = new Date(b.last_suggested_at || b.created_at || 0).getTime();
        if (sortBy === 'oldest') return ta - tb;
        return tb - ta; // recent, liked_first tiebreaker
    });

    return (
        <>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
                <button
                    onClick={() => setLikedOnly(false)}
                    className={`px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                        !likedOnly ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                    }`}
                >
                    All
                </button>
                <button
                    onClick={() => setLikedOnly(true)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm min-h-[36px] border transition ${
                        likedOnly ? 'bg-rose-500/20 border-rose-500/50 text-rose-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
                    }`}
                >
                    <Heart className="w-3.5 h-3.5" /> Liked
                </button>
                <div className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800">
                    <ArrowUpDown className="w-3.5 h-3.5 text-zinc-500" />
                    <select
                        value={sortBy}
                        onChange={e => setSortBy(e.target.value)}
                        className="bg-transparent text-xs text-zinc-300 focus:outline-none"
                    >
                        {OUTFIT_SORTS.map(s => (
                            <option key={s.key} value={s.key} className="bg-zinc-900 text-zinc-200">{s.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {allLabels.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto touch-pan-x pb-3 mb-4 -mx-4 px-4 md:mx-0 md:px-0">
                    <button
                        onClick={() => setLabelFilter(null)}
                        className={`shrink-0 px-3 py-2 rounded-full text-xs min-h-[32px] border transition ${
                            !labelFilter ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                    >
                        All labels
                    </button>
                    {allLabels.map(lb => (
                        <button
                            key={lb}
                            onClick={() => setLabelFilter(lb === labelFilter ? null : lb)}
                            className={`shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-full text-xs min-h-[32px] border transition ${
                                labelFilter === lb ? 'bg-violet-500/20 border-violet-500/50 text-violet-200' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                            }`}
                        >
                            <Tag className="w-3 h-3" /> {lb}
                        </button>
                    ))}
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                </div>
            ) : sorted.length === 0 ? (
                <div className="text-center py-20 text-zinc-500">
                    <Layers className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="mb-1">{outfits.length === 0 ? 'No outfits saved yet.' : 'No outfits match the current filter.'}</p>
                    {outfits.length === 0 && (
                        <p className="text-xs">Ask in chat: &ldquo;recommend an outfit for dinner tonight&rdquo;.</p>
                    )}
                </div>
            ) : (
                <div className="space-y-3">
                    {sorted.map(o => (
                        <button
                            key={o.id}
                            onClick={() => setSelectedOutfit(o)}
                            className="w-full text-left rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex items-center gap-3 hover:border-zinc-700 transition"
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
                                        const url = g ? pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path) : null;
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
                                {(o.labels || []).length > 0 && (
                                    <div className="flex gap-1 mt-1 flex-wrap">
                                        {(o.labels || []).slice(0, 4).map(lb => (
                                            <span key={lb} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
                                                {lb}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); toggleLike(o); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggleLike(o); }
                                }}
                                className={`p-2 rounded-lg cursor-pointer ${o.liked ? 'text-rose-400' : 'text-zinc-600 hover:text-zinc-300'}`}
                                title={o.liked ? 'Unlike' : 'Like'}
                            >
                                <Heart className="w-5 h-5" fill={o.liked ? 'currentColor' : 'none'} />
                            </span>
                        </button>
                    ))}
                </div>
            )}

            <AnimatePresence>
                {selectedOutfit && (
                    <OutfitDetail
                        outfit={selectedOutfit}
                        garmentIndex={garmentIndex}
                        onClose={() => setSelectedOutfit(null)}
                        onToggleLike={() => toggleLike(selectedOutfit)}
                        onSelectGarment={(g) => setSelectedGarment(g)}
                        onDelete={() => handleDeleteOutfit(selectedOutfit)}
                        onLabelsChange={(labels) => handleLabelsChange(selectedOutfit, labels)}
                        onRename={(name) => handleRename(selectedOutfit, name)}
                        onGenerateVariations={() => handleGenerateVariations(selectedOutfit)}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence>
                {selectedGarment && (
                    <GarmentDetail
                        garment={selectedGarment}
                        onClose={() => setSelectedGarment(null)}
                        onChange={async (patch) => {
                            const targetId = selectedGarment.id;
                            const res = await updateGarment(targetId, patch);
                            if (res.success && res.data?.garment) {
                                setSelectedGarment(prev => prev?.id === targetId ? res.data.garment : prev);
                                setGarmentIndex(prev => ({ ...prev, [targetId]: res.data.garment }));
                            }
                            return res;
                        }}
                        onDelete={async () => {
                            if (!confirm('Delete this garment?')) return;
                            const targetId = selectedGarment.id;
                            const res = await deleteGarmentAction(targetId);
                            if (res.success) {
                                setSelectedGarment(null);
                                setGarmentIndex(prev => {
                                    const next = { ...prev };
                                    delete next[targetId];
                                    return next;
                                });
                            }
                        }}
                        onConfirmBrand={async (accept) => {
                            const targetId = selectedGarment.id;
                            const res = await confirmGarmentBrand(targetId, accept);
                            if (res.success && res.data?.garment) {
                                setSelectedGarment(prev => prev?.id === targetId ? res.data.garment : prev);
                                setGarmentIndex(prev => ({ ...prev, [targetId]: res.data.garment }));
                            }
                        }}
                        onReenrich={async (hint, opts) => {
                            const targetId = selectedGarment.id;
                            // Optimistic enriching flag so the skeleton shows immediately.
                            setSelectedGarment(prev => prev?.id === targetId ? { ...prev, enrichment_status: 'enriching' } : prev);
                            setGarmentIndex(prev => prev[targetId]
                                ? { ...prev, [targetId]: { ...prev[targetId], enrichment_status: 'enriching' } }
                                : prev);
                            const res = await reenrichGarment(targetId, hint, opts || {});
                            if (res.success && res.data?.garment) {
                                setSelectedGarment(prev => prev?.id === targetId ? res.data.garment : prev);
                                setGarmentIndex(prev => ({ ...prev, [targetId]: res.data.garment }));
                            } else {
                                setSelectedGarment(prev => prev?.id === targetId ? { ...prev, enrichment_status: 'complete' } : prev);
                            }
                            return res;
                        }}
                        onGenerateImage={async (opts) => {
                            const targetId = selectedGarment.id;
                            // Optimistic spinner.
                            const flip = (g, on) => g
                                ? { ...g, meta: { ...(g.meta || {}), ...(on ? { generatingImage: true } : {}) } }
                                : g;
                            const clear = (g) => {
                                if (!g) return g;
                                const meta = { ...(g.meta || {}) };
                                delete meta.generatingImage;
                                delete meta.generatingImageStartedAt;
                                return { ...g, meta };
                            };
                            setSelectedGarment(prev => prev?.id === targetId ? flip(prev, true) : prev);
                            setGarmentIndex(prev => prev[targetId]
                                ? { ...prev, [targetId]: flip(prev[targetId], true) }
                                : prev);
                            const res = await generateGarmentImage(targetId, opts || {});
                            if (res.success && res.data?.garment) {
                                setSelectedGarment(prev => prev?.id === targetId ? res.data.garment : prev);
                                setGarmentIndex(prev => ({ ...prev, [targetId]: res.data.garment }));
                            } else {
                                setSelectedGarment(prev => prev?.id === targetId ? clear(prev) : prev);
                                setGarmentIndex(prev => prev[targetId]
                                    ? { ...prev, [targetId]: clear(prev[targetId]) }
                                    : prev);
                            }
                            return res;
                        }}
                        otherGarments={Object.values(garmentIndex).filter(g => g.id !== selectedGarment.id)}
                        onMerge={async (duplicateIds) => {
                            const targetId = selectedGarment.id;
                            const res = await mergeGarments(targetId, duplicateIds);
                            if (res.success && res.data?.garment) {
                                setSelectedGarment(prev => prev?.id === targetId ? res.data.garment : prev);
                                setGarmentIndex(prev => ({ ...prev, [targetId]: res.data.garment }));
                            }
                            return res;
                        }}
                        onDuplicate={async (base64, mimeType) => {
                            const sourceId = selectedGarment.id;
                            const res = await duplicateGarment(sourceId, base64, mimeType);
                            if (res.success && res.data?.garment) {
                                setGarmentIndex(prev => ({ ...prev, [res.data.garment.id]: res.data.garment }));
                            }
                            return res;
                        }}
                    />
                )}
            </AnimatePresence>
        </>
    );
}

function OutfitDetail({ outfit, garmentIndex, onClose, onToggleLike, onSelectGarment, onDelete, onLabelsChange, onRename, onGenerateVariations }) {
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [lightboxSrc, setLightboxSrc] = useState(null);
    const [labelDraft, setLabelDraft] = useState('');
    const [savingLabel, setSavingLabel] = useState(false);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(outfit.name || '');
    const [savingName, setSavingName] = useState(false);
    const [generatingVariations, setGeneratingVariations] = useState(false);
    const [variationsError, setVariationsError] = useState('');
    const renderUrl = pathToUrl(outfit.rendered_image_path);
    const variationsUrl = pathToUrl(outfit.variations_image_path);
    const labels = Array.isArray(outfit.labels) ? outfit.labels : [];
    const garments = (outfit.garment_ids || [])
        .map(id => garmentIndex[id])
        .filter(Boolean);
    const missingCount = (outfit.garment_ids || []).length - garments.length;

    const openLightbox = (src) => { setLightboxSrc(src); setLightboxOpen(true); };

    const handleGenerateVariations = async () => {
        if (!onGenerateVariations) return;
        setGeneratingVariations(true);
        setVariationsError('');
        try {
            const res = await onGenerateVariations();
            if (!res?.success) setVariationsError(res?.error || 'Failed to generate variations');
        } finally { setGeneratingVariations(false); }
    };

    const handleAddLabel = async () => {
        const clean = labelDraft.trim().toLowerCase();
        if (!clean || labels.includes(clean) || !onLabelsChange) return;
        setSavingLabel(true);
        try {
            await onLabelsChange([...labels, clean]);
            setLabelDraft('');
        } finally { setSavingLabel(false); }
    };
    const handleRemoveLabel = async (lb) => {
        if (!onLabelsChange) return;
        await onLabelsChange(labels.filter(x => x !== lb));
    };

    const handleSaveName = async () => {
        const clean = nameDraft.trim();
        if (!onRename || clean === (outfit.name || '').trim()) {
            setEditingName(false);
            return;
        }
        setSavingName(true);
        try {
            await onRename(clean || null);
            setEditingName(false);
        } finally { setSavingName(false); }
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
                className="w-full md:max-w-lg bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl px-4 pb-4 max-h-[90vh] overflow-y-auto overscroll-contain"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between gap-2">
                    {editingName && onRename ? (
                        <div className="flex-1 flex items-center gap-2 min-w-0">
                            <input
                                autoFocus
                                value={nameDraft}
                                onChange={e => setNameDraft(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && !savingName) handleSaveName();
                                    if (e.key === 'Escape') { setEditingName(false); setNameDraft(outfit.name || ''); }
                                }}
                                disabled={savingName}
                                maxLength={80}
                                placeholder="Outfit name"
                                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-base text-white disabled:opacity-50"
                            />
                            <button
                                onClick={handleSaveName}
                                disabled={savingName}
                                className="p-2 text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                                title="Save"
                            >
                                {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => { if (onRename) { setNameDraft(outfit.name || ''); setEditingName(true); } }}
                            disabled={!onRename}
                            className={`flex-1 min-w-0 text-left group flex items-center gap-2 ${onRename ? 'cursor-text' : 'cursor-default'}`}
                            title={onRename ? 'Click to rename' : ''}
                        >
                            <h2 className="text-lg font-semibold text-white truncate">{outfit.name || 'Outfit'}</h2>
                            {onRename && <Pencil className="w-3.5 h-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 shrink-0" />}
                        </button>
                    )}
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={onToggleLike}
                            className={`p-2 rounded-lg ${outfit.liked ? 'text-rose-400' : 'text-zinc-500 hover:text-zinc-200'}`}
                            title={outfit.liked ? 'Unlike' : 'Like'}
                        >
                            <Heart className="w-5 h-5" fill={outfit.liked ? 'currentColor' : 'none'} />
                        </button>
                        <button onClick={onClose} className="p-2 text-zinc-400 hover:text-white">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {renderUrl ? (
                    <button
                        onClick={() => openLightbox(renderUrl)}
                        className="block w-full mb-4 rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800"
                        title="Tap to enlarge"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={renderUrl} alt="" className="w-full max-h-[60vh] object-contain" />
                    </button>
                ) : garments.length > 0 ? (
                    <div className="mb-4 grid grid-cols-2 gap-1 p-1 rounded-xl bg-zinc-900 border border-zinc-800">
                        {garments.slice(0, 4).map(g => {
                            const url = pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path);
                            return (
                                <div key={g.id} className="aspect-square bg-zinc-950 rounded overflow-hidden">
                                    {url && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={url} alt="" className="w-full h-full object-cover" />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : null}

                {outfit.occasion && (
                    <p className="text-xs text-zinc-400 italic mb-4 p-3 rounded-lg bg-zinc-900 border border-zinc-800">
                        {outfit.occasion}
                    </p>
                )}

                {onGenerateVariations && (
                    <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs uppercase tracking-wide text-zinc-500">Variations</h3>
                            <button
                                onClick={handleGenerateVariations}
                                disabled={generatingVariations}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/80 hover:bg-violet-500 disabled:opacity-50 text-white text-xs"
                                title="Render a side-by-side mirror image with outfit variations that share pieces with this one"
                            >
                                {generatingVariations ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                {variationsUrl ? 'Regenerate' : 'Generate variations'}
                            </button>
                        </div>
                        {variationsUrl ? (
                            <button
                                onClick={() => openLightbox(variationsUrl)}
                                className="block w-full rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800"
                                title="Tap to enlarge"
                            >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={variationsUrl} alt="" className="w-full max-h-[40vh] object-contain" />
                            </button>
                        ) : (
                            <p className="text-[11px] text-zinc-600 italic">
                                {generatingVariations
                                    ? 'Proposing swaps and rendering the mirror strip — this can take ~30s.'
                                    : 'See this outfit side-by-side with 2–3 small swaps from your wardrobe.'}
                            </p>
                        )}
                        {variationsError && <p className="mt-1 text-[11px] text-rose-400">{variationsError}</p>}
                    </div>
                )}

                {onLabelsChange && (
                    <div className="mb-4">
                        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Labels</h3>
                        <div className="flex gap-1.5 mb-2 flex-wrap">
                            {labels.length === 0 && (
                                <span className="text-[11px] text-zinc-600 italic">None yet. Try &ldquo;business meeting&rdquo;, &ldquo;party&rdquo;, &ldquo;regular day&rdquo;.</span>
                            )}
                            {labels.map(lb => (
                                <span key={lb} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-violet-500/15 text-violet-200 border border-violet-500/30">
                                    <Tag className="w-3 h-3" />
                                    {lb}
                                    <button
                                        onClick={() => handleRemoveLabel(lb)}
                                        className="text-violet-300 hover:text-white ml-0.5"
                                        title={`Remove ${lb}`}
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                value={labelDraft}
                                onChange={e => setLabelDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel(); } }}
                                placeholder="Add a label (e.g. business meeting)"
                                disabled={savingLabel}
                                maxLength={32}
                                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 disabled:opacity-50"
                            />
                            <button
                                onClick={handleAddLabel}
                                disabled={savingLabel || !labelDraft.trim()}
                                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs min-h-[36px]"
                            >
                                {savingLabel ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                Add
                            </button>
                        </div>
                    </div>
                )}

                <div className="mb-4">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
                        Garments · {(outfit.garment_ids || []).length} item{(outfit.garment_ids || []).length === 1 ? '' : 's'}
                    </h3>
                    {garments.length === 0 ? (
                        <p className="text-xs text-zinc-600">No garments to show.</p>
                    ) : (
                        <div className="space-y-2">
                            {garments.map(g => {
                                const url = pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path);
                                return (
                                    <button
                                        key={g.id}
                                        onClick={() => onSelectGarment(g)}
                                        className="w-full flex items-center gap-3 p-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-left"
                                    >
                                        <div className="w-12 h-16 shrink-0 bg-zinc-950 rounded overflow-hidden">
                                            {url ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={url} alt="" className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                                    <Shirt className="w-5 h-5" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-white truncate">{summarizeGarment(g)}</p>
                                            {(g.pattern || g.material_guess) && (
                                                <p className="text-xs text-zinc-500 truncate">
                                                    {[g.pattern, g.material_guess].filter(Boolean).join(' · ')}
                                                </p>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                            {missingCount > 0 && (
                                <p className="text-[11px] text-zinc-600 italic">
                                    {missingCount} item{missingCount === 1 ? '' : 's'} no longer in wardrobe.
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {onDelete && (
                    <div className="flex items-center justify-end border-t border-zinc-900 pt-3">
                        <button
                            onClick={onDelete}
                            className="flex items-center gap-2 px-4 py-3 text-red-400 hover:text-red-300 text-sm min-h-[44px]"
                        >
                            <Trash2 className="w-4 h-4" /> Delete outfit
                        </button>
                    </div>
                )}
            </motion.div>

            <AnimatePresence>
                {lightboxOpen && lightboxSrc && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
                        onClick={(e) => { e.stopPropagation(); setLightboxOpen(false); }}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={lightboxSrc} alt="" className="max-w-full max-h-full object-contain" />
                        <button
                            onClick={(e) => { e.stopPropagation(); setLightboxOpen(false); }}
                            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
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
    const [selectedGarment, setSelectedGarment] = useState(null);
    const [outfitByDate, setOutfitByDate] = useState({});
    const [rendering, setRendering] = useState(false);
    const [renderMsg, setRenderMsg] = useState('');
    const [lightboxSrc, setLightboxSrc] = useState(null);

    useEffect(() => {
        getWardrobe({ limit: 500 }).then(res => {
            const idx = {};
            for (const g of (res.success ? (res.data || []) : [])) idx[g.id] = g;
            setGarmentIndex(idx);
        });
    }, []);

    // Memoized so `[]` fallback stays referentially stable when daily_plan is
    // missing — otherwise the useEffect below would fire every render and loop
    // against its own setState.
    const daily = useMemo(
        () => trip.weather_snapshot?.daily_plan || [],
        [trip.weather_snapshot?.daily_plan]
    );
    const days = trip.weather_snapshot?.days || [];
    const rationale = trip.weather_snapshot?.pack_rationale;
    const capsuleIds = (trip.status === 'planned' ? trip.planned_capsule : trip.actual_capsule) || [];

    // Load outfit records for any daily entries that have an outfit_id, so we
    // can show thumbnails and route clicks to the rendered image.
    useEffect(() => {
        const ids = Array.from(new Set(daily.map(d => d?.outfit_id).filter(Boolean)));
        if (ids.length === 0) { setOutfitByDate({}); return; }
        let cancelled = false;
        Promise.all(ids.map(id => getOutfit(id))).then(results => {
            if (cancelled) return;
            const byDate = {};
            results.forEach(r => {
                if (r?.success && r.data) byDate[r.data.id] = r.data;
            });
            setOutfitByDate(byDate);
        });
        return () => { cancelled = true; };
    }, [daily]);

    const doAction = async (fn) => {
        setBusy(true);
        try { await fn(); await onRefresh(); } finally { setBusy(false); }
    };

    const removeFromCapsule = async (garmentId) => {
        await doAction(() => removeFromTripCapsule(trip.id, [garmentId]));
    };

    const handleRenderDaily = async () => {
        setRendering(true);
        setRenderMsg('');
        try {
            const res = await renderTripDailyOutfits(trip.id);
            if (!res.success) {
                setRenderMsg(res.error || 'Failed to render');
            } else if (res.data?.needs_reference) {
                setRenderMsg('Add a reference selfie in your profile first.');
            } else {
                const r = res.data?.rendered || 0;
                const s = res.data?.skipped || 0;
                setRenderMsg(r === 0 && s === 0 ? 'Nothing to render.' : `Rendered ${r}${s ? `, ${s} already up to date` : ''}.`);
                await onRefresh();
            }
        } finally {
            setRendering(false);
        }
    };

    const patchLocalGarment = (g) => {
        if (!g?.id) return;
        setGarmentIndex(prev => ({ ...prev, [g.id]: g }));
        setSelectedGarment(prev => (prev?.id === g.id ? g : prev));
    };

    const daysWithoutRender = daily.filter(d => {
        const o = d?.outfit_id ? outfitByDate[d.outfit_id] : null;
        return (Array.isArray(d?.garment_ids) && d.garment_ids.length > 0) && !o?.rendered_image_path;
    }).length;

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center"
            onClick={onClose}
        >
            <motion.div
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 28 }}
                className="w-full md:max-w-lg bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl px-4 pb-4 max-h-[90vh] overflow-y-auto overscroll-contain"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-white truncate">{trip.destination}</h2>
                    <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white">
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
                        <div className="flex gap-2 overflow-x-auto touch-pan-x pb-1">
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
                                const url = g ? pathToUrl(g.generated_image_path || g.crop_image_path || g.source_image_path) : null;
                                const label = g ? summarizeGarment(g) : 'Garment';
                                return (
                                    <div key={gid} className="relative group aspect-[3/4] bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800">
                                        <button
                                            type="button"
                                            onClick={() => g && setSelectedGarment(g)}
                                            disabled={!g}
                                            title={label}
                                            aria-label={label}
                                            className="absolute inset-0 w-full h-full"
                                        >
                                            {url ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={url} alt={label} className="w-full h-full object-cover" />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                                    <Shirt className="w-5 h-5" />
                                                </div>
                                            )}
                                        </button>
                                        {trip.status === 'active' && (
                                            <button
                                                onClick={() => removeFromCapsule(gid)}
                                                className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-black/90 transition opacity-0 group-hover:opacity-100"
                                                title="Remove from capsule"
                                            >
                                                <Trash2 className="w-3.5 h-3.5 text-red-400" />
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
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs uppercase tracking-wide text-zinc-500">Daily plan</h3>
                            <button
                                onClick={handleRenderDaily}
                                disabled={rendering}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 disabled:opacity-50"
                                title={daysWithoutRender > 0 ? `Render ${daysWithoutRender} day(s)` : 'Re-render all'}
                            >
                                {rendering
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <Sparkles className="w-3 h-3" />}
                                <span>{daysWithoutRender > 0 ? 'Generate looks' : 'Looks ready'}</span>
                            </button>
                        </div>
                        {renderMsg && (
                            <p className="text-[11px] text-zinc-400 mb-2">{renderMsg}</p>
                        )}
                        <div className="space-y-2">
                            {daily.map((d, i) => {
                                const outfit = d?.outfit_id ? outfitByDate[d.outfit_id] : null;
                                const renderUrl = outfit?.rendered_image_path ? pathToUrl(outfit.rendered_image_path) : null;
                                return (
                                    <div key={i} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 flex gap-2">
                                        {renderUrl ? (
                                            <button
                                                type="button"
                                                onClick={() => setLightboxSrc(renderUrl)}
                                                className="shrink-0 w-16 h-20 rounded-md overflow-hidden bg-zinc-950 border border-zinc-800 hover:border-zinc-600 transition"
                                                title="Enlarge"
                                            >
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={renderUrl} alt={outfit?.name || 'Daily look'} className="w-full h-full object-cover" />
                                            </button>
                                        ) : (
                                            <div className="shrink-0 w-16 h-20 rounded-md bg-zinc-950 border border-zinc-800 flex items-center justify-center text-zinc-700">
                                                <User className="w-5 h-5" />
                                            </div>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-zinc-400 mb-1">{formatDate(d.date)}</p>
                                            <div className="flex gap-1 flex-wrap">
                                                {(d.garment_ids || []).map(gid => {
                                                    const g = garmentIndex[gid];
                                                    return (
                                                        <button
                                                            key={gid}
                                                            type="button"
                                                            onClick={() => g && setSelectedGarment(g)}
                                                            disabled={!g}
                                                            title={g ? summarizeGarment(g) : gid}
                                                            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-70"
                                                        >
                                                            {g ? summarizeGarment(g) : gid}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </motion.div>

            {/* Nested modals are siblings of the trip panel but children of the
                outer backdrop. Wrap in a stop-propagation div so clicks on their
                backdrops don't also close the trip modal via bubbling. */}
            <div onClick={(e) => e.stopPropagation()}>
                <AnimatePresence>
                    {selectedGarment && (
                        <GarmentDetail
                            garment={selectedGarment}
                            onClose={() => setSelectedGarment(null)}
                            onChange={async (patch) => {
                                const targetId = selectedGarment.id;
                                const res = await updateGarment(targetId, patch);
                                if (res.success && res.data?.garment) patchLocalGarment(res.data.garment);
                                return res;
                            }}
                            onDelete={async () => {
                                if (!confirm('Delete this garment?')) return;
                                const targetId = selectedGarment.id;
                                const res = await deleteGarmentAction(targetId);
                                if (res.success) {
                                    setSelectedGarment(null);
                                    setGarmentIndex(prev => {
                                        const next = { ...prev };
                                        delete next[targetId];
                                        return next;
                                    });
                                }
                            }}
                            onConfirmBrand={async (accept) => {
                                const targetId = selectedGarment.id;
                                const res = await confirmGarmentBrand(targetId, accept);
                                if (res.success && res.data?.garment) patchLocalGarment(res.data.garment);
                            }}
                            onReenrich={async (hint, opts) => {
                                // Snapshot the garment here — the closure's
                                // `selectedGarment` reference would drift if
                                // the user opens a different tile while the
                                // re-enrich is in flight, and the error path
                                // would then spread the *wrong* garment's data
                                // onto the original id.
                                const snapshot = selectedGarment;
                                const targetId = snapshot.id;
                                patchLocalGarment({ ...snapshot, enrichment_status: 'enriching' });
                                const res = await reenrichGarment(targetId, hint, opts || {});
                                if (res.success && res.data?.garment) patchLocalGarment(res.data.garment);
                                else patchLocalGarment({ ...snapshot, enrichment_status: 'complete' });
                                return res;
                            }}
                            onGenerateImage={async (opts) => {
                                const targetId = selectedGarment.id;
                                const res = await generateGarmentImage(targetId, opts || {});
                                if (res.success && res.data?.garment) patchLocalGarment(res.data.garment);
                                return res;
                            }}
                        />
                    )}
                </AnimatePresence>

                <AnimatePresence>
                    {lightboxSrc && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
                            onClick={() => setLightboxSrc(null)}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={lightboxSrc} alt="" className="max-w-full max-h-full object-contain" />
                            <button
                                onClick={() => setLightboxSrc(null)}
                                className="absolute top-4 right-4 p-2 rounded-full bg-black/60 text-white hover:bg-black/80"
                                aria-label="Close"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </motion.div>
    );
}

// --- Shopping tab ---

function ShoppingTab() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('wanted');
    const [generatingRef, setGeneratingRef] = useState({}); // id → bool
    const [openOutfit, setOpenOutfit] = useState(null);
    const [openOutfitGarments, setOpenOutfitGarments] = useState({});

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

    const generateRef = async (id) => {
        setGeneratingRef(prev => ({ ...prev, [id]: true }));
        try {
            const res = await generateShoppingReferenceImage(id);
            if (res.success && res.data?.item) {
                setItems(prev => prev.map(it => it.id === id ? res.data.item : it));
            }
        } finally {
            setGeneratingRef(prev => ({ ...prev, [id]: false }));
        }
    };

    const openLinkedOutfit = async (outfitId) => {
        const [outRes, garRes] = await Promise.all([
            getOutfit(outfitId),
            getWardrobe({ limit: 500 })
        ]);
        if (outRes.success && outRes.data) {
            setOpenOutfit(outRes.data);
            const idx = {};
            for (const g of (garRes.success ? (garRes.data || []) : [])) idx[g.id] = g;
            setOpenOutfitGarments(idx);
        }
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
                <>
                <div className="space-y-2">
                    {items.map(item => {
                        const refUrl = pathToUrl(item.reference_image_path);
                        const outfitId = item.suggested_context?.outfit_id;
                        return (
                            <div
                                key={item.id}
                                className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 flex items-start gap-3"
                            >
                                <div className="w-20 h-24 shrink-0 bg-zinc-950 rounded-lg overflow-hidden flex items-center justify-center">
                                    {refUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={refUrl} alt="" className="w-full h-full object-cover" />
                                    ) : (
                                        <ShoppingBag className="w-6 h-6 text-zinc-700" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white">{item.description}</p>
                                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                                        {item.type && <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{item.type}</span>}
                                        {item.primary_color && <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{item.primary_color}</span>}
                                        <span className={`text-[10px] px-2 py-0.5 rounded border ${priorityColor(item.priority)}`}>{item.priority}</span>
                                    </div>
                                    {outfitId && (
                                        <button
                                            onClick={() => openLinkedOutfit(outfitId)}
                                            className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200"
                                            title="Open the outfit that triggered this item"
                                        >
                                            <Layers className="w-3 h-3" /> For outfit {outfitId.slice(0, 8)}…
                                        </button>
                                    )}
                                    {item.status === 'wanted' && (
                                        <button
                                            onClick={() => generateRef(item.id)}
                                            disabled={!!generatingRef[item.id]}
                                            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-600/80 hover:bg-violet-500 disabled:opacity-50 text-white text-[11px]"
                                            title="Generate a reference photo from the description"
                                        >
                                            {generatingRef[item.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                                            {refUrl ? 'Regenerate reference' : 'Generate reference image'}
                                        </button>
                                    )}
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
                        );
                    })}
                </div>

                <AnimatePresence>
                    {openOutfit && (
                        <OutfitDetail
                            outfit={openOutfit}
                            garmentIndex={openOutfitGarments}
                            onClose={() => setOpenOutfit(null)}
                            onToggleLike={() => {}}
                            onSelectGarment={() => {}}
                        />
                    )}
                </AnimatePresence>
                </>
            )}
        </>
    );
}

// --- Profile sheet ---

function ProfilePrefsReadout({ prefs }) {
    const fitLabel = FIT_OPTIONS.find(o => o.key === prefs.fit)?.label;
    const formalityLabel = FORMALITY_OPTIONS.find(o => o.key === prefs.formality_bias)?.label;
    const loved = Array.isArray(prefs.colors_loved) ? prefs.colors_loved : [];
    const avoided = Array.isArray(prefs.colors_avoided) ? prefs.colors_avoided : [];
    const nothing = !fitLabel && !formalityLabel && loved.length === 0 && avoided.length === 0;
    if (nothing) return <p className="text-xs text-zinc-600">No preferences set.</p>;
    return (
        <div className="space-y-1.5 text-xs text-zinc-300">
            {fitLabel && <div><span className="text-zinc-500">Fit:</span> {fitLabel}</div>}
            {formalityLabel && <div><span className="text-zinc-500">Formality:</span> {formalityLabel}</div>}
            {loved.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-zinc-500">Loves:</span>
                    {loved.map(c => <span key={c} className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">{c}</span>)}
                </div>
            )}
            {avoided.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-zinc-500">Avoids:</span>
                    {avoided.map(c => <span key={c} className="px-2 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-300">{c}</span>)}
                </div>
            )}
        </div>
    );
}

const SIZE_FIELDS = [
    { key: 'tops', label: 'Tops' },
    { key: 'bottoms', label: 'Bottoms / waist' },
    { key: 'inseam', label: 'Inseam' },
    { key: 'shoes', label: 'Shoes' },
    { key: 'jackets', label: 'Jackets' }
];

const FIT_OPTIONS = [
    { key: '', label: '—' },
    { key: 'slim', label: 'Slim' },
    { key: 'regular', label: 'Regular' },
    { key: 'relaxed', label: 'Relaxed' }
];

const FORMALITY_OPTIONS = [
    { key: '', label: '—' },
    { key: 'casual', label: 'Casual' },
    { key: 'smart_casual', label: 'Smart casual' },
    { key: 'business', label: 'Business' }
];

function ProfileSheet({ onClose }) {
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [brandsDraft, setBrandsDraft] = useState('');
    const [notesDraft, setNotesDraft] = useState('');
    const [sizingDraft, setSizingDraft] = useState({});
    const [prefsDraft, setPrefsDraft] = useState({});
    // Only one section is ever editable at once. Extends the old 'brands' | 'notes' union.
    const [editing, setEditing] = useState(null);
    const selfieInputRef = useRef(null);

    useEffect(() => {
        (async () => {
            const res = await getWardrobeProfile();
            if (res.success) {
                const p = res.data || {};
                setProfile(p);
                setBrandsDraft((p.preferred_brands || []).join(', '));
                setNotesDraft(p.style_notes || '');
                setSizingDraft(p.sizing || {});
                setPrefsDraft(p.style_preferences || {});
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

    const saveSizing = async () => {
        // Strip empty strings so the JSON stays compact and getUserProfile
        // returns only the fields the user actually filled in.
        const cleaned = {};
        for (const [k, v] of Object.entries(sizingDraft)) {
            if (v && String(v).trim() !== '') cleaned[k] = String(v).trim();
        }
        const res = await updateWardrobeProfile({ sizing: cleaned });
        if (res.success) {
            setProfile(res.data?.profile || { ...profile, sizing: cleaned });
            setSizingDraft(cleaned);
        }
        setEditing(null);
    };

    const savePrefs = async () => {
        const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map(s => s.trim()).filter(Boolean));
        const cleaned = {
            fit: prefsDraft.fit || '',
            formality_bias: prefsDraft.formality_bias || '',
            colors_loved: toList(prefsDraft.colors_loved),
            colors_avoided: toList(prefsDraft.colors_avoided)
        };
        const res = await updateWardrobeProfile({ style_preferences: cleaned });
        if (res.success) {
            setProfile(res.data?.profile || { ...profile, style_preferences: cleaned });
            setPrefsDraft(cleaned);
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
                className="w-full md:max-w-lg bg-zinc-950 border-t md:border border-zinc-800 md:rounded-2xl rounded-t-2xl px-4 pb-4 max-h-[90vh] overflow-y-auto overscroll-contain"
                onClick={e => e.stopPropagation()}
            >
                <input
                    ref={selfieInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleSelfieSelect}
                    className="hidden"
                />

                <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-4 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-white">Wardrobe profile</h2>
                    <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white">
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
                                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Sizes</h3>
                                {editing !== 'sizing' && (
                                    <button
                                        onClick={() => setEditing('sizing')}
                                        className="text-xs text-indigo-400 hover:text-indigo-300"
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>
                            {editing === 'sizing' ? (
                                <div className="space-y-2">
                                    {SIZE_FIELDS.map(({ key, label }) => (
                                        <div key={key} className="flex items-center gap-2">
                                            <label className="w-32 text-xs text-zinc-500 shrink-0">{label}</label>
                                            <input
                                                value={sizingDraft[key] || ''}
                                                onChange={e => setSizingDraft(prev => ({ ...prev, [key]: e.target.value }))}
                                                placeholder={key === 'shoes' ? '10, 43, …' : 'M, 32, …'}
                                                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-white"
                                            />
                                        </div>
                                    ))}
                                    <p className="text-[10px] text-zinc-600">Free-form — use whatever the brands you buy actually print on the tag.</p>
                                    <div className="flex gap-2">
                                        <button onClick={saveSizing} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg">Save</button>
                                        <button onClick={() => { setEditing(null); setSizingDraft(profile?.sizing || {}); }} className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded-lg">Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-2">
                                    {SIZE_FIELDS.every(({ key }) => !profile?.sizing?.[key]) ? (
                                        <p className="text-xs text-zinc-600">No sizes set.</p>
                                    ) : (
                                        SIZE_FIELDS
                                            .filter(({ key }) => profile?.sizing?.[key])
                                            .map(({ key, label }) => (
                                                <span key={key} className="text-xs px-2 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300">
                                                    <span className="text-zinc-500">{label}:</span> {profile.sizing[key]}
                                                </span>
                                            ))
                                    )}
                                </div>
                            )}
                        </section>

                        <section>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Style preferences</h3>
                                {editing !== 'prefs' && (
                                    <button
                                        onClick={() => setEditing('prefs')}
                                        className="text-xs text-indigo-400 hover:text-indigo-300"
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>
                            {editing === 'prefs' ? (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <label className="w-32 text-xs text-zinc-500 shrink-0">Fit</label>
                                        <select
                                            value={prefsDraft.fit || ''}
                                            onChange={e => setPrefsDraft(prev => ({ ...prev, fit: e.target.value }))}
                                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-white"
                                        >
                                            {FIT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="w-32 text-xs text-zinc-500 shrink-0">Formality</label>
                                        <select
                                            value={prefsDraft.formality_bias || ''}
                                            onChange={e => setPrefsDraft(prev => ({ ...prev, formality_bias: e.target.value }))}
                                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-white"
                                        >
                                            {FORMALITY_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="w-32 text-xs text-zinc-500 shrink-0">Loves colors</label>
                                        <input
                                            value={Array.isArray(prefsDraft.colors_loved) ? prefsDraft.colors_loved.join(', ') : (prefsDraft.colors_loved || '')}
                                            onChange={e => setPrefsDraft(prev => ({ ...prev, colors_loved: e.target.value }))}
                                            placeholder="navy, olive, cream"
                                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-white"
                                        />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="w-32 text-xs text-zinc-500 shrink-0">Avoids colors</label>
                                        <input
                                            value={Array.isArray(prefsDraft.colors_avoided) ? prefsDraft.colors_avoided.join(', ') : (prefsDraft.colors_avoided || '')}
                                            onChange={e => setPrefsDraft(prev => ({ ...prev, colors_avoided: e.target.value }))}
                                            placeholder="neon, pink"
                                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-white"
                                        />
                                    </div>
                                    <p className="text-[10px] text-zinc-600">Color lists are comma-separated. These soft-bias the stylist — they don't hard-filter garments.</p>
                                    <div className="flex gap-2">
                                        <button onClick={savePrefs} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg">Save</button>
                                        <button onClick={() => { setEditing(null); setPrefsDraft(profile?.style_preferences || {}); }} className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded-lg">Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <ProfilePrefsReadout prefs={profile?.style_preferences || {}} />
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
