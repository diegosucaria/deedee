import { redirect } from 'next/navigation';

export default function JournalPage() {
    redirect('/brain?tab=journal');
}
