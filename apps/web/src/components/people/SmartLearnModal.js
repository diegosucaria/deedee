'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, Loader2, UserPlus, CheckCircle } from 'lucide-react';
import { triggerSmartLearn, createPerson } from '@/app/actions';

export function SmartLearnModal({ isOpen, onClose, onLearned }) {
    const [status, setStatus] = useState('idle'); // idle, analyzing, reviewing, saving
    const [loadingMore, setLoadingMore] = useState(false);
    const [candidates, setCandidates] = useState([]);
    const [selected, setSelected] = useState(new Set());
    const [error, setError] = useState(null);
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(true);

    const LIMIT = 5;

    const startAnalysis = async () => {
        setStatus('analyzing');
        setError(null);
        setCandidates([]);
        setOffset(0);
        setHasMore(true);

        try {
            const res = await triggerSmartLearn(0, LIMIT);
            if (!res.success) throw new Error(res.error);

            if (!res.candidates || res.candidates.length === 0) {
                setStatus('empty');
                setHasMore(false);
            } else {
                setCandidates(res.candidates);
                // Select all by default
                setSelected(new Set(res.candidates.map(c => c.phone)));
                setStatus('reviewing');
                setOffset(LIMIT);
                if (res.candidates.length < LIMIT) setHasMore(false);
            }
        } catch (e) {
            setError(e.message);
            setStatus('idle');
        }
    };

    const loadMore = async () => {
        setLoadingMore(true);
        setError(null);
        try {
            const res = await triggerSmartLearn(offset, LIMIT);
            if (!res.success) throw new Error(res.error);

            if (res.candidates && res.candidates.length > 0) {
                // Filter duplicates just in case
                const existingPhones = new Set(candidates.map(c => c.phone));
                const newCandidates = res.candidates.filter(c => !existingPhones.has(c.phone));

                setCandidates(prev => [...prev, ...newCandidates]);

                // Auto-select new ones
                setSelected(prev => {
                    const next = new Set(prev);
                    newCandidates.forEach(c => next.add(c.phone));
                    return next;
                });

                setOffset(prev => prev + LIMIT);
                if (res.candidates.length < LIMIT) setHasMore(false);
            } else {
                setHasMore(false);
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setLoadingMore(false);
        }
    };

    const toggleCandidate = (phone) => {
        const newSet = new Set(selected);
        if (newSet.has(phone)) newSet.delete(phone);
        else newSet.add(phone);
        setSelected(newSet);
    };

    const saveSelected = async () => {
        setStatus('saving');
        try {
            const toSave = candidates.filter(c => selected.has(c.phone));
            for (const c of toSave) {
                await createPerson(null, createFormData({
                    name: c.suggestedName,
                    phone: c.phone,
                    relationship: c.relationship,
                    notes: c.reason,
                    metadata: JSON.stringify({ confidence: c.confidence, source: 'smart_learn' }),
                    identifiers: JSON.stringify(c.identifiers || {})
                }));
            }
            onLearned();
            onClose();
        } catch (e) {
            setError(e.message);
            setStatus('reviewing');
        }
    };

    const createFormData = (obj) => {
        const fd = new FormData();
        for (const key in obj) fd.append(key, obj[key]);
        return fd;
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]"
            >
                {/* Header */}
                <div className="p-4 border-b border-border flex justify-between items-center bg-secondary/20">
                    <div className="flex items-center space-x-2 text-primary">
                        <Sparkles size={20} />
                        <h2 className="font-semibold">Smart Learn Contacts</h2>
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto flex-1">
                    {status === 'idle' && (
                        <div className="text-center py-8">
                            <Sparkles className="mx-auto w-12 h-12 text-primary/50 mb-4" />
                            <p className="text-muted-foreground mb-6">
                                I can analyze your recent WhatsApp conversations to find people you know but haven't saved explicitly.
                            </p>
                            <button onClick={startAnalysis} className="btn-primary w-full justify-center">
                                Start Analysis
                            </button>
                            {error && <p className="text-destructive text-sm mt-4">{error}</p>}
                        </div>
                    )}

                    {status === 'analyzing' && (
                        <div className="text-center py-12 flex flex-col items-center">
                            <Loader2 className="w-10 h-10 animate-spin text-primary mb-4" />
                            <p className="text-muted-foreground animate-pulse">Reading conversations...</p>
                        </div>
                    )}

                    {status === 'empty' && (
                        <div className="text-center py-8">
                            <p className="text-muted-foreground">No new suggestions found.</p>
                            <button onClick={onClose} className="btn-secondary mt-4">Close</button>
                        </div>
                    )}

                    {(status === 'reviewing' || status === 'saving') && (
                        <div className="space-y-4">
                            <p className="text-sm text-muted-foreground">Check the people you want to save:</p>
                            <div className="space-y-2">
                                {candidates.map(c => (
                                    <div
                                        key={c.phone}
                                        className={`p-3 rounded-lg border cursor-pointer transition-colors flex items-start space-x-3 ${selected.has(c.phone) ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                                        onClick={() => toggleCandidate(c.phone)}
                                    >
                                        <div className={`mt-1 w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${selected.has(c.phone) ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                                            {selected.has(c.phone) && <CheckCircle size={12} className="text-primary-foreground" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start">
                                                <span className="font-semibold truncate pr-2">{c.suggestedName}</span>
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground whitespace-nowrap">{c.relationship}</span>
                                            </div>

                                            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{c.phone}</p>

                                            {/* Identifiers Badges */}
                                            {c.identifiers && Object.keys(c.identifiers).length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1.5">
                                                    {Object.entries(c.identifiers).map(([key, val]) => (
                                                        key !== 'whatsapp' && (
                                                            <span key={key} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                                                                {key}: {val}
                                                            </span>
                                                        )
                                                    ))}
                                                </div>
                                            )}

                                            <p className="text-xs italic text-muted-foreground/70 mt-2 border-l-2 border-primary/20 pl-2">
                                                "{c.reason}"
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Load More Button */}
                            {hasMore && (
                                <button
                                    onClick={loadMore}
                                    disabled={loadingMore}
                                    className="w-full py-2 text-sm text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg flex items-center justify-center hover:bg-secondary/10 transition-colors"
                                >
                                    {loadingMore ? <Loader2 size={16} className="animate-spin mr-2" /> : <UserPlus size={16} className="mr-2" />}
                                    {loadingMore ? 'Analyzing next batch...' : 'Load More Candidates'}
                                </button>
                            )}

                            {error && <p className="text-destructive text-sm text-center">{error}</p>}
                        </div>
                    )}
                </div>

                {/* Footer */}
                {(status === 'reviewing' || status === 'saving') && (
                    <div className="p-4 border-t border-border bg-card">
                        <button
                            onClick={saveSelected}
                            disabled={status === 'saving' || selected.size === 0}
                            className="btn-primary w-full justify-center"
                        >
                            {status === 'saving' ? <Loader2 className="animate-spin" /> : `Save ${selected.size} Contacts`}
                        </button>
                    </div>
                )}
            </motion.div>
        </div>
    );
}
