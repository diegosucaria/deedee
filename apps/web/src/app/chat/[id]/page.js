'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { io } from 'socket.io-client';
import { getSocketUrl } from '@/hooks/useSocket';
import ReactMarkdown from 'react-markdown';
import { Send, Play, Wifi, WifiOff, Mic, Image as ImageIcon, X, Loader2, StopCircle, Box, ChevronDown, Activity, DollarSign, Code2, Paperclip, FileIcon, Menu } from 'lucide-react';
import clsx from 'clsx';
import { getSession, getUserLocation, getVaults, updateSession, uploadChatFile, getAgentConfig, rewindChat, forkChat, stopChat } from '../../actions';
import { useChatSidebar } from '@/components/ChatSidebarProvider';


import { useRouter } from 'next/navigation';
import { Pencil, GitFork, Trash2, Square } from 'lucide-react'; // Added Square
import LiveBrowserWidget from '@/components/LiveBrowserWidget';
import ThinkingPanel from '@/components/ThinkingPanel';

export default function ChatSessionPage({ params }) {
    const { id: chatId } = params;
    const router = useRouter(); // For refreshing sidebar on title update
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const { setCollapsed, toggleSidebar } = useChatSidebar();
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isWaiting, setIsWaiting] = useState(false);

    // Rewind / Edit Handler
    const handleRewind = async (msg) => {
        console.log('[DEBUG] handleRewind msg:', msg);
        // if (!confirm('Edit this message? This will delete all subsequent history in this chat.')) return;

        // Stop only if currently generating
        if (isWaiting) {
            await stopChat(chatId).catch(console.error);
        }

        // 1. Set Input
        setInputValue(msg.content);

        // 2. Call API
        try {
            const res = await rewindChat(chatId, msg.id);
            if (res.success) {
                // 3. Optimistically update UI: Remove messages from this one onwards
                const msgIndex = messages.findIndex(m => m.id === msg.id);
                if (msgIndex !== -1) {
                    setMessages(prev => prev.slice(0, msgIndex));
                }
                // Focus input?
            } else {
                alert('Failed to rewind: ' + res.error);
            }
        } catch (e) {
            console.error('Rewind error:', e);
        }
    };

    // Fork Handler
    const handleFork = async (msg) => {
        console.log('[DEBUG] handleFork msg:', msg);
        // const confirmFork = confirm('Fork chat from here? This will create a NEW chat with history up to this message.');
        // if (!confirmFork) return;

        try {
            const res = await forkChat(chatId, msg.id);
            if (res.success && res.data.newSessionId) { // Data wrapper from actions.js
                // Redirect
                router.push(`/chat/${res.data.newSessionId}`);
            } else {
                alert('Failed to fork: ' + (res.error || 'Unknown error'));
            }
        } catch (e) {
            console.error('Fork error:', e);
        }
    };

    const [thinkingStatus, setThinkingStatus] = useState('');
    // Live agent reasoning stream for the in-flight turn:
    // entries: { id, kind: 'tool'|'thought', name?, args?, status?, result?, durationMs?, text? }
    const [liveActivity, setLiveActivity] = useState([]);
    // Per-turn correlation id. Generated client-side on each send and echoed
    // back by the agent in token/thought/tool_call/tool_result events. Used
    // to drop stale events from a previous turn if the user sent again before
    // chat:ack arrived.
    const turnIdRef = useRef(null);
    const [sessionTitle, setSessionTitle] = useState('');
    const [userLocation, setUserLocation] = useState(null);
    const messagesEndRef = useRef(null);

    // Vault State
    const [vaults, setVaults] = useState([]);
    const [selectedVault, setSelectedVault] = useState('none');

    // Model State
    const [selectedModel, setSelectedModel] = useState('auto');
    const [configuredModels, setConfiguredModels] = useState(['grok-beta', 'grok-2-vision-1212']); // Fallback defaults

    // Load Model Pref
    useEffect(() => {
        const saved = localStorage.getItem('deedee_model_pref');
        if (saved) setSelectedModel(saved);
    }, []);

    // One-shot prefill (e.g. from wardrobe "ask about this outfit").
    // Bound to a chatId so a stale stash can't leak into an unrelated chat.
    useEffect(() => {
        try {
            const raw = sessionStorage.getItem('deedee_chat_prefill');
            if (!raw) return;
            sessionStorage.removeItem('deedee_chat_prefill');
            const parsed = JSON.parse(raw);
            if (parsed?.chatId === chatId && typeof parsed.message === 'string') {
                setInputValue(parsed.message);
            }
        } catch (_) { /* ignore */ }
    }, [chatId]);

    // Multimodal State
    const MAX_ATTACHMENTS = 10;
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState(null);
    const [selectedImages, setSelectedImages] = useState([]); // [{ file, preview }]
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const [selectedFiles, setSelectedFiles] = useState([]); // [{ file, name, size }]
    const [isSending, setIsSending] = useState(false);
    const isSendingRef = useRef(false);
    const attachmentCount = selectedImages.length + selectedFiles.length + (audioBlob ? 1 : 0);
    const attachmentSlotsLeft = Math.max(0, MAX_ATTACHMENTS - attachmentCount);

    // Outgoing message queue. While the agent is processing a turn (inFlightRef
    // true between socket emit and chat:ack), additional user messages get
    // buffered here instead of racing with the in-flight turn server-side.
    // Each entry is the prepared socket payload plus the optimistic bubble
    // we'd push into messages once it actually dispatches.
    // outgoingQueue (state) drives the visual "queued" indicator;
    // outgoingQueueRef mirrors it for synchronous reads inside callbacks.
    const [outgoingQueue, setOutgoingQueue] = useState([]);
    const outgoingQueueRef = useRef([]);
    const inFlightRef = useRef(false);
    // socketRef shadows the `socket` state so the chat:ack listener (which
    // closure-captures `socket = null` at first effect run) can still reach
    // the live socket when it needs to dispatch a queued turn.
    const socketRef = useRef(null);

    const updateQueue = (next) => {
        outgoingQueueRef.current = next;
        setOutgoingQueue(next);
    };

    // Fetch Vaults & Config
    useEffect(() => {
        getVaults().then(setVaults).catch(console.error);
        getAgentConfig().then(config => {
            if (config && config['provider:xai']?.models) {
                setConfiguredModels(config['provider:xai'].models);
            }
        }).catch(console.error);
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

    // Stop Handler
    const handleStop = async () => {
        try {
            await stopChat(chatId);
            setIsWaiting(false); // Optimistic stop
            setThinkingStatus('Stopped.');
            setLiveActivity([]);
            turnIdRef.current = null;
        } catch (e) {
            console.error('Stop error:', e);
        }
    };

    // Refs mirroring attachment state so the paste handler can read current values
    // without re-registering the listener on every state change (which would create
    // a small drop-window between cleanup and re-add).
    const selectedImagesRef = useRef(selectedImages);
    const selectedFilesRef = useRef(selectedFiles);
    const audioBlobRef = useRef(audioBlob);
    useEffect(() => { selectedImagesRef.current = selectedImages; }, [selectedImages]);
    useEffect(() => { selectedFilesRef.current = selectedFiles; }, [selectedFiles]);
    useEffect(() => { audioBlobRef.current = audioBlob; }, [audioBlob]);

    // Paste Handler — registered once on mount; reads state via refs
    useEffect(() => {
        const handlePaste = (e) => {
            const items = e.clipboardData.items;
            const imageBlobs = [];
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    if (blob) imageBlobs.push(blob);
                }
            }
            if (imageBlobs.length === 0) return;
            e.preventDefault();
            if (isSendingRef.current) {
                console.warn('[Chat] Send in progress — pasted images dropped');
                return;
            }

            const slots = MAX_ATTACHMENTS - selectedImagesRef.current.length - selectedFilesRef.current.length - (audioBlobRef.current ? 1 : 0);
            if (slots <= 0) {
                console.warn(`[Chat] Attachment cap (${MAX_ATTACHMENTS}) reached — pasted images dropped`);
                return;
            }
            const accepted = imageBlobs.slice(0, slots);

            Promise.all(accepted.map(blob => new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve({ file: blob, preview: ev.target.result });
                reader.readAsDataURL(blob);
            }))).then(newItems => {
                setSelectedImages(curr => {
                    const remaining = MAX_ATTACHMENTS - curr.length - selectedFilesRef.current.length - (audioBlobRef.current ? 1 : 0);
                    return remaining > 0 ? [...curr, ...newItems.slice(0, remaining)] : curr;
                });
            });
        };

        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, []);

    // safe message normalizer
    const normalizeMessage = (m) => {
        try {
            const role = m.role === 'model' ? 'assistant' : m.role;
            let type = m.type || 'text';
            let content = m.content || '';

            // Handle DB raw rows where parts is a JSON string
            let parts = m.parts;
            if (typeof parts === 'string') {
                try { parts = JSON.parse(parts); } catch (e) {
                    console.warn('[Chat] Failed to parse parts JSON:', e);
                    parts = null;
                }
            }

            // Handle metadata parsing
            let metadata = m.metadata;
            if (typeof metadata === 'string') {
                try { metadata = JSON.parse(metadata); } catch (e) {
                    // console.warn('[Chat] Failed to parse metadata JSON:', e);
                    metadata = {};
                }
            }

            const hasParts = parts && Array.isArray(parts);

            // 1. Function Call(s) — preserve ALL calls in this turn, not just the first
            if (hasParts && parts.some(p => p.functionCall)) {
                const calls = parts
                    .filter(p => p.functionCall)
                    .map(p => ({ name: p.functionCall.name, args: p.functionCall.args }));
                if (calls.length > 0) {
                    type = 'function_call';
                    content = JSON.stringify({ type: 'function_call', name: calls[0].name, args: calls[0].args });
                    return { id: m.id, role, content, type, timestamp: m.timestamp, _toolCalls: calls };
                }
            }

            // 2. Function Response(s) — preserve ALL responses
            if (m.role === 'function' || (hasParts && parts.some(p => p.functionResponse))) {
                const responses = hasParts
                    ? parts
                        .filter(p => p.functionResponse)
                        .map(p => ({ name: p.functionResponse.name, result: p.functionResponse.response }))
                    : (m.functionResponse ? [{ name: m.functionResponse.name, result: m.functionResponse.response }] : []);
                if (responses.length > 0) {
                    type = 'function_response';
                    content = JSON.stringify({ type: 'function_response', name: responses[0].name, result: responses[0].result });
                    return { id: m.id, role, content, type, timestamp: m.timestamp, _toolResponses: responses };
                }
            }

            // 3. User Multimodal
            let attachments = null;
            let extraAudioMessage = null;
            if (m.role === 'user' && hasParts) {
                // Join text parts
                content = parts.filter(p => p.text).map(p => p.text).join(' ');

                const inlineParts = parts.filter(p => p.inlineData && p.inlineData.mimeType);
                const audioPart = inlineParts.find(p => p.inlineData.mimeType.startsWith('audio/'));
                const visualParts = inlineParts.filter(p => !p.inlineData.mimeType.startsWith('audio/'));

                if (visualParts.length > 0) {
                    type = 'attachments';
                    attachments = visualParts.map(p => {
                        const mime = p.inlineData.mimeType;
                        if (mime.startsWith('image/')) {
                            return { kind: 'image', preview: `data:${mime};base64,${p.inlineData.data}` };
                        }
                        return { kind: 'file', name: p.inlineData.name || 'File', mimeType: mime };
                    });
                }

                if (audioPart) {
                    if (visualParts.length === 0 && !content) {
                        // Audio-only user message — render as a single audio bubble.
                        type = 'audio';
                        content = `data:${audioPart.inlineData.mimeType};base64,${audioPart.inlineData.data}`;
                    } else {
                        // Audio mixed with text/visuals — emit a separate audio message
                        // so the optimistic two-bubble layout matches what's reloaded
                        // from the DB. No id on the spawned message so the rewind/fork
                        // hover-actions only appear on the main bubble.
                        extraAudioMessage = {
                            role,
                            content: `data:${audioPart.inlineData.mimeType};base64,${audioPart.inlineData.data}`,
                            type: 'audio',
                            timestamp: m.timestamp,
                            metadata
                        };
                    }
                }

                if (!content && m.content) content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            } else if (m.role === 'assistant' && hasParts) {
                // Check for Media (Audio/Image) in parts
                const audioPart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('audio/'));
                const imagePart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image/'));

                if (audioPart) {
                    type = 'audio';
                    content = audioPart.inlineData.data;
                } else if (imagePart) {
                    type = 'image';
                    content = imagePart.inlineData.data;
                } else {
                    // Text
                    content = parts.map(p => p.text).join('');
                }
            }

            // Final fallback for content
            if (!content && typeof m.content === 'string') content = m.content;
            if (!content) content = '';

            const main = { id: m.id, role, content, type, timestamp: m.timestamp, metadata, attachments };
            return extraAudioMessage ? [extraAudioMessage, main] : main;

        } catch (error) {
            console.error('[Chat] Message Normalization Failed:', error, m);
            return {
                role: 'system',
                content: 'Error loading message.',
                type: 'text',
                timestamp: m.timestamp
            };
        }
    };

    const loadSession = async () => {
        try {
            const data = await getSession(chatId);
            if (data) {
                setSessionTitle(data.title);
                // normalizeMessage may return a single message or an array (e.g., when
                // a user message bundles audio with images and we want two bubbles).
                const history = (data.messages || []).flatMap(m => {
                    const norm = normalizeMessage(m);
                    return Array.isArray(norm) ? norm : [norm];
                });
                setMessages(history);
            }
        } catch (err) {
            console.error('Failed to load session:', err);
        }
    };

    useEffect(() => {
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
            newSocket = io(getSocketUrl(), {
                path: '/socket.io',
                reconnectionAttempts: 10,
                transports: ['websocket'],
                query: { chatId },
                withCredentials: true,
            });

            newSocket.on('connect_error', (err) => {
                console.error('[Chat] Socket Connection Error:', err.message);
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

            // Handle Ack
            newSocket.on('chat:ack', async () => {
                if (!isMounted) return;
                console.log('[Chat] Message acknowledged. Refreshing history...');
                // Wait for the refresh to finish before draining the queue.
                // Otherwise loadSession's setMessages would race with drain's
                // optimistic bubble for the next turn and clobber it briefly.
                try { await loadSession(); } catch (e) { console.warn('[Chat] loadSession after ack failed:', e); }
                if (!isMounted) return;
                // Persisted history now carries the tool/thought activity inline.
                setLiveActivity([]);
                setThinkingStatus('');
                // Late events for this turn (post-ack) will now be filtered.
                turnIdRef.current = null;
                // The prior turn is fully done; the agent is free to take the
                // next message. If anything was queued while it was thinking,
                // drain one entry now and let the UI flow start a fresh turn.
                inFlightRef.current = false;
                drainQueue();
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

                // Extract content
                let msgContent = data.content;
                if (data.parts && (data.type === 'audio' || data.type === 'image')) {
                    const mediaPart = data.parts.find(p => p.inlineData);
                    if (mediaPart) {
                        msgContent = mediaPart.inlineData.data;
                    }
                }

                setMessages((prev) => {
                    const lastMsg = prev[prev.length - 1];
                    // If last message was a streaming assistant message, replace/finalize it
                    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'text' && !lastMsg.isFinal) {
                        return [
                            ...prev.slice(0, -1),
                            {
                                role: 'assistant',
                                content: msgContent,
                                type: data.type,
                                timestamp: data.timestamp,
                                metadata: data.metadata,
                                isFinal: true
                            }
                        ];
                    }

                    // Otherwise append as new
                    return [...prev, {
                        role: 'assistant',
                        content: msgContent,
                        type: data.type,
                        timestamp: data.timestamp,
                        metadata: data.metadata,
                        isFinal: true
                    }];
                });


                if (data.type === 'audio') {
                    try {
                        const audioSrc = msgContent.startsWith('data:') ? msgContent : `data:audio/wav;base64,${msgContent}`;
                        const audio = new Audio(audioSrc);
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

            // Live tool call (Phase 2)
            // Drop events that don't belong to the current turn (the user
            // may have sent another message before the previous turn's
            // chat:ack arrived, or we just reloaded mid-generation).
            // turnId is set fresh on each send and echoed back by the agent.
            // - data.turnId == null (legacy / agent:thinking): always accept.
            // - turnIdRef.current == null (this tab never sent — e.g. a second
            //   tab observing the same chat, or a fresh reload): accept all,
            //   so observers still see live activity.
            // - otherwise require an exact match.
            const isStaleTurn = (data) => (
                data.turnId != null
                && turnIdRef.current != null
                && data.turnId !== turnIdRef.current
            );

            newSocket.on('agent:tool_call', (data) => {
                if (!isMounted) return;
                if (data.chatId && data.chatId !== chatId) return;
                if (isStaleTurn(data)) return;
                setIsWaiting(true);
                setLiveActivity(prev => {
                    if (prev.some(e => e.id === data.callId)) return prev; // dedup
                    return [...prev, {
                        id: data.callId,
                        kind: 'tool',
                        name: data.name,
                        args: data.args,
                        status: 'pending',
                        ts: data.timestamp
                    }];
                });
            });

            // Live tool result (Phase 2)
            newSocket.on('agent:tool_result', (data) => {
                if (!isMounted) return;
                if (data.chatId && data.chatId !== chatId) return;
                if (isStaleTurn(data)) return;
                const nextStatus = data.status || (data.ok ? 'ok' : 'error');
                setLiveActivity(prev => prev.map(e => (
                    e.id === data.callId
                        ? { ...e, status: nextStatus, result: data.preview, durationMs: data.durationMs }
                        : e
                )));
            });

            // Live thought summary (Phase 3) — coalesce consecutive chunks into one entry
            newSocket.on('agent:thought', (data) => {
                if (!isMounted) return;
                if (data.chatId && data.chatId !== chatId) return;
                if (isStaleTurn(data)) return;
                setIsWaiting(true);
                setLiveActivity(prev => {
                    const last = prev[prev.length - 1];
                    if (last && last.kind === 'thought') {
                        return [
                            ...prev.slice(0, -1),
                            { ...last, text: (last.text || '') + (data.content || '') }
                        ];
                    }
                    return [...prev, {
                        id: `thought-${data.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                        kind: 'thought',
                        text: data.content || '',
                        ts: data.timestamp
                    }];
                });
            });

            // STREAMING HANDLER
            newSocket.on('agent:token', (data) => {
                if (!isMounted) return;
                if (data.chatId !== chatId) return;
                if (isStaleTurn(data)) return;

                setIsWaiting(false); // Stop waiting indicator

                setMessages((prev) => {
                    const lastMsg = prev[prev.length - 1];
                    // If last message is assistant text, append.
                    // If not, creates new assistant message.
                    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'text' && !lastMsg.isFinal) {
                        return [
                            ...prev.slice(0, -1),
                            { ...lastMsg, content: lastMsg.content + data.content }
                        ];
                    } else {
                        // Start new message
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: data.content,
                                type: 'text',
                                timestamp: data.timestamp
                            }
                        ];
                    }
                });
            });

            // ERROR HANDLER
            newSocket.on('agent:error', (data) => {
                if (!isMounted) return;
                console.error('[Chat] Agent error:', data.message);
                setIsWaiting(false);
                setThinkingStatus('');
                setLiveActivity([]);
                turnIdRef.current = null;
                // Release the in-flight latch so queued messages can drain;
                // otherwise a single failed turn would freeze the queue
                // forever. Drain the next queued turn (if any) so the user's
                // pending input still gets a chance.
                inFlightRef.current = false;
                setMessages((prev) => {
                    // Remove any in-progress streaming message
                    const cleaned = prev.filter(m => m.isFinal !== false || m.role !== 'assistant');
                    return [...cleaned, {
                        role: 'assistant',
                        content: `⚠️ **Error:** ${data.message || 'Something went wrong.'}\n\nPlease try sending your message again.`,
                        type: 'text',
                        timestamp: data.timestamp || new Date().toISOString(),
                        isFinal: true,
                        isError: true
                    }];
                });
                drainQueue();
            });

            if (isMounted) {
                setSocket(newSocket);
                socketRef.current = newSocket;
            }
        };

        initSocket();

        return () => {
            isMounted = false;
            socketRef.current = null;
            if (newSocket) {
                newSocket.disconnect();
                newSocket.close(); // Ensure explicit close
            }
        };
    }, [chatId, router]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isWaiting, outgoingQueue]);

    // Auto-resize textarea
    const textareaRef = useRef(null);
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'; // Reset to auto to allow shrinking
            const scrollHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = Math.min(scrollHeight, 150) + 'px'; // Cap at 150px
        }
    }, [inputValue]);


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
        const picked = Array.from(e.target.files || []);
        e.target.value = ''; // allow re-picking the same file later
        if (picked.length === 0) return;

        const slots = MAX_ATTACHMENTS - selectedImages.length - selectedFiles.length - (audioBlob ? 1 : 0);
        if (slots <= 0) {
            console.warn(`[Chat] Attachment cap (${MAX_ATTACHMENTS}) reached — images ignored`);
            return;
        }
        const accepted = picked.slice(0, slots);

        Promise.all(accepted.map(file => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({ file, preview: reader.result });
            reader.readAsDataURL(file);
        }))).then(newItems => {
            setSelectedImages(curr => {
                const remaining = MAX_ATTACHMENTS - curr.length - selectedFiles.length - (audioBlob ? 1 : 0);
                return remaining > 0 ? [...curr, ...newItems.slice(0, remaining)] : curr;
            });
        });
    };

    const handleFileSelect = (e) => {
        const picked = Array.from(e.target.files || []);
        e.target.value = ''; // allow re-picking the same file later
        if (picked.length === 0) return;

        const slots = MAX_ATTACHMENTS - selectedImages.length - selectedFiles.length - (audioBlob ? 1 : 0);
        if (slots <= 0) {
            console.warn(`[Chat] Attachment cap (${MAX_ATTACHMENTS}) reached — files ignored`);
            return;
        }
        const accepted = picked.slice(0, slots).map(file => ({
            file,
            name: file.name,
            size: (file.size / 1024 / 1024).toFixed(2) + ' MB'
        }));
        setSelectedFiles(curr => {
            const remaining = MAX_ATTACHMENTS - curr.length - selectedImages.length - (audioBlob ? 1 : 0);
            return remaining > 0 ? [...curr, ...accepted.slice(0, remaining)] : curr;
        });
    };

    const removeImageAt = (idx) => setSelectedImages(curr => curr.filter((_, i) => i !== idx));
    const removeFileAt = (idx) => setSelectedFiles(curr => curr.filter((_, i) => i !== idx));

    const clearAttachments = () => {
        setSelectedImages([]);
        setAudioBlob(null);
        setSelectedFiles([]);
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

    // Dispatch a fully-prepared turn: push the optimistic bubbles into the
    // visible history, mark in-flight, and emit the socket event.
    // Used both for an immediate send and for draining the outgoing queue
    // once the previous turn's chat:ack arrives. Reads the socket via
    // socketRef so it works correctly when called from the socket listener
    // closure (where the `socket` state was null at registration time).
    const dispatchTurn = ({ socketPayload, optimisticBubbles }) => {
        const activeSocket = socketRef.current;
        if (!activeSocket) return;
        for (const bubble of optimisticBubbles) addMessage(bubble);
        setIsWaiting(true);
        setLiveActivity([]);
        setThinkingStatus('');
        turnIdRef.current = socketPayload.metadata?.turnId || null;
        inFlightRef.current = true;
        activeSocket.emit('chat:message', socketPayload);
    };

    // Pop the head of the queue (if any) and dispatch it. Returns true if
    // something was dispatched. Called from the chat:ack handler.
    const drainQueue = () => {
        const queue = outgoingQueueRef.current;
        if (!queue.length || !socketRef.current) return false;
        const [head, ...rest] = queue;
        updateQueue(rest);
        dispatchTurn({
            socketPayload: head.socketPayload,
            optimisticBubbles: head.optimisticBubbles
        });
        return true;
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (isSendingRef.current) return; // synchronous guard against double-submit
        const hasAttachments = selectedImages.length > 0 || selectedFiles.length > 0 || !!audioBlob;
        if ((!inputValue.trim() && !hasAttachments) || !socket) return;

        isSendingRef.current = true;
        setIsSending(true);
        try {
            const content = inputValue;
            const files = [];
            const timestamp = new Date().toISOString();

            // 1. Audio — convert to base64 now, but defer the optimistic bubble until
            //    after all uploads succeed so a later upload failure doesn't leave
            //    a phantom audio bubble behind.
            let audioOptimistic = null;
            if (audioBlob) {
                const base64Audio = await blobToBase64(audioBlob);
                files.push({
                    mimeType: audioBlob.type || 'audio/webm',
                    data: base64Audio
                });
                audioOptimistic = {
                    role: 'user',
                    content: `data:${audioBlob.type};base64,${base64Audio}`,
                    type: 'audio',
                    timestamp
                };
            }

            // 2. Images — push one part per image, accumulate into the unified bubble
            const optimisticAttachments = [];
            for (const img of selectedImages) {
                const base64Image = img.preview.split(',')[1];
                files.push({
                    mimeType: img.file.type,
                    data: base64Image
                });
                optimisticAttachments.push({ kind: 'image', preview: img.preview });
            }

            // 3. Generic files — upload in parallel, then push parts + chips
            if (selectedFiles.length > 0) {
                try {
                    const uploadResults = await Promise.all(selectedFiles.map(async (sf) => {
                        const formData = new FormData();
                        formData.append('file', sf.file);
                        const uploadRes = await uploadChatFile(chatId, formData);
                        if (!uploadRes.success) throw new Error(uploadRes.error || `Upload failed: ${sf.name}`);

                        const base64File = await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result.split(',')[1]);
                            reader.readAsDataURL(sf.file);
                        });

                        return {
                            mimeType: sf.file.type || 'application/octet-stream',
                            data: base64File,
                            name: sf.name,
                            size: sf.size
                        };
                    }));

                    for (const r of uploadResults) {
                        files.push({ mimeType: r.mimeType, data: r.data });
                        optimisticAttachments.push({ kind: 'file', name: r.name, size: r.size, mimeType: r.mimeType });
                    }
                } catch (err) {
                    console.error('File Upload Error:', err);
                    alert(`Failed to upload file: ${err.message}`);
                    return; // keep attachments so user can retry; no optimistic bubbles pushed yet
                }
            }

            // 4. All uploads succeeded — build the optimistic bubbles + payload.
            const optimisticBubbles = [];
            if (audioOptimistic) optimisticBubbles.push(audioOptimistic);
            if (optimisticAttachments.length > 0) {
                optimisticBubbles.push({
                    role: 'user',
                    content: content,
                    type: 'attachments',
                    attachments: optimisticAttachments,
                    timestamp
                });
            } else if (content.trim()) {
                optimisticBubbles.push({
                    role: 'user',
                    content,
                    type: 'text',
                    timestamp
                });
            }

            // Always clear the composer once the message is captured — whether
            // we send it now or queue it for later, the user is done typing it.
            setInputValue('');
            clearAttachments();

            // Fresh turn id; events from prior turns will be ignored by listeners.
            const newTurnId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Auto-collapse sidebar on first message
            if (messages.length === 0) setCollapsed(true);

            const socketPayload = {
                content,
                files,
                chatId,
                metadata: {
                    location: userLocation,
                    vaultId: selectedVault !== 'none' ? selectedVault : undefined,
                    model: selectedModel !== 'auto' ? selectedModel : undefined,
                    turnId: newTurnId
                }
            };

            if (inFlightRef.current) {
                // Agent is still processing the prior turn — queue this one
                // and dispatch it from the chat:ack handler. The optimistic
                // bubbles live in the queue entry (not in `messages`) so
                // loadSession() on chat:ack doesn't drop them; they're rendered
                // as their own "queued" section in the JSX below.
                const summaryText = content.trim()
                    || (audioOptimistic ? 'Voice note' : (optimisticAttachments.length > 0 ? `${optimisticAttachments.length} attachment(s)` : ''));
                updateQueue([
                    ...outgoingQueueRef.current,
                    {
                        queueId: newTurnId,
                        socketPayload,
                        optimisticBubbles,
                        summaryText,
                        queuedAt: timestamp,
                        attachmentCount: optimisticAttachments.length + (audioOptimistic ? 1 : 0)
                    }
                ]);
            } else {
                dispatchTurn({ socketPayload, optimisticBubbles });
            }
        } finally {
            isSendingRef.current = false;
            setIsSending(false);
        }
    };

    // Cancel a queued (not-yet-sent) message.
    const removeFromQueue = (queueId) => {
        updateQueue(outgoingQueueRef.current.filter(q => q.queueId !== queueId));
    };

    // Group consecutive function_call/function_response messages into the
    // assistant text turn that follows them, so the UI can render a single
    // collapsible "thinking" panel above each assistant bubble.
    const displayItems = useMemo(() => {
        const items = [];
        let toolBuf = [];

        const flushOrphan = (anchorId) => {
            if (toolBuf.length === 0) return;
            items.push({ kind: 'orphan', id: `orphan-${anchorId || items.length}`, tools: toolBuf });
            toolBuf = [];
        };

        for (const msg of messages) {
            if (msg.role === 'tool') continue;

            if (msg.type === 'function_call' && Array.isArray(msg._toolCalls)) {
                msg._toolCalls.forEach((c, i) => {
                    toolBuf.push({
                        id: `${msg.id || msg.timestamp}-call-${i}`,
                        kind: 'tool',
                        name: c.name,
                        args: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
                        status: 'pending'
                    });
                });
                continue;
            }

            if (msg.type === 'function_response' && Array.isArray(msg._toolResponses)) {
                msg._toolResponses.forEach((r, i) => {
                    const resultStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? {});
                    const isError = !!(r.result && typeof r.result === 'object' && (r.result.error || r.result._error));
                    // Confirmation guard pauses save the literal "Action PAUSED" marker as the
                    // function response — surface that as a distinct status in history too.
                    const isPaused = !isError && typeof r.result === 'object' && r.result?.info && /^Action PAUSED/i.test(r.result.info);
                    const status = isError ? 'error' : isPaused ? 'paused' : 'ok';
                    const idx = toolBuf.findIndex(t => t.kind === 'tool' && t.name === r.name && t.status === 'pending');
                    if (idx >= 0) {
                        toolBuf[idx] = {
                            ...toolBuf[idx],
                            status,
                            result: resultStr
                        };
                    } else {
                        toolBuf.push({
                            id: `${msg.id || msg.timestamp}-resp-${i}`,
                            kind: 'tool',
                            name: r.name,
                            status,
                            result: resultStr
                        });
                    }
                });
                continue;
            }

            // Real message
            if (msg.role === 'user') {
                flushOrphan(msg.id);
                items.push({ kind: 'message', id: msg.id || `m-${items.length}`, message: msg });
            } else {
                // assistant — attach buffered tools as preceding activity
                const enriched = toolBuf.length > 0 ? { ...msg, precedingTools: toolBuf } : msg;
                toolBuf = [];
                items.push({ kind: 'message', id: msg.id || `m-${items.length}`, message: enriched });
            }
        }

        flushOrphan('trailing');
        return items;
    }, [messages]);

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6">
                <div className="flex items-center gap-3">
                    <button
                        onClick={toggleSidebar}
                        className="md:hidden text-zinc-400 hover:text-white"
                    >
                        <Menu className="h-5 w-5" />
                    </button>
                    <div className="flex flex-col">
                        <h1 className="text-xl font-semibold text-white truncate max-w-sm">{sessionTitle || 'Chat'}</h1>
                    </div>
                </div>
                <div className="flex items-center gap-4">
                    {/* Model Selector */}
                    <div className="relative group flex items-center bg-zinc-900 border border-zinc-700 rounded-lg focus-within:ring-1 focus-within:ring-indigo-500 focus-within:border-indigo-500 transition-all hover:border-zinc-600">
                        <div className="pl-2.5 flex items-center pointer-events-none">
                            <Code2 className="h-4 w-4 text-zinc-500" />
                        </div>
                        <select
                            value={selectedModel}
                            onChange={(e) => {
                                const m = e.target.value;
                                setSelectedModel(m);
                                localStorage.setItem('deedee_model_pref', m);
                            }}
                            className="appearance-none bg-transparent text-zinc-300 text-sm pl-2 pr-8 py-1.5 cursor-pointer outline-none border-none w-24 md:w-32"
                        >
                            <option value="auto">Auto (Gemini)</option>
                            {configuredModels.map(m => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
                    </div>

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

                {displayItems.map((item, idx) => {
                    if (item.kind === 'orphan') {
                        return (
                            <div key={item.id || idx} className="flex w-full justify-start">
                                <ThinkingPanel entries={item.tools} live={false} />
                            </div>
                        );
                    }
                    const msg = item.message;
                    return (
                        <div
                            key={item.id || idx}
                            className={clsx(
                                'flex w-full',
                                msg.role === 'user' ? 'justify-end' : 'justify-start'
                            )}
                        >
                            {msg.role === 'user' ? (
                                <div className="flex flex-col gap-1 items-end relative group">
                                    <div className="bg-indigo-600 text-white rounded-2xl rounded-tr-none px-5 py-3 shadow-sm max-w-[85%] md:max-w-[70%] relative break-words">
                                        {/* Actions on Hover */}
                                        {msg.id && (
                                            <div className="absolute -top-3 left-0 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800 rounded-lg shadow-lg border border-zinc-700 flex items-center p-1 gap-1 z-10">
                                                <button onClick={() => handleRewind(msg)} className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white" title="Edit (Rewind)">
                                                    <Pencil className="h-3 w-3" />
                                                </button>
                                                <button onClick={() => handleFork(msg)} className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white" title="Fork Chat">
                                                    <GitFork className="h-3 w-3" />
                                                </button>
                                            </div>
                                        )}

                                        {msg.type === 'audio' ? (
                                            <div className="flex items-center gap-3">
                                                <div className="h-10 w-10 bg-indigo-500/20 rounded-full flex items-center justify-center">
                                                    <Play className="h-5 w-5 text-indigo-400" />
                                                </div>
                                                <audio
                                                    controls
                                                    src={typeof msg.content === 'string' && msg.content.startsWith('data:') ? msg.content : `data:audio/webm;base64,${msg.content}`}
                                                    className="h-8 max-w-[220px]"
                                                />
                                            </div>
                                        ) : msg.type === 'attachments' ? (
                                            <div className="flex flex-col gap-2">
                                                {msg.attachments && msg.attachments.length > 0 && (
                                                    <div className="flex flex-wrap gap-2">
                                                        {msg.attachments.map((att, i) => att.kind === 'image' ? (
                                                            <div key={i} className="rounded-lg overflow-hidden border border-indigo-500/30">
                                                                <img
                                                                    src={att.preview}
                                                                    alt={`Attachment ${i + 1}`}
                                                                    className="h-24 w-24 object-cover bg-black/20"
                                                                />
                                                            </div>
                                                        ) : (
                                                            <div key={i} className="flex items-center gap-2 px-2 py-1.5 bg-indigo-500/15 border border-indigo-500/30 rounded-lg">
                                                                <FileIcon className="h-5 w-5 text-indigo-200 flex-shrink-0" />
                                                                <div className="flex flex-col min-w-0">
                                                                    <span className="text-xs text-indigo-100 font-medium truncate max-w-[160px]">{att.name || 'File'}</span>
                                                                    {att.size && <span className="text-[10px] text-indigo-200/70">{att.size}</span>}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {msg.content && msg.content.trim() && (
                                                    <div className="markdown prose prose-invert prose-sm max-w-none break-words">
                                                        <ReactMarkdown
                                                            components={{
                                                                a: ({ node, ...props }) => (
                                                                    <a {...props} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline" />
                                                                )
                                                            }}
                                                        >
                                                            {msg.content}
                                                        </ReactMarkdown>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (msg.type === 'image' || (typeof msg.content === 'string' && msg.content.startsWith('data:image'))) ? (
                                            <div className="rounded-lg overflow-hidden border border-indigo-500/30">
                                                <img
                                                    src={msg.content}
                                                    alt="User Upload"
                                                    className="max-h-64 sticky w-auto object-contain bg-black/20"
                                                />
                                            </div>
                                        ) : (
                                            <div className="markdown prose prose-invert prose-sm max-w-none break-words">
                                                <ReactMarkdown
                                                    components={{
                                                        a: ({ node, ...props }) => (
                                                            <a {...props} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline" />
                                                        )
                                                    }}
                                                >
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        )}

                                        <div className="mt-1 text-[10px] opacity-50 flex items-center gap-2 text-indigo-200">
                                            <span>{typeof msg.timestamp === 'string' ? new Date(msg.timestamp).toLocaleTimeString() : ''}</span>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                // Assistant Message
                                <div className="flex flex-col gap-2 items-start relative group">
                                    {msg.precedingTools && msg.precedingTools.length > 0 && (
                                        <ThinkingPanel entries={msg.precedingTools} live={false} />
                                    )}
                                    <div className="bg-zinc-800 text-zinc-200 rounded-2xl rounded-tl-none border border-zinc-700 px-5 py-3 shadow-sm max-w-[90%] md:max-w-[70%] relative break-words">
                                        {/* Actions on Hover */}
                                        {msg.id && (
                                            <div className="absolute -top-3 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800 rounded-lg shadow-lg border border-zinc-700 flex items-center p-1 gap-1 z-10">
                                                <button onClick={() => handleFork(msg)} className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white" title="Fork Chat from here">
                                                    <GitFork className="h-3 w-3" />
                                                </button>
                                            </div>
                                        )}
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
                                        ) : (
                                            <div className="markdown prose prose-invert prose-sm max-w-none break-words">
                                                <ReactMarkdown
                                                    components={{
                                                        a: ({ node, ...props }) => (
                                                            <a {...props} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline" />
                                                        )
                                                    }}
                                                >
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        )}
                                        <div className="mt-1 text-[10px] opacity-50 flex items-center gap-2 text-zinc-500">
                                            <span>{typeof msg.timestamp === 'string' ? new Date(msg.timestamp).toLocaleTimeString() : ''}</span>
                                            {msg.metadata?.model && (
                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border border-zinc-600 bg-zinc-700/50">
                                                    {msg.metadata.model}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Live Browser (Always visible, bottom of chat) */}
                <LiveBrowserWidget />

                {/* Live Thinking Panel — shows tool calls, results, and reasoning summaries
                    while the agent is working. Replaced by persisted history once chat:ack fires. */}
                {(isWaiting || liveActivity.length > 0) && (
                    <div className="flex w-full justify-start items-start gap-2">
                        <div className="flex-1 min-w-0 flex justify-start">
                            <ThinkingPanel
                                entries={liveActivity}
                                live={true}
                                statusText={thinkingStatus}
                            />
                        </div>
                        <button
                            onClick={handleStop}
                            className="p-2 bg-zinc-800 hover:bg-rose-500/20 hover:text-rose-500 text-zinc-400 rounded-full border border-zinc-700 transition-colors shrink-0"
                            title="Stop Generating"
                            type="button"
                        >
                            <Square className="h-4 w-4 fill-current" />
                        </button>
                    </div>
                )}

                {/* Queued messages — typed by the user while the agent is still
                    processing the prior turn. Each is shown as a faded user
                    bubble with a clock indicator + cancel button until chat:ack
                    fires and drainQueue() promotes the head into a real turn. */}
                {outgoingQueue.length > 0 && (
                    <div className="flex flex-col items-end gap-2 w-full">
                        {outgoingQueue.map((q) => (
                            <div
                                key={q.queueId}
                                className="flex items-center gap-2 max-w-[80%] rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300"
                                title="Queued — will send after the agent finishes the current reply"
                            >
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500 shrink-0" />
                                <span className="truncate">
                                    {q.summaryText || (q.attachmentCount > 0 ? `${q.attachmentCount} attachment(s)` : '(empty)')}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => removeFromQueue(q.queueId)}
                                    className="ml-1 p-0.5 rounded hover:bg-zinc-700/60 text-zinc-500 hover:text-zinc-200 shrink-0"
                                    title="Remove from queue"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            < div className="border-t border-zinc-800 bg-zinc-950 p-2 md:p-4" >
                <form onSubmit={handleSendMessage} className="mx-auto max-w-4xl">

                    {/* Attachments Preview */}
                    {(selectedImages.length > 0 || selectedFiles.length > 0 || audioBlob) && (
                        <div className="flex flex-wrap gap-3 mb-3 px-2 items-start">
                            {selectedImages.map((img, idx) => (
                                <div key={`img-${idx}`} className="relative group">
                                    <img src={img.preview} alt={`Selected ${idx + 1}`} className="h-20 w-20 object-cover rounded-lg border border-zinc-700" />
                                    <button onClick={() => removeImageAt(idx)} type="button" className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-zinc-600 hover:bg-zinc-700">
                                        <X className="w-3 h-3 text-white" />
                                    </button>
                                </div>
                            ))}
                            {selectedFiles.map((sf, idx) => (
                                <div key={`file-${idx}`} className="relative flex items-center p-3 bg-zinc-900 border border-zinc-700 rounded-lg gap-3">
                                    <FileIcon className="h-8 w-8 text-indigo-400" />
                                    <div className="flex flex-col">
                                        <span className="text-sm text-zinc-200 font-medium truncate max-w-[150px]">{sf.name}</span>
                                        <span className="text-xs text-zinc-500">{sf.size}</span>
                                    </div>
                                    <button onClick={() => removeFileAt(idx)} type="button" className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-zinc-600 hover:bg-zinc-700">
                                        <X className="w-3 h-3 text-white" />
                                    </button>
                                </div>
                            ))}
                            {audioBlob && (
                                <div className="relative flex items-center justify-center h-20 w-20 bg-zinc-900 border border-zinc-700 rounded-lg">
                                    <div className="text-xs text-indigo-400 font-semibold">Voice Note</div>
                                    <button onClick={() => setAudioBlob(null)} type="button" className="absolute -top-2 -right-2 bg-zinc-800 rounded-full p-1 border border-zinc-600 hover:bg-zinc-700">
                                        <X className="w-3 h-3 text-white" />
                                    </button>
                                </div>
                            )}
                            {attachmentCount > 0 && (
                                <div className="flex items-center text-[11px] text-zinc-500 self-center">
                                    {attachmentCount} / {MAX_ATTACHMENTS}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex gap-2 md:gap-3 items-end">
                        {/* Audio / Recording Controls */}
                        {isRecording ? (
                            <button
                                type="button"
                                onClick={stopRecording}
                                className="flex items-center justify-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-red-600/20 text-red-500 animate-pulse border border-red-500/50 hover:bg-red-600/30 transition-all"
                            >
                                <StopCircle className="h-6 w-6" />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={startRecording}
                                disabled={!!audioBlob} // Disable if already has audio
                                className="flex items-center justify-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-indigo-400 hover:border-indigo-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                <Mic className="h-5 w-5" />
                            </button>
                        )}

                        {/* Image Picker */}
                        <div className="relative">
                            <input
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={handleImageSelect}
                                className="hidden"
                                id="image-upload"
                                disabled={attachmentSlotsLeft === 0 || isSending}
                            />
                            <label
                                htmlFor="image-upload"
                                title={isSending ? 'Send in progress…' : attachmentSlotsLeft === 0 ? `Max ${MAX_ATTACHMENTS} attachments reached` : 'Attach images'}
                                className={clsx(
                                    "flex items-center justify-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 transition-all cursor-pointer",
                                    (attachmentSlotsLeft === 0 || isSending) ? "opacity-30 cursor-not-allowed" : "hover:text-pink-400 hover:border-pink-500/50"
                                )}
                            >
                                <ImageIcon className="h-5 w-5" />
                            </label>
                        </div>

                        {/* File Picker */}
                        <div className="relative">
                            <input
                                type="file"
                                multiple
                                onChange={handleFileSelect}
                                className="hidden"
                                id="file-upload"
                                disabled={attachmentSlotsLeft === 0 || isSending}
                            />
                            <label
                                htmlFor="file-upload"
                                title={isSending ? 'Send in progress…' : attachmentSlotsLeft === 0 ? `Max ${MAX_ATTACHMENTS} attachments reached` : 'Attach files'}
                                className={clsx(
                                    "flex items-center justify-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 transition-all cursor-pointer",
                                    (attachmentSlotsLeft === 0 || isSending) ? "opacity-30 cursor-not-allowed" : "hover:text-emerald-400 hover:border-emerald-500/50"
                                )}
                            >
                                <Paperclip className="h-5 w-5" />
                            </label>
                        </div>

                        {/* Text Input */}
                        <textarea
                            ref={textareaRef}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSendMessage(e);
                                }
                            }}
                            placeholder={isWaiting ? `Type to queue while agent is replying…` : `Message...`}
                            rows={1}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 md:px-4 md:py-3 min-h-[40px] md:min-h-[48px] max-h-[150px] text-white placeholder-zinc-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-none scrollbar-thin scrollbar-thumb-zinc-700 font-sans"
                        />

                        {/* Send Button */}
                        <button
                            type="submit"
                            disabled={!isConnected || isSending || (!inputValue.trim() && attachmentCount === 0)}
                            className="flex items-center justify-center h-10 w-10 md:h-12 md:w-12 rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                        </button>
                    </div>
                </form>
            </div>
        </div >
    );
}
