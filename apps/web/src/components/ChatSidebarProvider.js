'use client';

import { createContext, useContext, useState, useEffect } from 'react';

const ChatSidebarContext = createContext({
    isCollapsed: false,
    toggleSidebar: () => { },
    setCollapsed: () => { }
});

export function ChatSidebarProvider({ children }) {
    // Default to open on desktop, might want to check screen size
    const [isCollapsed, setIsCollapsed] = useState(false);

    // Persist preference if needed, but for now just state
    // Maybe auto-collapse on mobile eventually

    return (
        <ChatSidebarContext.Provider value={{ isCollapsed, setCollapsed: setIsCollapsed, toggleSidebar: () => setIsCollapsed(prev => !prev) }}>
            {children}
        </ChatSidebarContext.Provider>
    );
}

export const useChatSidebar = () => useContext(ChatSidebarContext);
