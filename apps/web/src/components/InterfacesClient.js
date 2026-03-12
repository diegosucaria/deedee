'use client';

import { useState } from 'react';
import { MessageSquare, Send, Hash } from 'lucide-react';
import WhatsAppSettings from './WhatsAppSettings';
import SlackSettings from './SlackSettings';
import GWSSettings from './GWSSettings';
import ScrollableTabs from '@/components/ScrollableTabs';

export default function InterfacesClient() {
    const [activeTab, setActiveTab] = useState('whatsapp');

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-600">
                        Interfaces
                    </h1>
                    <p className="text-zinc-400 mt-2">Manage connection channels for Deedee.</p>
                </div>

                {/* Tabs */}
                <ScrollableTabs
                    tabs={[
                        { id: 'whatsapp', label: 'WhatsApp', icon: MessageSquare },
                        { id: 'telegram', label: 'Telegram', icon: Send },
                        { id: 'slack', label: 'Slack', icon: Hash },
                        { id: 'gws', label: 'Google Workspace' },
                    ]}
                    activeTab={activeTab}
                    onChange={setActiveTab}
                    variant="pill"
                    className="mb-8"
                />

                {/* Content */}
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 min-h-[400px]">
                    {activeTab === 'whatsapp' && <div className="p-6"><WhatsAppSettings /></div>}
                    {activeTab === 'telegram' && <TelegramInfo />}
                    {activeTab === 'slack' && <div className="p-6"><SlackSettings /></div>}
                    {activeTab === 'gws' && <div className="p-6"><GWSSettings /></div>}
                </div>
            </div>
        </div>
    );
}

function TelegramInfo() {
    return (
        <div className="p-6">
            <h2 className="text-xl font-semibold mb-6 flex items-center space-x-2">
                <span className="text-blue-500">●</span>
                <span>Telegram Bot</span>
            </h2>
            <div className="p-4 bg-zinc-800/50 rounded-lg text-zinc-400">
                <p>Telegram is configured via environment variables (<code>TELEGRAM_TOKEN</code>).</p>
                <p className="mt-2 text-sm">To manage access, check your <code>ALLOWED_TELEGRAM_IDS</code> setting.</p>
            </div>
        </div>
    );
}
