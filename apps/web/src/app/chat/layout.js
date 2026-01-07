import { getSessions } from '@/app/actions';
import ChatSidebar from '@/components/ChatSidebar';
import { ChatSidebarProvider } from '@/components/ChatSidebarProvider';

export default async function ChatLayout({ children }) {
    const sessions = await getSessions(50); // Fetch recent 50 sessions

    return (
        <ChatSidebarProvider>
            <div className="flex h-full w-full overflow-hidden">
                <ChatSidebar sessions={sessions} />
                <div className="flex-1 h-full overflow-hidden relative">
                    {children}
                </div>
            </div>
        </ChatSidebarProvider>
    );
}
