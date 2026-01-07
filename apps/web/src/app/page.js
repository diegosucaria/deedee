'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createSession } from './actions';
import { Loader2 } from 'lucide-react';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const initSession = async () => {
      try {
        const res = await createSession();
        if (res.success && res.session) {
          router.push(`/chat/${res.session.id}`);
        }
      } catch (e) {
        console.error('Failed to create session:', e);
      }
    };
    initSession();
  }, [router]);

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 text-white">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
        <p className="text-zinc-400">Starting new chat...</p>
      </div>
    </div>
  );
}
