import LogsClient from './LogsClient';

export default function LogsPage() {
    const token = process.env.DEEDEE_API_TOKEN;
    return <LogsClient token={token} />;
}
