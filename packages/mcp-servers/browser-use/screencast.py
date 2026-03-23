"""
CDP Screencast — streams JPEG frames to Interfaces via Socket.io.
Python equivalent of packages/mcp-servers/browser/src/screencast.js.

Uses browser-use's native CDP stack (cdp_use.CDPClient) instead of Playwright.
Emits 'browser:frame' events that the webchat picks up automatically
(same event name as the existing Node.js browser MCP server).
"""

import os
import asyncio
import socketio

# Singleton state
_sio: socketio.AsyncClient | None = None
_active_session_id: str | None = None
_active_cdp_client = None  # cdp_use.CDPClient


async def init_screencast(browser):
    """
    Connect to Interfaces via Socket.io and start CDP screencast on the browser's current page.

    Args:
        browser: browser-use Browser instance (must be started/connected)
    """
    global _sio
    try:
        if _sio is None:
            interfaces_url = os.environ.get('INTERFACES_URL', 'http://localhost:5000')
            token = os.environ.get('DEEDEE_API_TOKEN', '')
            print(f'[browser-use] Connecting to Interfaces for streaming at {interfaces_url}...')

            _sio = socketio.AsyncClient(reconnection=True, reconnection_attempts=5)
            await _sio.connect(interfaces_url, auth={'token': token})
            print('[browser-use] Stream Socket connected.')

        await _start_session(browser)
    except Exception as e:
        print(f'[browser-use] Failed to start screencast: {e}')


async def _start_session(browser):
    """Start a CDP screencast session on the browser's current page."""
    global _active_session_id, _active_cdp_client
    try:
        print('[browser-use] Starting CDP Screencast...')

        # Get the CDP session for the current page
        cdp_session = await browser.get_or_create_cdp_session()
        _active_session_id = cdp_session.session_id
        _active_cdp_client = cdp_session.cdp_client

        # Register for screencast frame events
        _active_cdp_client._event_registry.register(
            'Page.screencastFrame',
            _on_frame,
        )

        # Start screencast via raw CDP command
        await _active_cdp_client.send_raw(
            'Page.startScreencast',
            {
                'format': 'jpeg',
                'quality': 50,
                'maxWidth': 800,
                'everyNthFrame': 1,
            },
            session_id=_active_session_id,
        )

        print('[browser-use] CDP Screencast started.')
    except Exception as e:
        print(f'[browser-use] Failed to start screencast session: {e}')


def _on_frame(params, session_id=None):
    """Handle incoming screencast frame — emit to Socket.io."""
    if _sio and _sio.connected:
        asyncio.ensure_future(_sio.emit('browser:frame', {
            'data': params.get('data', ''),
            'timestamp': params.get('metadata', {}).get('timestamp', 0),
        }))

    if _active_cdp_client and _active_session_id:
        asyncio.ensure_future(
            _active_cdp_client.send_raw(
                'Page.screencastFrameAck',
                {'sessionId': params.get('sessionId', 0)},
                session_id=_active_session_id,
            )
        )


async def switch_screencast(browser):
    """
    Switch screencast to the browser's current page (after tab switch).
    Stops the old CDP session and starts a new one.
    """
    await stop_screencast()
    await _start_session(browser)


async def stop_screencast():
    """Stop the active CDP screencast session."""
    global _active_session_id, _active_cdp_client
    if _active_cdp_client and _active_session_id:
        try:
            await _active_cdp_client.send_raw(
                'Page.stopScreencast',
                {},
                session_id=_active_session_id,
            )
        except Exception:
            pass

        try:
            _active_cdp_client._event_registry.unregister('Page.screencastFrame')
        except Exception:
            pass

    _active_session_id = None
    _active_cdp_client = None


async def disconnect():
    """Disconnect Socket.io client and stop screencast."""
    global _sio
    await stop_screencast()
    if _sio:
        try:
            await _sio.disconnect()
        except Exception:
            pass
        _sio = None
