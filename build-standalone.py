#!/usr/bin/env python3
"""Build 'Reality Editor - Standalone.html' from 'Reality Editor.dc.html'.

Inlines React 18.3.1 UMD, ReactDOM UMD, engine.js and support.js so the
output is a single double-clickable file (camera works on file:// in
Chrome/Edge/Safari). support.js skips its React CDN fetch when
window.React/ReactDOM are already present, so the page boots offline —
only the MediaPipe hand-tracker and Google Fonts still come from the
network at runtime.

Usage: python3 build-standalone.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "Reality Editor.dc.html"
OUT = ROOT / "Reality Editor - Standalone.html"

INLINE_ORDER = [
    ROOT / "vendor" / "react.production.min.js",
    ROOT / "vendor" / "react-dom.production.min.js",
    ROOT / "engine.js",
    ROOT / "support.js",
]

SUPPORT_TAG = '<script src="./support.js"></script>'
ENGINE_TAG = '<script src="./engine.js"></script>'


def main() -> None:
    html = SRC.read_text(encoding="utf-8")
    if SUPPORT_TAG not in html:
        sys.exit(f"expected {SUPPORT_TAG!r} in {SRC.name}")

    # The bundler sets window.__resources in its reconstructed document; a
    # truthy value makes support.js boot() skip its fetch(location.href) +
    # parseDcText raw-source pass (support.js:158). That pass is fatal here:
    # it would match the first "<x-dc" occurrence, which is a string literal
    # inside the inlined support.js itself, and render mangled JS as the
    # template. The DOM-parsed template is fully supported (EVENT_MAP restores
    # onclick -> onClick etc.), matching how the original bundle boots.
    blocks = ["<script>window.__resources = window.__resources || {};</script>"]
    for path in INLINE_ORDER:
        js = path.read_text(encoding="utf-8")
        if "</script" in js.lower():
            sys.exit(f"{path.name} contains a </script> sequence; refusing to inline")
        blocks.append(f"<script>/* inlined: {path.name} */\n{js}\n</script>")

    html = html.replace(SUPPORT_TAG, "\n".join(blocks), 1)
    # engine.js is inlined above; the helmet copy would 404 on file://
    html = html.replace(ENGINE_TAG, "<!-- engine.js inlined in head -->", 1)
    # The component's standalone check searches the fetched page text for the
    # literal src="./support.js". In the source that literal exists only as the
    # real script tag (removed above) and inside this very check — which would
    # match itself and make downloadApp always report "not standalone". The
    # original bundler ships the component JSON-escaped so its copy never
    # matches; split the needle to get the same behavior here.
    sentinel = "txt.indexOf('src=\"./support.js\"')"
    if html.count(sentinel) != 1:
        sys.exit("expected exactly one downloadApp sentinel to neutralize")
    html = html.replace(sentinel, "txt.indexOf('src=\"./sup' + 'port.js\"')", 1)
    html = html.replace("<meta charset=\"utf-8\">",
                        "<meta charset=\"utf-8\">\n<title>Reality Editor</title>", 1)

    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT.name}: {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
