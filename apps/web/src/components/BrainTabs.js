'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Target, Database, Tags, Wrench, Book, Zap } from 'lucide-react';
import GoalList from '@/components/GoalList';
import MemoryList from '@/components/MemoryList';
import AliasList from '@/components/AliasList';
import ToolsList from '@/components/ToolsList';
import MCPServerList from '@/components/MCPServerList';
import SecretsEditor from '@/components/SecretsEditor';
import JournalTab from '@/components/JournalTab';
import SkillsTab from '@/components/SkillsTab';
import ScrollableTabs from '@/components/ScrollableTabs';

export default function BrainTabs({ goals, facts, aliases, tools, servers }) {
    const router = useRouter();
    const pathname = usePathname();
    const activeTab = useSearchParams().get('tab') || 'journal';

    const handleTabChange = (tabId) => {
        router.replace(`${pathname}?tab=${tabId}`);
    };

    const tabs = [
        { id: 'journal', label: 'Journal', icon: Book },
        { id: 'memory', label: 'Memory', icon: Database },
        { id: 'goals', label: 'Goals', icon: Target },
        { id: 'aliases', label: 'Aliases', icon: Tags },
        { id: 'tools', label: 'Tools & MCP', icon: Wrench },
        { id: 'skills', label: 'Skills', icon: Zap },
        { id: 'secrets', label: 'Browser Secrets', icon: Wrench },
    ];

    return (
        <div className="flex flex-col gap-6">
            <ScrollableTabs
                tabs={tabs}
                activeTab={activeTab}
                onChange={handleTabChange}
                variant="underline"
            />

            <div className="min-h-[400px]">
                {activeTab === 'goals' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="mb-4">
                            <h2 className="text-xl font-semibold text-white">Long-term Objectives</h2>
                            <p className="text-zinc-400 text-sm">Track and manage high-level goals for the agent.</p>
                        </div>
                        <GoalList goals={goals} />
                    </div>
                )}
                {activeTab === 'memory' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="mb-4">
                            <h2 className="text-xl font-semibold text-white">Long-term Memory</h2>
                            <p className="text-zinc-400 text-sm">Key-Value store for persistent facts and context.</p>
                        </div>

                        <div className="mb-8">
                            <h3 className="text-lg font-medium text-zinc-300 mb-2">Facts</h3>
                            <MemoryList facts={facts} />
                        </div>

                    </div>
                )}
                {activeTab === 'aliases' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="mb-4">
                            <h2 className="text-xl font-semibold text-white">Entity Aliases</h2>
                            <p className="text-zinc-400 text-sm">Map natural language names to system IDs.</p>
                        </div>
                        <AliasList aliases={aliases} />
                    </div>
                )}
                {activeTab === 'tools' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="mb-8">
                            <MCPServerList servers={servers} />
                        </div>

                        <div>
                            <h2 className="text-xl font-semibold text-white mb-1">Available Tools</h2>
                            <p className="text-zinc-400 text-sm mb-4">Capabilities exposed to the Agent.</p>
                            <ToolsList tools={tools} />
                        </div>
                    </div>
                )}
                {activeTab === 'secrets' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="mb-4">
                            <h2 className="text-xl font-semibold text-white">Browser Secrets</h2>
                            <p className="text-zinc-400 text-sm">Securely manage credentials for the Agent's browser.</p>
                        </div>
                        <SecretsEditor />
                    </div>
                )}
                {activeTab === 'journal' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <JournalTab />
                    </div>
                )}
                {activeTab === 'skills' && (
                    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <SkillsTab />
                    </div>
                )}
            </div>
        </div >
    );
}
