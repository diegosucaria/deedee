#!/usr/bin/env python3
"""
MCP Server — browser-use integration for DeeDee.

Provides autonomous browser automation via browser-use's Agent class
(powered by Gemini), plus low-level browser control tools.

Uses the same FastMCP pattern as packages/plex-mcp-server/.

browser-use v0.12+ uses raw CDP (not Playwright) for browser automation.
"""

import argparse
import asyncio
import base64
import json
import os
import sys

from mcp.server.fastmcp import FastMCP  # type: ignore

# ── Sanitize env vars BEFORE browser-use imports ──────────────────────────────
# browser-use's internal FlatEnvConfig (Pydantic) reads BROWSER_USE_HEADLESS
# directly from the environment and requires a valid boolean. Docker-compose
# passes empty strings for unset vars, which Pydantic rejects.
_headless_raw = os.environ.get('BROWSER_USE_HEADLESS', '')
if _headless_raw == '' or _headless_raw.lower() not in ('true', 'false', '1', '0', 'yes', 'no'):
    os.environ['BROWSER_USE_HEADLESS'] = 'true'

# Initialize FastMCP server
mcp = FastMCP("browser-use-server")

# ── Configuration ──────────────────────────────────────────────────────────────

GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY', '')
GOOGLE_MODEL = os.environ.get('WORKER_FLASH', 'gemini-3-flash-preview')
HEADLESS = os.environ.get('BROWSER_USE_HEADLESS', 'true').lower() != 'false'
EXECUTABLE_PATH = os.environ.get('BROWSER_EXECUTABLE_PATH') or None
MAX_STEPS_CAP = int(os.environ.get('BROWSER_USE_MAX_STEPS', '50'))
TASK_TIMEOUT = 15 * 60  # 15 minutes

# ── Singleton Browser Manager ─────────────────────────────────────────────────

_browser = None
_browser_lock = asyncio.Lock()


def _browser_kwargs():
    """Common browser construction kwargs."""
    kwargs = {
        'headless': HEADLESS,
    }
    if EXECUTABLE_PATH:
        kwargs['executable_path'] = EXECUTABLE_PATH
    return kwargs


async def _get_browser():
    """Get or create the singleton browser-use Browser instance."""
    global _browser
    async with _browser_lock:
        if _browser is None:
            from browser_use import Browser  # type: ignore

            _browser = Browser(**_browser_kwargs())
            await _browser.start()

            # Start screencast if Interfaces URL is configured
            try:
                await _maybe_start_screencast(_browser)
            except Exception as e:
                print(f'[browser-use] Screencast init skipped: {e}', file=sys.stderr)

        return _browser


async def _maybe_start_screencast(browser):
    """Start CDP screencast if INTERFACES_URL is configured."""
    interfaces_url = os.environ.get('INTERFACES_URL', '')
    if not interfaces_url:
        return
    from screencast import init_screencast
    await init_screencast(browser)


async def _close_browser():
    """Close the singleton browser."""
    global _browser
    async with _browser_lock:
        if _browser is not None:
            try:
                from screencast import disconnect
                await disconnect()
            except Exception:
                pass
            try:
                await _browser.stop()
            except Exception:
                pass
            _browser = None


def _get_llm():
    """Create a Gemini LLM instance for browser-use Agent."""
    from browser_use import ChatGoogle  # type: ignore

    if not GOOGLE_API_KEY:
        raise ValueError(
            'GOOGLE_API_KEY environment variable is required. '
            'Get one at https://aistudio.google.com/app/apikey'
        )

    return ChatGoogle(model=GOOGLE_MODEL)


# ── Controller Helpers ─────────────────────────────────────────────────────────

_controller_cache = None


def _get_controller():
    """Get or create a Controller and its ActionModelUnion class."""
    global _controller_cache
    if _controller_cache is None:
        from browser_use.controller import Controller
        controller = Controller()
        action_model_cls = controller.registry.create_action_model()
        _controller_cache = (controller, action_model_cls)
    return _controller_cache


