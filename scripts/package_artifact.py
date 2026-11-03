"""Turn the Vite build (app/dist) into a claude.ai Artifact page.

The Artifact platform wraps the published page in its own <!doctype>/<head>/<body>,
so the page file holds only its content: title, stylesheets, the root element and
the module script. The JS/CSS bundles and data files are published alongside it
(the Artifact `files` map), at the same relative paths the app already uses.

  uv run python scripts/package_artifact.py      -> out/artifact/index.html + files.json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "app" / "dist"
OUT = ROOT / "out" / "artifact"


def main() -> None:
    html = (DIST / "index.html").read_text(encoding="utf-8")
    title = re.search(r"<title>(.*?)</title>", html).group(1)
    scripts = re.findall(r'<script type="module"[^>]*src="([^"]+)"', html)
    styles = re.findall(r'<link rel="stylesheet"[^>]*href="(\./assets/[^"]+)"', html)
    fonts = re.findall(r'<link href="(https://fonts\.googleapis\.com/[^"]+)" rel="stylesheet"', html)

    page = [f"<title>{title}</title>"]
    page += [f'<link rel="stylesheet" href="{f}">' for f in fonts]
    page += [f'<link rel="stylesheet" href="{s}">' for s in styles]
    page += ['<div id="root"></div>']
    page += [f'<script type="module" src="{s}"></script>' for s in scripts]

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.html").write_text("\n".join(page) + "\n", encoding="utf-8")

    files = {}
    for p in sorted((DIST / "assets").iterdir()) + sorted((DIST / "data").iterdir()):
        files[p.relative_to(DIST).as_posix()] = p.relative_to(ROOT).as_posix()
    (OUT / "files.json").write_text(json.dumps(files, indent=1), encoding="utf-8")
    total = sum((ROOT / v).stat().st_size for v in files.values())
    print(f"page: {OUT / 'index.html'}\nfiles ({total / 1e6:.1f} MB):")
    for k, v in files.items():
        print(f"  {k} <- {v}")


if __name__ == "__main__":
    main()
