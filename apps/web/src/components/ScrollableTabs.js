'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

export default function ScrollableTabs({ tabs, activeTab, onChange, trailing }) {
    const scrollRef = useRef(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    const checkScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 2);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        checkScroll();
        el.addEventListener('scroll', checkScroll, { passive: true });
        const ro = new ResizeObserver(checkScroll);
        ro.observe(el);
        return () => {
            el.removeEventListener('scroll', checkScroll);
            ro.disconnect();
        };
    }, [checkScroll]);

    // Auto-scroll active tab into view
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const activeButton = el.querySelector('[data-active="true"]');
        if (activeButton) {
            activeButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }, [activeTab]);

    return (
        <div className="relative">
            {/* Left fade */}
            {canScrollLeft && (
                <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-black to-transparent z-10 pointer-events-none" />
            )}
            {/* Right fade */}
            {canScrollRight && (
                <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-black to-transparent z-10 pointer-events-none" />
            )}

            <div
                ref={scrollRef}
                className="flex items-center gap-1 md:gap-4 border-b border-zinc-800 pb-2 overflow-x-auto scrollbar-hide"
            >
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            data-active={isActive}
                            onClick={() => onChange(tab.id)}
                            className={`pb-2 px-2 md:px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 shrink-0 ${
                                isActive
                                    ? (tab.activeColor || 'text-indigo-400')
                                    : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            {tab.label}
                            {isActive && (
                                <div className={`absolute bottom-0 left-0 w-full h-0.5 ${tab.activeBar || 'bg-indigo-500'}`} />
                            )}
                        </button>
                    );
                })}

                {trailing && (
                    <div className="ml-auto shrink-0">
                        {trailing}
                    </div>
                )}
            </div>
        </div>
    );
}