def _find_action_inner_type(action_model_cls, prefix: str):
    """Find the inner action type for a given prefix (e.g., 'Click' -> ClickElementActionIndexOnly)."""
    import typing
    root_field = action_model_cls.model_fields['root']
    for member in typing.get_args(root_field.annotation):
        if member.__name__.startswith(prefix):
            # The action model has a single field named after the action (lowercase)
            field_name = next(iter(member.model_fields))
            return member.model_fields[field_name].annotation
    raise ValueError(f'No action type found for prefix: {prefix}')


def _wrap_action(action_model_cls, prefix: str, inner_value):
    """Wrap an inner action value into the full ActionModelUnion."""
    import typing
    root_field = action_model_cls.model_fields['root']
    for member in typing.get_args(root_field.annotation):
        if member.__name__.startswith(prefix):
            field_name = next(iter(member.model_fields))
            wrapper = member(**{field_name: inner_value})
            return wrapper
    raise ValueError(f'No action wrapper found for prefix: {prefix}')


# ── Tools: Autonomous Task ────────────────────────────────────────────────────

@mcp.tool()
async def browser_use_task(task: str, url: str = '', max_steps: int = 25) -> str:
    """
    Run an autonomous browsing agent that completes a task.

    The agent navigates, clicks, types, and extracts data autonomously using AI.
    Best for complex multi-step browsing tasks like searching, form-filling,
    or research across multiple pages.

    Args:
        task: Natural language description of what to accomplish
              (e.g., "Find the cheapest flight from SFO to LAX next Friday")
        url: Optional starting URL to navigate to first
        max_steps: Maximum number of agent steps (default 25, capped at 50)
    """
    from browser_use import Agent, Browser  # type: ignore

    max_steps = min(max_steps, MAX_STEPS_CAP)
    llm = _get_llm()

    # Build full task with optional starting URL
    full_task = task
    if url:
        full_task = f'Go to {url} and then: {task}'

    # Create a dedicated browser for the autonomous task
    browser = Browser(**_browser_kwargs())
    await browser.start()

    # Start screencast on the task browser
    screencast_started = False
    try:
        interfaces_url = os.environ.get('INTERFACES_URL', '')
        if interfaces_url:
            from screencast import init_screencast
            await init_screencast(browser)
            screencast_started = True
    except Exception as e:
        print(f'[browser-use] Task screencast init skipped: {e}', file=sys.stderr)

    try:
        agent = Agent(
            task=full_task,
            llm=llm,
            browser=browser,
            use_vision=True,
        )

        history = await asyncio.wait_for(
            agent.run(max_steps=max_steps),
            timeout=TASK_TIMEOUT,
        )

        # Extract results from AgentHistoryList
        final_result = history.final_result()
        is_done = history.is_done()
        errors = [e for e in history.errors() if e]
        urls_visited = history.urls()

        # Extract token usage from browser-use's built-in tracking
        usage = {}
        if history.usage:
            usage = {
                'prompt_tokens': history.usage.total_prompt_tokens,
                'completion_tokens': history.usage.total_completion_tokens,
                'total_tokens': history.usage.total_tokens,
                'total_cost': round(history.usage.total_cost, 6),
                'model': GOOGLE_MODEL,
                'tag': 'browser_use',
            }

        result = {
            'status': 'completed' if is_done else 'incomplete',
            'result': final_result or '(no result extracted)',
            'steps_taken': len(history.action_names()),
            'urls_visited': urls_visited[-5:] if urls_visited else [],
            'errors': errors[-3:] if errors else [],
            'usage': usage,
        }

        return json.dumps(result, indent=2, default=str)

    except asyncio.TimeoutError:
        return json.dumps({
            'status': 'timeout',
            'result': f'Task timed out after {TASK_TIMEOUT // 60} minutes.',
            'steps_taken': max_steps,
        })
    except Exception as e:
        return json.dumps({
            'status': 'error',
            'result': str(e),
            'steps_taken': 0,
        })
    finally:
        if screencast_started:
            try:
                from screencast import stop_screencast
                await stop_screencast()
            except Exception:
                pass
        try:
            await browser.stop()
        except Exception:
            pass


# ── Tools: Low-Level Browser Control ──────────────────────────────────────────
# These wrap browser-use's native CDP-based API for direct comparison with
# the existing browser MCP server's tools. They share a singleton browser.

