'use client';

import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import { Send, Play, Wifi, WifiOff, Mic, Image as ImageIcon, X, Loader2, StopCircle, Box, ChevronDown, Activity, DollarSign, Wallet, Code2, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { getSession, getUserLocation, getVaults, updateSession } from '../../actions';
import { useChatSidebar } from '@/components/ChatSidebarProvider';


import { useRouter } from 'next/navigation';

export default function ChatSessionPage({ params }) {
    const { id: chatId } = params;
    const router = useRouter(); // For refreshing sidebar on title update
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const { setCollapsed } = useChatSidebar();
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isWaiting, setIsWaiting] = useState(false);
    const [thinkingStatus, setThinkingStatus] = useState('');
    const [sessionTitle, setSessionTitle] = useState('');
    const [userLocation, setUserLocation] = useState(null);
    const messagesEndRef = useRef(null);

    // Vault State
    const [vaults, setVaults] = useState([]);
    const [selectedVault, setSelectedVault] = useState('none');

    // Multimodal State
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState(null);
    const [selectedImage, setSelectedImage] = useState(null); // { file, preview }
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    // Fetch Vaults
    useEffect(() => {
        getVaults().then(setVaults).catch(console.error);
    }, []);

    // Fetch Location (Option 2: IP-based)
    useEffect(() => {
        const CACHE_KEY = 'deedee_user_location';
        const TIME_KEY = 'deedee_location_timestamp';
        const TTL = 2 * 60 * 60 * 1000; // 2 hours

        const cachedLoc = localStorage.getItem(CACHE_KEY);
        const cachedTime = localStorage.getItem(TIME_KEY);
        const now = Date.now();

        // Check if cache is valid
        if (cachedLoc && cachedTime && (now - parseInt(cachedTime) < TTL)) {
            setUserLocation(cachedLoc);
            console.log('[Chat] Using valid cached location:', cachedLoc);
            return; // Skip fetch
        }

        // If stale or missing, fetch in background
        if (cachedLoc) setUserLocation(cachedLoc); // Use stale while revalidating

        // Use Server Action to avoid CORS
        getUserLocation()
            .then(res => {
                if (res.success && res.data.city && res.data.country_name) {
                    const loc = `${res.data.city}, ${res.data.country_name}`;
                    setUserLocation(loc);
                    localStorage.setItem(CACHE_KEY, loc);
                    localStorage.setItem(TIME_KEY, now.toString());
                    console.log('[Chat] Fetched & Updated Location:', loc);
                }
            })
            .catch(err => {
                console.warn('Location fetch failed:', err);
            });
    }, []);

    // Fetch Session History
    useEffect(() => {
        const loadSession = async () => {
            const data = await getSession(chatId);
            if (data) {
                setSessionTitle(data.title);
                // Normalize history
                const history = (data.messages || []).map(m => ({
                    role: m.role === 'model' ? 'assistant' : m.role,
                    content: (() => {
                        // FUNCTION CALL (Model asking to run tool)
                        if (m.parts && m.parts.some(p => p.functionCall)) {
                            const fc = m.parts.find(p => p.functionCall)?.functionCall;
                            return JSON.stringify({
                                type: 'function_call',
                                name: fc.name,
                                args: fc.args
                            });
                        }

                        // FUNCTION RESPONSE (Result of tool)
                        if (m.role === 'function' || (m.parts && m.parts.some(p => p.functionResponse))) {
                            const fr = m.parts?.find(p => p.functionResponse)?.functionResponse || m.functionResponse; // Helper or direct?
                            // Gemini API structure: parts[{ functionResponse: { name, response } }]
                            // My DB saves it exactly like Gemini structure usually.
                            // Let's safe access:
                            const part = m.parts?.find(p => p.functionResponse);
                            if (part) {
                                return JSON.stringify({
                                    type: 'function_response',
                                    name: part.functionResponse.name,
                                    result: part.functionResponse.response
                                });
                            }
                        }

                        if (m.role === 'user') {
                            // Multimodal Check (User messages only)
                            // Fix: Safe check for parts array
                            if (m.parts && Array.isArray(m.parts)) {
                                return m.parts.map(p => p.text).join(' ');
                            }
                            // Fallback for string content
                            return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                        }
                        // For assistant messages, keep existing logic
                        return m.content || ((m.parts && Array.isArray(m.parts)) ? m.parts.map(p => p.text).join('') : '');
                    })(),
                    type: (() => {
                        if (m.parts && m.parts.some(p => p.functionCall)) return 'function_call';
                        if (m.role === 'function' || (m.parts && m.parts.some(p => p.functionResponse))) return 'function_response';
                        return m.type || 'text';
                    })(),
                    timestamp: m.timestamp
                }));
                setMessages(history);
            }
        };
        loadSession();
    }, [chatId]);

    const addMessage = (msg) => {
        setMessages((prev) => [...prev, msg]);
    };

    // Initialize Socket
    useEffect(() => {
        let newSocket;
        let isMounted = true;

        const initSocket = () => {
            newSocket = io({
                path: '/socket.io',
                reconnectionAttempts: 5,
                // Removed 'websocket' transport constraint to allow polling fallback via proxy
                query: { chatId } // Identify session
            });

            newSocket.on('connect', () => {
                if (isMounted) {
                    console.log('Socket connected:', newSocket.id);
                    setIsConnected(true);
                }
            });

            newSocket.on('disconnect', (reason) => {
                if (isMounted) {
                    console.log('Socket disconnected:', reason);
                    setIsConnected(false);
                }
            });

            // Handle Session Updates (Auto-Titling)
            newSocket.on('session:update', (data) => {
                if (!isMounted) return;

                // Parse content if it's a string (Agent sends JSON string)
                let update = data;
                if (typeof data.content === 'string') {
                    try { update = JSON.parse(data.content); } catch (e) { }
                }

                if (update.id === chatId) {
                    if (update.title) {
                        setSessionTitle(update.title);
                        router.refresh();
                    }
                }
            });


            newSocket.on('agent:message', (data) => {
                if (!isMounted) return;
                if (data.metadata?.chatId && data.metadata.chatId !== chatId) return; // Filter by chatID

                // Check for "Thinking..." messages
                if (data.content && (data.content.startsWith('Thinking...') || data.content.startsWith('Still working...'))) {
                    setIsWaiting(true);
                    return;
                }

                setIsWaiting(false);

                addMessage({
                    role: 'assistant',
                    content: data.content,
                    type: data.type,
                    timestamp: data.timestamp
                });

                if (data.type === 'audio') {
                    try {
                        const audio = new Audio(data.content.startsWith('data:') ? data.content : `data:audio/wav;base64,${data.content}`);
                        audio.play().catch(e => console.warn('Auto-play blocked:', e));
                    } catch (e) {
                        console.error('Audio decode error', e);
                    }
                }
            });

            newSocket.on('agent:thinking', (data) => {
                if (!isMounted) return;
                if (data.metadata?.chatId && data.metadata.chatId !== chatId) return;
                setIsWaiting(true);
                setThinkingStatus(data.status);
            });

            if (isMounted) setSocket(newSocket);
        };

        initSocket();

        return () => {
            isMounted = false;
            if (newSocket) {
                newSocket.disconnect();
                newSocket.close(); // Ensure explicit close
            }
        };
    }, [chatId, router]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isWaiting]);


    // --- Multimodal Handlers ---
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                setAudioBlob(blob);
                stream.getTracks().forEach(track => track.stop()); // Stop mic
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (err) {
            console.error('Mic Error:', err);
            alert('Could not access microphone.');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const cancelRecording = () => {
        stopRecording();
        setAudioBlob(null);
        audioChunksRef.current = [];
    };

    const handleImageSelect = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setSelectedImage({
                    file,
                    preview: reader.result
                });
            };
            reader.readAsDataURL(file);
        }
    };

    const clearAttachments = () => {
        setSelectedImage(null);
        setAudioBlob(null);
    };

    const blobToBase64 = (blob) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = reader.result;
                // Remove data:audio/webm;base64, prefix
                const base64Data = base64String.split(',')[1];
                resolve(base64Data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if ((!inputValue.trim() && !audioBlob && !selectedImage) || !socket) return;

        const content = inputValue;
        const files = [];

        // UI Optimistic Updates
        const optimisticMsg = {
            role: 'user',
            content: content,
            type: 'text',
            timestamp: new Date().toISOString()
        };

        // Process Audio
        if (audioBlob) {
            const base64Audio = await blobToBase64(audioBlob);
            files.push({
                mimeType: audioBlob.type || 'audio/webm',
                data: base64Audio
            });
            // Add optimistic audio msg (separate or combined? existing UI handles separate msgs better)
            // Let's attach to the main message or create a separate one? 
            // The current UI renderer handles single type. Let's start with pushing separate messages for UI if mixed, 
            // OR we just assume the main message is the type.
            // Actually, for simplicity, if we have audio, we push an audio message. 
            // If we have text, we push text.

            addMessage({
                role: 'user',
                content: `data:${audioBlob.type};base64,${base64Audio}`,
                type: 'audio',
                timestamp: new Date().toISOString()
            });
        }

        // Process Image
        if (selectedImage) {
            const base64Image = selectedImage.preview.split(',')[1]; // remove prefix
            files.push({
                mimeType: selectedImage.file.type,
                data: base64Image
            });

            addMessage({
                role: 'user',
                content: selectedImage.preview,
                type: 'image',
                timestamp: new Date().toISOString()
            });
        }

        // If text exists and we haven't just sent attachments solely...
        // Actually, if we have text, we show it. 
        if (content.trim()) {
            addMessage(optimisticMsg);
        }

        setInputValue('');
        clearAttachments();
        setIsWaiting(true);

        // Auto-collapse sidebar on first message
        if (messages.length === 0) setCollapsed(true);

        socket.emit('chat:message', {
            content: content,
            files: files,
            chatId: chatId,
            metadata: {
                location: userLocation,
                vaultId: selectedVault !== 'none' ? selectedVault : undefined
            }
        });
    };

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6">
                <div className="flex flex-col">
                    <h1 className="text-xl font-semibold text-white truncate max-w-sm">{sessionTitle || 'Chat'}</h1>
                </div>
                <div className="flex items-center gap-4">
                    {/* Vault Selector */}
                    <div className="relative group flex items-center bg-zinc-900 border border-zinc-700 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 focus-within:border-indigo-500 transition-all hover:border-zinc-600">
                        <div className="pl-2.5 flex items-center pointer-events-none">
                            {selectedVault === 'health' ? <Activity className="h-4 w-4 text-rose-400" /> :
                                selectedVault === 'finance' ? <DollarSign className="h-4 w-4 text-emerald-400" /> :
                                    selectedVault !== 'none' ? <Box className="h-4 w-4 text-indigo-400" /> :
                                        <Box className="h-4 w-4 text-zinc-500" />}
                        </div>
                        <select
                            value={selectedVault}
                            onChange={(e) => {
                                const newVault = e.target.value;
                                setSelectedVault(newVault);
                                // Persist context
                                updateSession(chatId, {
                                    metadata: {
                                        vaultId: newVault,
                                        location: userLocation // Preserve location if exists
                                    }
                                }).catch(console.error);
                            }}
                            className="appearance-none bg-transparent text-zinc-300 text-sm pl-2 pr-8 py-1.5 cursor-pointer outline-none border-none w-full"
                        >
                            <option value="none">General Context</option>
                            {vaults.map(v => (
                                <option key={v.id} value={v.id}>{v.name}</option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
                    </div>

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
                                    <audio controls src={msg.content.startsWith('data:') ? msg.content : `data:audio/wav;base64,${msg.content}`} className="hidden" />
                                </div>
                            ) : msg.type === 'image' ? (
                                <div className="rounded-lg overflow-hidden">
                                    <img
                                        src={msg.content.startsWith('data:') ? msg.content : `data:image/png;base64,${msg.content}`}
                                        alt="Generated Image"
                                        className="w-full h-auto max-h-96 object-cover"
                                    />
                                </div>
                            ) : msg.type === 'function_call' ? (
                                <div className="font-mono text-xs">
                                    <div className="flex items-center gap-2 text-indigo-300 mb-1">
                                        <Code2 className="h-3 w-3" />
                                        <span>Using Tool: {JSON.parse(msg.content).name}</span>
                                    </div>
                                    <div className="bg-black/20 rounded p-2 overflow-x-auto text-zinc-400">
                                        {JSON.stringify(JSON.parse(msg.content).args)}
                                    </div>
                                </div>
                            ) : msg.type === 'function_response' ? (
                                <div className="font-mono text-xs">
                                    <div className="flex items-center gap-2 text-emerald-400 mb-1">
                                        <CheckCircle2 className="h-3 w-3" />
                                        <span>Tool Result: {JSON.parse(msg.content).name}</span>
                                    </div>
                                    <details className="cursor-pointer group">
                                        <summary className="text-zinc-500 hover:text-zinc-300 transition-colors list-none">
                                            <span className="group-open:hidden">View Output</span>
                                            <span className="hidden group-open:inline">Hide Output</span>
                                        </summary>
                                        <div className="mt-2 bg-black/20 rounded p-2 overflow-x-auto text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                                            {JSON.stringify(JSON.parse(msg.content).result, null, 2)}
                                        </div>
                                    </details>
                                </div>
                            ) : (
                                <div className="markdown prose prose-invert prose-sm max-w-none">
                                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                                </div>
                            )}
                            <div className={clsx("mt-1 text-[10px] opacity-50", msg.role === 'user' ? 'text-indigo-200' : 'text-zinc-500')}>
                                {typeof msg.timestamp === 'string' ? new Date(msg.timestamp).toLocaleTimeString() : ''}
                            </div>
                        </div>
                    </div>
                ))}

                {/* Typing Indicator */}
                {isWaiting && (
                    <div className="flex w-full justify-start">
                        <div className="max-w-[85%] rounded-2xl px-5 py-4 shadow-sm md:max-w-[70%] bg-zinc-800 rounded-tl-none border border-zinc-700">
                            <div className="flex space-x-2 items-center h-4">
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce"></div>
                                {thinkingStatus && (
                                    <span className="ml-3 text-xs text-zinc-400 font-mono animate-pulse">{thinkingStatus}</span>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-zinc-800 bg-zinc-950 p-4">
                <form onSubmit={handleSendMessage} className="mx-auto max-w-4xl">

                    {/* Attachments Preview */}
                    {(selectedImage || audioBlob) && (
                        <div className="flex gap-4 mb-3 px-2">
                            {selectedImage && (
                                <div className="relative group">
                                    <img src={selectedImage.preview} alt="Selected" className="h-20 w-20 object-cover rounded-lg border border-zinc-700" />
                                    <button onClick={() => setSelectedImage(null)} type="button" className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-zinc-600 hover:bg-zinc-700">
                                        <X className="w-3 h-3 text-white" />
                                    </button>
                                </div>
                            )}
                            {audioBlob && (
                                <div className="relative flex items-center justify-center h-20 w-20 bg-zinc-900 border border-zinc-700 rounded-lg">
                                    <div className="text-xs text-indigo-400 font-semibold">Voice Note</div>
                                    <button onClick={() => setAudioBlob(null)} type="button" className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-zinc-600 hover:bg-zinc-700">
                                        <X className="w-3 h-3 text-white" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex gap-3 items-end">
                        {/* Audio / Recording Controls */}
                        {isRecording ? (
                            <button
                                type="button"
                                onClick={stopRecording}
                                className="flex items-center justify-center h-12 w-12 rounded-xl bg-red-600/20 text-red-500 animate-pulse border border-red-500/50 hover:bg-red-600/30 transition-all"
                            >
                                <StopCircle className="h-6 w-6" />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={startRecording}
                                disabled={!!audioBlob} // Disable if already has audio
                                className="flex items-center justify-center h-12 w-12 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-indigo-400 hover:border-indigo-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                <Mic className="h-5 w-5" />
                            </button>
                        )}

                        {/* Image Picker */}
                        <div className="relative">
                            <input
                                type="file"
                                accept="image/*"
                                onChange={handleImageSelect}
                                className="hidden"
                                id="image-upload"
                                disabled={!!selectedImage}
                            />
                            <label
                                htmlFor="image-upload"
                                className={clsx(
                                    "flex items-center justify-center h-12 w-12 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 transition-all cursor-pointer",
                                    selectedImage ? "opacity-30 cursor-not-allowed" : "hover:text-pink-400 hover:border-pink-500/50"
                                )}
                            >
                                <ImageIcon className="h-5 w-5" />
                            </label>
                        </div>

                        {/* Text Input */}
                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSendMessage(e);
                                }
                            }}
                            placeholder={`Message...`}
                            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 h-12 text-white placeholder-zinc-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                        />

                        {/* Send Button */}
                        <button
                            type="submit"
                            disabled={!isConnected || (!inputValue.trim() && !audioBlob && !selectedImage)}
                            className="flex items-center justify-center h-12 w-12 rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Send className="h-5 w-5" />
                        </button>
                    </div>
                </form>
            </div>
        </div >
    );
}
