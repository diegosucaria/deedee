'use client';

import { useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import WhatsAppSettings from '../../components/WhatsAppSettings';

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
                <div className="flex space-x-1 bg-zinc-900/50 p-1 rounded-lg w-fit mb-8 border border-zinc-800">
                    <button
                        onClick={() => setActiveTab('whatsapp')}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'whatsapp'
                            ? 'bg-zinc-800 text-white shadow-sm'
                            : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                    >
                        <div className="flex items-center space-x-2">
                            <MessageSquare size={16} />
                            <span>WhatsApp</span>
                        </div>
                    </button>
                    <button
                        onClick={() => setActiveTab('telegram')}
                        className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'telegram'
                            ? 'bg-zinc-800 text-white shadow-sm'
                            : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                    >
                        <div className="flex items-center space-x-2">
                            <Send size={16} />
                            <span>Telegram</span>
                        </div>
                    </button>
                </div>

                {/* Content */}
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 min-h-[400px]">
                    {activeTab === 'whatsapp' && <div className="p-6"><WhatsAppSettings /></div>}
                    {activeTab === 'telegram' && <TelegramInfo />}
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
