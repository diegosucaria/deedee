'use client';
import { useState, useCallback } from 'react';
import { getVaultPage } from '@/app/actions';
import VaultSidebar from '@/components/VaultSidebar';
import WikiEditor from '@/components/WikiEditor';

export default function VaultDetailClient({ vault }) {
    const [activePage, setActivePage] = useState('index.md');
    const [activeContent, setActiveContent] = useState(vault.wiki);

    const handlePageSelect = useCallback(async (pageName) => {
        if (pageName === 'index.md') {
            setActivePage('index.md');
            setActiveContent(vault.wiki);
            return;
        }
        const content = await getVaultPage(vault.id, pageName);
        if (content !== null) {
            setActivePage(pageName);
            setActiveContent(content);
        }
    }, [vault.id, vault.wiki]);

    return (
        <>
            <VaultSidebar
                vault={vault}
                activePage={activePage}
                onPageSelect={handlePageSelect}
            />
            <div className="flex-1 flex flex-col bg-zinc-950 p-4">
                <WikiEditor
                    key={activePage}
                    vaultId={vault.id}
                    initialContent={activeContent}
                    pageName={activePage}
                />
            </div>
        </>
    );
}