@mcp.tool()
async def browser_use_open(url: str) -> str:
    """
    Navigate to a URL in the browser-use browser.

    Args:
        url: The URL to navigate to
    """
    browser = await _get_browser()
    try:
        await browser.navigate_to(url)
        return json.dumps({
            'url': await browser.get_current_page_url(),
            'title': await browser.get_current_page_title(),
        })
    except Exception as e:
        return json.dumps({'error': str(e)})


@mcp.tool()
async def browser_use_state() -> str:
    """
    Get the current page state: URL, title, and visible interactive elements.
    Elements are identified by index numbers for use with click/type tools.
    """
    browser = await _get_browser()
    try:
        state_text = await browser.get_state_as_text()
        return json.dumps({
            'url': await browser.get_current_page_url(),
            'title': await browser.get_current_page_title(),
            'elements': state_text or '(no elements found)',
        })
    except Exception as e:
        return json.dumps({'error': str(e)})


@mcp.tool()
async def browser_use_click(index: int) -> str:
    """
    Click an interactive element by its index number (from browser_use_state).

    Args:
        index: The element index to click
    """
    browser = await _get_browser()
    try:
        controller, action_model_cls = _get_controller()

        # Build click action: ActionModelUnion(root=ClickActionModel(click=ClickElementActionIndexOnly(index=N)))
        click_inner = _find_action_inner_type(action_model_cls, 'Click')
        action = action_model_cls(root=_wrap_action(action_model_cls, 'Click', click_inner(index=index)))

        result = await controller.act(action, browser)
        return json.dumps({
            'status': 'clicked',
            'index': index,
            'result': str(result.extracted_content) if result.extracted_content else 'ok',
            'url': await browser.get_current_page_url(),
            'title': await browser.get_current_page_title(),
        })
    except Exception as e:
        return json.dumps({'error': str(e)})


@mcp.tool()
async def browser_use_type(index: int, text: str) -> str:
    """
    Type text into an input element by its index number (from browser_use_state).

    Args:
        index: The element index to type into
        text: The text to type
    """
    browser = await _get_browser()
    try:
        controller, action_model_cls = _get_controller()

        # Build input action: ActionModelUnion(root=InputActionModel(input=InputTextAction(index=N, text=..., clear=True)))
        input_inner = _find_action_inner_type(action_model_cls, 'Input')
        action = action_model_cls(root=_wrap_action(action_model_cls, 'Input', input_inner(index=index, text=text, clear=True)))

        result = await controller.act(action, browser)
        return json.dumps({
            'status': 'typed',
            'index': index,
            'text': text[:50],
            'result': str(result.extracted_content) if result.extracted_content else 'ok',
        })
    except Exception as e:
        return json.dumps({'error': str(e)})


@mcp.tool()
async def browser_use_screenshot() -> str:
    """
    Take a screenshot of the current page.
    Returns a base64-encoded PNG image.
    """
    browser = await _get_browser()
    try:
        screenshot_bytes = await browser.take_screenshot(format='png')
        b64 = base64.b64encode(screenshot_bytes).decode('utf-8')
        return json.dumps({
            'url': await browser.get_current_page_url(),
            'title': await browser.get_current_page_title(),
            'screenshot_base64': b64,
        })
    except Exception as e:
        return json.dumps({'error': str(e)})


@mcp.tool()
async def browser_use_close() -> str:
    """Close the browser-use browser instance and clean up resources."""
    await _close_browser()
    return json.dumps({'status': 'closed'})


# ── Entry Point ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run browser-use MCP Server')
    parser.add_argument(
        '--transport',
        choices=['stdio', 'sse'],
        default='stdio',
        help='Transport method (stdio or sse)',
    )
    args = parser.parse_args()

    print(f'Starting browser-use MCP Server ({args.transport}, model={GOOGLE_MODEL})...', file=sys.stderr)
    if not GOOGLE_API_KEY:
        print('WARNING: GOOGLE_API_KEY not set. browser_use_task will fail.', file=sys.stderr)

    mcp.run(transport=args.transport)
