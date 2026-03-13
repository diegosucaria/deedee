/**
 * Shared page layout wrapper for consistent structure across all pages.
 * Provides unified padding, max-width, header pattern, and scroll behavior.
 *
 * Usage:
 *   <PageShell icon={ClipboardList} title="Tasks" subtitle="Manage scheduled jobs.">
 *     <Content />
 *   </PageShell>
 */
export default function PageShell({ icon: Icon, title, subtitle, children, className }) {
    return (
        <div className="p-4 md:p-8 lg:p-10 max-w-6xl mx-auto w-full pb-20">
            {title && (
                <header className="mb-6 md:mb-8">
                    <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
                        {Icon && <Icon className="h-7 w-7 md:h-8 md:w-8 text-indigo-400 shrink-0" />}
                        {title}
                    </h1>
                    {subtitle && <p className="text-zinc-400 mt-1">{subtitle}</p>}
                </header>
            )}
            <div className={className}>
                {children}
            </div>
        </div>
    );
}
