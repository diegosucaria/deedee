'use client';

import { motion } from 'framer-motion';
import { User, Phone, Edit, Trash2 } from 'lucide-react';
import Image from 'next/image';

export function PersonCard({ person, onEdit, onDelete }) {
    const avatarUrl = `/api/v1/people/${encodeURIComponent(person.id)}/avatar`;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="bg-card/50 backdrop-blur-sm border border-border rounded-xl p-4 flex items-center space-x-4 hover:border-primary/50 transition-colors group relative"
        >
            {/* Avatar */}
            <div className="relative w-12 h-12 flex-shrink-0">
                {/* Use img with error fallback for simplicity or Next Image if we trust domain config */}
                {/* Since avatar might 404, we need simple fallback */}
                <img
                    src={avatarUrl}
                    alt={person.name}
                    className="w-12 h-12 rounded-full object-cover bg-white/10"
                    onError={(e) => {
                        e.target.onerror = null;
                        e.target.style.display = 'none';
                        e.target.nextSibling.style.display = 'flex'; // Show fallback
                    }}
                />
                <div className="hidden absolute inset-0 bg-secondary rounded-full flex items-center justify-center text-secondary-foreground">
                    <User size={20} />
                </div>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground truncate">{person.name}</h3>
                <div className="flex items-center text-xs text-muted-foreground space-x-2 mt-0.5">
                    {person.relationship && (
                        <span className="px-1.5 py-0.5 rounded-md bg-secondary/50 text-secondary-foreground">
                            {person.relationship}
                        </span>
                    )}
                    <div className="flex items-center space-x-1">
                        <Phone size={10} />
                        <span>{person.phone || 'No phone'}</span>
                    </div>
                </div>
                {person.notes && (
                    <p className="text-xs text-muted-foreground/70 truncate mt-1">
                        {person.notes}
                    </p>
                )}
            </div>

            {/* Actions */}
            <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => onEdit(person)} className="p-2 hover:bg-secondary rounded-full transition-colors">
                    <Edit size={16} className="text-muted-foreground hover:text-foreground" />
                </button>
                <button onClick={() => onDelete(person.id)} className="p-2 hover:bg-destructive/10 rounded-full transition-colors">
                    <Trash2 size={16} className="text-destructive" />
                </button>
            </div>
        </motion.div>
    );
}
