import { redirect } from 'next/navigation';
import { fetchAPI } from '@/lib/api';

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Google returned an error (e.g. user denied consent)
    if (error) {
        const msg = encodeURIComponent(error);
        redirect(`/settings?tab=interfaces&gws_auth=error&message=${msg}`);
    }

    if (!code || !state) {
        redirect('/settings?tab=interfaces&gws_auth=error&message=Missing+code+or+state');
    }

    // Build redirect URL outside try-catch.
    // IMPORTANT: Next.js redirect() throws NEXT_REDIRECT internally,
    // so it must NEVER be called inside a try-catch block.
    let redirectUrl;

    try {
        // Decode state to extract label and email
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
        const { label, email } = decoded;

        if (!label || !email) {
            redirectUrl = '/settings?tab=interfaces&gws_auth=error&message=Invalid+state+parameter';
        } else {
            // Exchange the auth code for tokens via the API service (authenticated with Bearer token)
            await fetchAPI('/v1/settings/gws/oauth/exchange', {
                method: 'POST',
                body: JSON.stringify({
                    code,
                    label,
                    accountEmail: email,
                }),
            });

            redirectUrl = `/settings?tab=interfaces&gws_auth=success&label=${encodeURIComponent(label)}`;
        }
    } catch (err) {
        console.error('[OAuth Callback] Exchange failed:', err.message);
        const msg = encodeURIComponent(err.message || 'Token exchange failed');
        redirectUrl = `/settings?tab=interfaces&gws_auth=error&message=${msg}`;
    }

    redirect(redirectUrl);
}
