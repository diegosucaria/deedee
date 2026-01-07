'use client';

import { useState } from 'react';
import { Target, Database, Tags, Wrench } from 'lucide-react';
import { clsx } from 'clsx';
import GoalList from '@/components/GoalList';
import MemoryList from '@/components/MemoryList';
import AliasList from '@/components/AliasList';
import ToolsList from '@/components/ToolsList';
import MCPServerList from '@/components/MCPServerList';

export default function BrainTabs({ goals, facts, aliases, tools, servers }) {
    const [activeTab, setActiveTab] = useState('goals');

    const tabs = [
        { id: 'goals', label: 'Goals', icon: Target },
        { id: 'memory', label: 'Memory', icon: Database },
        { id: 'aliases', label: 'Aliases', icon: Tags },
        { id: 'tools', label: 'Tools & MCP', icon: Wrench },
    ];

    return (
        <div className="flex flex-col gap-6">
            <div className="flex gap-2 border-b border-zinc-800 pb-1">
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={clsx(
                                "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all rounded-t-lg relative bottom-[-1px]",
                                isActive
                                    ? "text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900/50"
                                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/30"
                            )}
                        >
                            <Icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

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
                        <MemoryList facts={facts} />
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
                            <h2 className="text-xl font-semibold text-white mb-1">MCP Servers</h2>
                            <p className="text-zinc-400 text-sm mb-4">External tool providers and their connection status.</p>
                            <MCPServerList servers={servers} />
                        </div>

                        <div>
                            <h2 className="text-xl font-semibold text-white mb-1">Available Tools</h2>
                            <p className="text-zinc-400 text-sm mb-4">Capabilities exposed to the Agent.</p>
                            <ToolsList tools={tools} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
