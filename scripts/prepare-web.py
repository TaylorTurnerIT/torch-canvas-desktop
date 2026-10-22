"""Derive the offline desktop page from the byte-preserved upstream snapshot."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "upstream/torch-canvas.html").read_text()
# Use native system fonts: no remote styles, fonts, scripts, or runtime server.
page = re.sub(r'<link[^>]+href="https://fonts.googleapis.com[^>]+>\n?', '', page)
page = page.replace('<title>Torch Canvas</title>', '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Torch Canvas</title>')
# Upstream is an HTML fragment. Keep its markup and script order intact.
first_markup = page.index('<div class="app">')
page = page[:first_markup] + '</head>\n<body>\n' + page[first_markup:]
page = page.replace('<script id="tc-core">', '<script src="desktop.js"></script>\n<script id="tc-core">')
page = page.replace('if (/^https?:$/.test(location.protocol) && typeof fetch', 'if (!window.__TAURI__ && /^https?:$/.test(location.protocol) && typeof fetch')
page = page.replace('async function offerFile(name, data) {', '''async function offerFile(name, data) {
  if (window.torchDesktop) {
    try { if (await window.torchDesktop.save(name, data)) toast(`Saved ${name}.`); }
    catch (e) { toast(`Couldn't save ${name}: ${e.message || e}`); }
    return;
  }''')
# Native handles are session grants, not durable browser file handles.
page = page.replace("async function rememberHandles() { try", "async function rememberHandles() { if (window.torchDesktop) return; try")
page = page.replace("idb.get('last').then", "(window.torchDesktop ? Promise.resolve(null) : idb.get('last')).then")
page = page.replace('id="exDlModel">Download model.py', 'id="exDlModel">Save model.py')
page = page.replace('id="exDlTrain">Download train.py', 'id="exDlTrain">Save train.py')
page = page.replace('</header>', '<span class="desktop-credit" title="Original Torch Canvas by Jesse Roberts · https://www.jessetnroberts.com/torch-canvas/">By Jesse Roberts · Desktop</span></header>', 1)
page = page.replace('</style>', 'body { margin: 0; }\n.desktop-credit { font: 11px var(--sans); color: var(--muted); white-space: nowrap; margin-left: 8px; }\n</style>', 1)
(ROOT / "web/index.html").write_text(page + '\n</body>\n</html>\n')
print('Prepared offline Torch Canvas with Jesse Roberts attribution.')
