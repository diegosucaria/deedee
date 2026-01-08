'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, Loader2, UserPlus, CheckCircle } from 'lucide-react';
import { triggerSmartLearn, createPerson } from '@/app/actions';

export function SmartLearnModal({ isOpen, onClose, onLearned }) {
    const [status, setStatus] = useState('idle'); // idle, analyzing, reviewing, saving
    const [candidates, setCandidates] = useState([]);
    const [selected, setSelected] = useState(new Set());
    const [error, setError] = useState(null);

    const startAnalysis = async () => {
        setStatus('analyzing');
        setError(null);
        try {
            const res = await triggerSmartLearn();
            if (!res.success) throw new Error(res.error);
            if (!res.candidates || res.candidates.length === 0) {
                setStatus('empty');
            } else {
                setCandidates(res.candidates);
                // Select all by default
                setSelected(new Set(res.candidates.map(c => c.phone)));
                setStatus('reviewing');
            }
        } catch (e) {
            setError(e.message);
            setStatus('idle');
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
                    metadata: JSON.stringify({ confidence: c.confidence, source: 'smart_learn' })
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
                                        <div className={`mt-1 w-5 h-5 rounded-full border flex items-center justify-center ${selected.has(c.phone) ? 'bg-primary border-primary' : 'border-muted-foreground'}`}>
                                            {selected.has(c.phone) && <CheckCircle size={12} className="text-primary-foreground" />}
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex justify-between">
                                                <span className="font-semibold">{c.suggestedName}</span>
                                                <span className="text-xs text-muted-foreground">{c.relationship}</span>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-0.5">{c.phone}</p>
                                            <p className="text-xs italic text-muted-foreground/70 mt-1">"{c.reason}"</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
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
