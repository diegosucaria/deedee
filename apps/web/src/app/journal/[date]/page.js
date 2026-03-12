import { redirect } from 'next/navigation';

export default function JournalDetailPage({ params }) {
    redirect('/brain?tab=journal');
}
