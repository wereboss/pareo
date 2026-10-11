import json
from pathlib import Path
import pytest

WORKSPACE = Path(__file__).resolve().parent.parent
STATIC_DIR = WORKSPACE / "static"
MANIFEST_PATH = STATIC_DIR / "manifest.json"
SW_PATH = STATIC_DIR / "sw.js"
ICONS_DIR = STATIC_DIR / "icons"
INDEX_HTML = STATIC_DIR / "index.html"
STYLE_CSS = STATIC_DIR / "style.css"

def test_pwa_manifest_exists_and_valid():
    assert MANIFEST_PATH.is_file()
    manifest_data = json.loads(MANIFEST_PATH.read_text())
    
    assert "name" in manifest_data
    assert "short_name" in manifest_data
    assert "start_url" in manifest_data
    assert manifest_data.get("display") == "standalone"
    assert "icons" in manifest_data
    assert len(manifest_data["icons"]) >= 2
    assert "theme_color" in manifest_data
    assert "background_color" in manifest_data

def test_service_worker_file():
    assert SW_PATH.is_file()
    sw_code = SW_PATH.read_text()
    assert "CACHE_NAME" in sw_code
    assert "addEventListener('install'" in sw_code or 'addEventListener("install"' in sw_code
    assert "addEventListener('activate'" in sw_code or 'addEventListener("activate"' in sw_code
    assert "addEventListener('fetch'" in sw_code or 'addEventListener("fetch"' in sw_code

def test_pwa_icons_exist_and_are_valid_png():
    icon_192 = ICONS_DIR / "icon-192.png"
    icon_512 = ICONS_DIR / "icon-512.png"
    apple_icon = ICONS_DIR / "apple-touch-icon.png"

    assert icon_192.is_file()
    assert icon_512.is_file()
    assert apple_icon.is_file()

    png_header = b"\x89PNG\r\n\x1a\n"
    assert icon_192.read_bytes().startswith(png_header)
    assert icon_512.read_bytes().startswith(png_header)
    assert apple_icon.read_bytes().startswith(png_header)

def test_index_html_pwa_linkage():
    html = INDEX_HTML.read_text()
    assert 'rel="manifest"' in html
    assert 'name="theme-color"' in html
    assert 'rel="apple-touch-icon"' in html
    assert 'id="batch-action-dock"' in html
    assert 'id="auth-modal"' in html

def test_style_css_safe_area_and_dock():
    css = STYLE_CSS.read_text()
    assert "safe-area-inset-bottom" in css
    assert ".batch-action-dock" in css
    assert ".task-checkbox" in css
