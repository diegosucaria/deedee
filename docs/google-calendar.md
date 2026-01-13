# Google Calendar Integration (OAuth)

Deedee uses Google OAuth 2.0 to manage your calendar events. Because Deedee runs as a personal agent, it supports a "Multi-Tenant Personal" mode where you can link multiple Google Accounts (Personal, Work, etc.) and it will merge them into a single view.

## 1. Setup in Google Cloud Console

To use this feature, you must create your own OAuth Client ID.

1.  Go to **[Google Cloud Console](https://console.cloud.google.com/)**.
2.  Create a **New Project** (or use existing).
3.  Go to **APIs & Services** > **Library**.
4.  Enable **Google Calendar API**.
5.  Go to **APIs & Services** > **OAuth consent screen**.
    -   Select **External**.
    -   App Name: "Deedee".
    -   User Support Email: Your email.
    -   Add yourself as a **Test User** (Important! This avoids verification requirements).
6.  Go to **APIs & Services** > **Credentials**.
7.  Click **Create Credentials** > **OAuth client ID**.
    -   **CRITICAL**: Select Application Type: **Desktop App**.
    -   *Do NOT* select "Web Application". Web Apps do not support the secure copy-paste flow (`urn:ietf:wg:oauth:2.0:oob`) used by this agent.
    -   Name: "Deedee Agent".
8.  Copy the **Client ID** and **Client Secret**.

## 2. Configuration

Add these to your `.env` file (or Balena Environment Variables):

```bash
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
# Optional: Only change if you know what you are doing.
# GOOGLE_REDIRECT_URI=urn:ietf:wg:oauth:2.0:oob
```

## 3. Authentication Flow

Once Deedee is running:

1.  Open your interface (Telegram/WhatsApp/Web).
2.  Send the command: `/google_auth`
3.  Deedee will reply with a secure Google Link.
4.  Click the link -> Select your Google Account -> Allow permissions.
5.  Copy the `Verification Code` shown.
6.  Reply to Deedee: `/google_auth <YOUR_CODE>`
    *(e.g., `/google_auth 4/0AeaYSH...`)*
7.  Deedee will confirm success.

### Adding Multiple Accounts
Repeat the process above for a **different** Google Account. Deedee stores tokens for all authenticated accounts.
-   `listEvents`: Merges events from **ALL** accounts.
-   `createEvent`: Currently defaults to the first connected account.

## Troubleshooting

-   **"Refresh Token Missing"**: If you re-authenticate, Deedee essentially forces a "Consent Prompt" to ensure we get a refresh token. This allows Deedee to stay connected indefinitely.
-   **"Error: invalid_grant"**: The code might have expired or been used. Generate a new URL via `/google_auth` and try again.

## 4. Features & Commands

### Managing Calendars
Deedee supports multiple calendars (e.g. Personal, Work).

-   `/list_calendars`: Lists all connected accounts with their index.
-   `/label_calendar <index|email> <label>`: Assigns a label to a calendar.
    -   Labels are useful for organization.
    -   **Priority**: When creating an event, Deedee prefers the calendar labeled `personal`. If not found, it uses the first one.
    -   *Example*: `/label_calendar 1 personal`

### Event Details
When listing events (`listEvents`), Deedee provides extra context:
-   **Merged View**: Events from all accounts are shown in a single chronological list.
-   **Labels**: Shows `[personal]` or `[work]` tags instead of long emails.
-   **Status**: Indicates your attendance status:
    -   `(Organizer)`: You created the event.
    -   `(accepted)`: You are attending.
    -   `(declined)` / `(tentative)` / `(needsAction)`.
