'use client';

import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import { Send, Mic, Play, Pause, Wifi, WifiOff } from 'lucide-react';
import clsx from 'clsx';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;

export default function ChatPage() {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);

  // Initialize Socket
  useEffect(() => {
    const newSocket = io(SOCKET_URL, {
      reconnectionAttempts: 5,
    });

    newSocket.on('connect', () => {
      console.log('Socket connected:', newSocket.id);
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected');
      setIsConnected(false);
    });

    newSocket.on('agent:message', (data) => {
      // data: { content, type, timestamp }
      addMessage({
        role: 'assistant',
        content: data.content,
        type: data.type,
        timestamp: data.timestamp
      });

      // Auto-play audio if possible
      if (data.type === 'audio') {
        // Create audio element
        try {
          const audio = new Audio(data.content.startsWith('data:') ? data.content : `data:audio/wav;base64,${data.content}`);
          audio.play().catch(e => console.warn('Auto-play blocked:', e));
        } catch (e) {
          console.error('Audio decode error', e);
        }
      }
    });

    setSocket(newSocket);

    return () => newSocket.close();
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = (msg) => {
    setMessages((prev) => [...prev, msg]);
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputValue.trim() || !socket) return;

    const content = inputValue;
    setInputValue('');

    // Optimistic Update
    addMessage({
      role: 'user',
      content: content,
      type: 'text',
      timestamp: new Date().toISOString()
    });

    socket.emit('chat:message', {
      content: content,
      chatId: socket.id // Use socket ID as session
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6">
        <h1 className="text-xl font-semibold text-white">Live Chat</h1>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="flex items-center gap-2 text-xs text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-full">
              <Wifi className="h-3 w-3" /> Online
            </span>
          ) : (
            <span className="flex items-center gap-2 text-xs text-rose-500 bg-rose-500/10 px-2 py-1 rounded-full">
              <WifiOff className="h-3 w-3" /> Offline
            </span>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-zinc-500">
            <div className="text-center">
              <p className="mb-2 text-2xl font-semibold text-zinc-300">👋 Hello, I'm DeeDee.</p>
              <p>How can I help you today?</p>
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={clsx(
              'flex w-full',
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            )}
          >
            <div
              className={clsx(
                'max-w-[85%] rounded-2xl px-5 py-3 shadow-sm md:max-w-[70%]',
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-tr-none'
                  : 'bg-zinc-800 text-zinc-200 rounded-tl-none border border-zinc-700'
              )}
            >
              {msg.type === 'audio' ? (
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-indigo-500/20 rounded-full flex items-center justify-center">
                    <Play className="h-5 w-5 text-indigo-400" />
                  </div>
                  <span className="text-sm italic text-zinc-400">Audio Message</span>
                  {/* Actual player hidden/managed or we can optimize this later */}
                  <audio controls src={msg.content.startsWith('data:') ? msg.content : `data:audio/wav;base64,${msg.content}`} className="hidden" />
                </div>
              ) : (
                <div className="markdown prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              )}
              <div className={clsx("mt-1 text-[10px] opacity-50", msg.role === 'user' ? 'text-indigo-200' : 'text-zinc-500')}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 bg-zinc-950 p-4">
        <form onSubmit={handleSendMessage} className="mx-auto flex max-w-4xl gap-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-white placeholder-zinc-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
          />
          <button
            type="submit"
            disabled={!isConnected || !inputValue.trim()}
            className="flex items-center justify-center rounded-xl bg-indigo-600 px-5 text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-5 w-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
