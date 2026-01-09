import LogsClient from './LogsClient';

export const dynamic = 'force-dynamic';

export default function LogsPage() {
    const token = process.env.DEEDEE_API_TOKEN;
    console.log('[LogsPage] Rendering. Token available:', !!token, 'Token length:', token ? token.length : 0);
    return <LogsClient token={token} />;
}
