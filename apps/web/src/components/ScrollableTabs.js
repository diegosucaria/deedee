'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';

/**
 * Horizontally scrollable tab bar with fade edges on overflow.
 *
 * @param {Object} props
 * @param {Array<{id: string, label: string, icon?: React.ComponentType}>} props.tabs
 * @param {string} props.activeTab
 * @param {(id: string) => void} props.onChange
 * @param {'underline' | 'pill'} [props.variant='underline'] - Visual style
 * @param {React.ReactNode} [props.trailing] - Element after tabs (e.g. refresh button)
 * @param {string} [props.className] - Extra classes on the outer wrapper
 */
export default function ScrollableTabs({
    tabs,
    activeTab,
    onChange,
    variant = 'underline',
    trailing,
    className,
}) {
    const scrollRef = useRef(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);

    const checkScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 2);
        setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
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
    }, [checkScroll, tabs]);

    // Scroll active tab into view on mount / tab change
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const activeBtn = el.querySelector('[data-active="true"]');
        if (activeBtn) {
            activeBtn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
        }
    }, [activeTab]);

    const isPill = variant === 'pill';

    return (
        <div className={clsx('relative flex items-center', className)}>
            {/* Left fade */}
            <div
                className={clsx(
                    'pointer-events-none absolute left-0 top-0 bottom-0 w-8 z-10 transition-opacity duration-200',
                    'bg-gradient-to-r from-zinc-950 to-transparent',
                    canScrollLeft ? 'opacity-100' : 'opacity-0',
                )}
            />

            <div
                ref={scrollRef}
                className={clsx(
                    'flex overflow-x-auto scrollbar-hide',
                    isPill
                        ? 'gap-0 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800'
                        : 'gap-1 border-b border-zinc-800 pb-1',
                    'flex-1 min-w-0',
                )}
            >
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    const Icon = tab.icon;

                    return (
                        <button
                            key={tab.id}
                            data-active={isActive}
                            onClick={() => onChange(tab.id)}
                            className={clsx(
                                'flex items-center gap-2 whitespace-nowrap text-sm font-medium transition-all shrink-0',
                                isPill
                                    ? clsx(
                                        'px-4 py-2 rounded-md',
                                        isActive
                                            ? 'bg-zinc-800 text-white shadow-sm'
                                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50',
                                    )
                                    : clsx(
                                        'px-4 py-3 rounded-t-lg relative bottom-[-1px]',
                                        isActive
                                            ? 'text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900/50'
                                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/30',
                                    ),
                            )}
                        >
                            {Icon && <Icon className="h-4 w-4" />}
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* Right fade */}
            <div
                className={clsx(
                    'pointer-events-none absolute top-0 bottom-0 w-8 z-10 transition-opacity duration-200',
                    'bg-gradient-to-l from-zinc-950 to-transparent',
                    canScrollRight ? 'opacity-100' : 'opacity-0',
                    trailing ? 'right-10' : 'right-0',
                )}
            />

            {trailing && (
                <div className="shrink-0 ml-2">
                    {trailing}
                </div>
            )}
        </div>
    );
}
