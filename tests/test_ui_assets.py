import re
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
STYLE_CSS = WORKSPACE / "static" / "style.css"
INDEX_HTML = WORKSPACE / "static" / "index.html"
APP_JS = WORKSPACE / "static" / "app.js"

def test_static_files_exist():
    assert STYLE_CSS.is_file()
    assert INDEX_HTML.is_file()
    assert APP_JS.is_file()

def test_wipeout_theme_tokens():
    css = STYLE_CSS.read_text()
    
    # Check wipeout theme block exists
    assert '[data-theme="wipeout"]' in css
    
    # Extract wipeout block
    wipeout_match = re.search(r'\[data-theme="wipeout"\]\s*\{(.*?)\}', css, re.DOTALL)
    assert wipeout_match is not None
    wipeout_block = wipeout_match.group(1)
    
    required_tokens = [
        "--bg-app",
        "--bg-surface",
        "--bg-surface-elevated",
        "--bg-input",
        "--bg-terminal",
        "--text-primary",
        "--text-secondary",
        "--accent-primary",
        "--accent-secondary",
        "--accent-tertiary",
        "--border-subtle",
        "--border-strong",
        "--queue-media",
        "--queue-fs",
        "--queue-network",
        "--queue-default",
        "--status-running",
        "--status-completed",
        "--status-failed",
        "--status-pending",
        "--hud-glow"
    ]
    for token in required_tokens:
        assert f"{token}:" in wipeout_block, f"Missing token {token} in wipeout theme"

def test_fallout_pipboy_theme_tokens():
    css = STYLE_CSS.read_text()
    
    # Check fallout-pipboy theme block exists
    assert '[data-theme="fallout-pipboy"]' in css
    
    # Extract fallout-pipboy block
    fallout_match = re.search(r'\[data-theme="fallout-pipboy"\]\s*\{(.*?)\}', css, re.DOTALL)
    assert fallout_match is not None
    fallout_block = fallout_match.group(1)
    
    required_tokens = [
        "--bg-app",
        "--bg-surface",
        "--bg-surface-elevated",
        "--bg-input",
        "--bg-terminal",
        "--text-primary",
        "--text-secondary",
        "--accent-primary",
        "--accent-secondary",
        "--accent-tertiary",
        "--border-subtle",
        "--border-strong",
        "--queue-media",
        "--queue-fs",
        "--queue-network",
        "--queue-default",
        "--status-running",
        "--status-completed",
        "--status-failed",
        "--status-pending",
        "--hud-glow",
        "--crt-scanlines"
    ]
    for token in required_tokens:
        assert f"{token}:" in fallout_block, f"Missing token {token} in fallout-pipboy theme"

def test_no_important_in_theme_token_declarations():
    css = STYLE_CSS.read_text()
    wipeout_match = re.search(r'\[data-theme="wipeout"\]\s*\{(.*?)\}', css, re.DOTALL)
    fallout_match = re.search(r'\[data-theme="fallout-pipboy"\]\s*\{(.*?)\}', css, re.DOTALL)
    
    assert "!important" not in wipeout_match.group(1)
    assert "!important" not in fallout_match.group(1)

def test_bottom_navigation_bar_css_and_html():
    css = STYLE_CSS.read_text()
    html = INDEX_HTML.read_text()
    
    # CSS rules
    assert ".bottom-nav" in css
    assert ".bottom-nav-btn" in css
    
    # HTML markup
    assert '<nav class="bottom-nav"' in html
    assert 'id="bottom-btn-tasks"' in html
    assert 'id="bottom-btn-utilities"' in html
    assert 'id="bottom-btn-libraries"' in html

def test_task_card_conversion_css_and_html():
    css = STYLE_CSS.read_text()
    html = INDEX_HTML.read_text()
    
    # CSS classes
    assert ".task-card" in css
    assert ".task-card-header" in css
    assert ".task-card-footer" in css
    
    # HTML container
    assert 'class="task-card-container"' in html or 'id="task-cards-list"' in html

def test_touch_target_ergonomics_css():
    css = STYLE_CSS.read_text()
    
    # Check for 44px min-height or min-width enforcement
    assert "min-height: 44px" in css
    assert "min-width: 44px" in css

def test_non_blocking_toasts_css_and_js():
    css = STYLE_CSS.read_text()
    html = INDEX_HTML.read_text()
    js = APP_JS.read_text()
    
    # CSS & HTML
    assert ".toast-container" in css
    assert ".toast" in css
    assert 'id="toast-container"' in html
    
    # JS function
    assert "function showToast(" in js

def test_native_sse_event_source_in_app_js():
    js = APP_JS.read_text()
    
    # Connects to /api/stream/events via EventSource
    assert "new EventSource('/api/stream/events')" in js or 'new EventSource("/api/stream/events")' in js
    assert "evtSource.addEventListener('connected'" in js or 'addEventListener("connected"' in js
    assert "evtSource.addEventListener('task_update'" in js or 'addEventListener("task_update"' in js
    assert "evtSource.addEventListener('task_output'" in js or 'addEventListener("task_output"' in js
    assert "evtSource.addEventListener('task_counts'" in js or 'addEventListener("task_counts"' in js

def test_removal_of_client_polling_loops():
    js = APP_JS.read_text()
    
    # Ensure pollSpecificTask function was retired
    assert "function pollSpecificTask" not in js
    assert "pollSpecificTask(" not in js
    
    # Ensure 5000ms updateTaskTicker poll was retired
    assert "setInterval(updateTaskTicker" not in js
