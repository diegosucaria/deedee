'use client';
import { useState, useEffect, useRef } from 'react';
import { Send, Loader2, X, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import io from 'socket.io-client';

export default function VaultChat({ vaultId, isOpen = true, onClose }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isConnected, setIsConnected] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const socketRef = useRef(null);
    const messagesEndRef = useRef(null);

    // Unique Chat ID for this Vault Session
    // We can persist this in localStorage if we want history to survive reload
    // For now, let's keep it ephemeral or use a consistent ID hash
    const chatId = `vault-${vaultId}-${typeof window !== 'undefined' ? window.localStorage.getItem('deviceId') || 'dev' : 'dev'}`;

    useEffect(() => {
        if (!isOpen) return;

        // Connect Socket
        // Use relative URL to support Proxies (HTTPS/Nginx)
        const socket = io(undefined, {
            transports: ['websocket', 'polling'], // Prefer websocket
            path: '/socket.io',
            query: { chatId } // optional, identifying as vault chat
        });

        socket.on('connect', () => {
            console.log('VaultChat connected:', chatId);
            setIsConnected(true);
            socket.emit('join', chatId);
        });

        socket.on('disconnect', () => {
            setIsConnected(false);
        });

        socket.on('message', (msg) => {
            if (msg.role === 'assistant') {
                setIsTyping(false);
                setMessages(prev => [...prev, msg]);
            }
        });

        socket.on('agent:typing', () => {
            setIsTyping(true);
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

        // Send to Agent with Vault Context
        socketRef.current.emit('message', {
            chatId,
            text: input,
            metadata: {
                vaultId: vaultId, // Explicit context
                context: `User is asking specifically about the context of Vault '${vaultId}'. Use RAG searchDocuments if needed.`
            }
        });
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
