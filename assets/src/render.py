"""Re-render the README banner, social preview, OG card and raster icons from their committed sources.

    python assets/src/render.py            # needs Python Playwright with Chromium installed

Pages load the self-hosted fonts from public/brand, so nothing is fetched from the network.
"""
import pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[2]
PAGES = [  # source, output, CSS width, CSS height, device scale
    ('assets/src/banner.html', 'assets/banner.png', 1280, 420, 2),
    ('assets/src/social.html', 'assets/social-preview.png', 1280, 640, 1),
    ('assets/src/og.html', 'public/brand/og.png', 1200, 630, 1),
]
ICONS = [  # svg, output, px, background
    ('public/brand/icon.svg', 'public/brand/favicon-32.png', 32, 'transparent'),
    ('public/brand/icon.svg', 'public/brand/apple-touch-icon.png', 180, '#F386A1'),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for src, out, w, h, scale in PAGES:
        page = browser.new_page(viewport={'width': w, 'height': h}, device_scale_factor=scale)
        page.goto((root / src).as_uri())
        page.evaluate('document.fonts.ready')
        page.wait_for_timeout(200)
        page.screenshot(path=str(root / out), clip={'x': 0, 'y': 0, 'width': w, 'height': h})
        page.close()
        print('rendered', out)
    for svg, out, px, bg in ICONS:
        page = browser.new_page(viewport={'width': px, 'height': px})
        # Open the SVG itself (an about:blank page may not load file: images); it scales to the viewport.
        page.goto((root / svg).as_uri())
        if bg != 'transparent':
            page.evaluate(f"document.documentElement.style.background='{bg}'")
        page.screenshot(path=str(root / out), omit_background=bg == 'transparent')
        page.close()
        print('rendered', out)
    browser.close()
