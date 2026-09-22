'use client';
import { useState, useEffect, useRef } from 'react';
import { Send, Loader2, X, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { io } from 'socket.io-client';
import { getSocketUrl } from '@/hooks/useSocket';
import {
    VAULT_CHAT_SEND, VAULT_CHAT_REPLY, VAULT_CHAT_THINKING,
    VAULT_CHAT_ACK, VAULT_CHAT_ERROR,
    vaultChatId, vaultChatPayload, isStatusMessage, replyText
} from '@/lib/vault-chat';

export default function VaultChat({ vaultId, isOpen = true, onClose }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isConnected, setIsConnected] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const socketRef = useRef(null);
    const messagesEndRef = useRef(null);

    // One room per vault. The server puts the socket in this room from the
    // handshake query, so a reply sent out of band still lands here.
    const chatId = vaultChatId(vaultId);

    useEffect(() => {
        if (!isOpen) return;

        const socket = io(getSocketUrl(), {
            transports: ['websocket'],
            path: '/socket.io',
            query: { chatId },
            withCredentials: true,
        });

        socket.on('connect', () => {
            setIsConnected(true);
        });

        socket.on('disconnect', () => {
            setIsConnected(false);
        });

        socket.on(VAULT_CHAT_REPLY, (data) => {
            const content = replyText(data);
            if (isStatusMessage(content)) return;
            setIsTyping(false);
            if (!content) return;
            setMessages(prev => {
                const last = prev[prev.length - 1];
                // The same answer can arrive twice: once in the turn's reply
                // list and once through the delivery route.
                if (last && last.role === 'assistant' && last.content === content) return prev;
                return [...prev, { role: 'assistant', content, timestamp: data.timestamp }];
            });
        });

        socket.on(VAULT_CHAT_THINKING, () => setIsTyping(true));

        // The turn is done: the server acks once the agent has answered.
        socket.on(VAULT_CHAT_ACK, () => setIsTyping(false));

        socket.on(VAULT_CHAT_ERROR, (data) => {
            setIsTyping(false);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `Could not answer: ${data?.message || 'unknown error'}`,
                timestamp: data?.timestamp
            }]);
        });

        socketRef.current = socket;

        return () => {
            socket.disconnect();
        };
    }, [isOpen, chatId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    const handleSend = () => {
        if (!input.trim() || !isConnected) return;

        const userMsg = { role: 'user', content: input, timestamp: Date.now() };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setIsTyping(true); // Optimistic

        // metadata.vaultId makes the agent treat this vault as the chat's
        // active topic, so searchDocuments looks in it.
        socketRef.current.emit(VAULT_CHAT_SEND, vaultChatPayload({ vaultId, text: input }));
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // if (!isOpen) return null; // Removed for embedded usage

    return (
        <div className="flex flex-col h-full bg-zinc-900 text-zinc-200">
            {/* Header */}
            {/* If we are embedded, maybe we don't need a header with X, or we make it optional */}
            {/* <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900">
                <div className="flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-indigo-400" />
                    <h3 className="font-semibold text-zinc-100">Vault Chat</h3>
                </div>
                {onClose && (
                    <button onClick={onClose} className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                )}
            </div> */}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-zinc-950/50">
                {messages.length === 0 && (
                    <div className="text-center text-zinc-500 text-sm mt-10">
                        Ask questions about the documents in this vault.
                    </div>
                )}
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] p-3 rounded-lg text-sm ${msg.role === 'user'
                            ? 'bg-indigo-600/90 text-white'
                            : 'bg-zinc-800 text-zinc-200'
                            }`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} className="prose prose-invert prose-xs max-w-none">
                                {msg.content}
                            </ReactMarkdown>
                        </div>
                    </div>
                ))}
                {isTyping && (
                    <div className="flex justify-start">
                        <div className="bg-zinc-800 p-3 rounded-lg flex gap-1">
                            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-zinc-800 bg-zinc-900">
                <div className="relative">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask about this vault..."
                        className="w-full bg-zinc-950 border border-zinc-700 rounded-lg pl-4 pr-10 py-3 text-sm text-zinc-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-transparent outline-none resize-none h-12 min-h-[48px] max-h-32"
                        rows={1}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || !isConnected}
                        className="absolute right-2 bottom-2.5 p-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
