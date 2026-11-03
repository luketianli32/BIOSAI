"""biosai command line.

  python -m biosai extract <bios.bin> -o out/       -> bios_schema.json + menu_tree.txt
  python -m biosai tree out/bios_schema.json [--all]
  python -m biosai bundle out/bios_schema.json boards/<board>   -> app/public/data
  python -m biosai serve [--schema ... --board ...]              -> AI tutor API on :8765
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .schema.build import build_schema, iter_tree


def _fmt(d: dict) -> str:
    k = d["kind"]
    p = d.get("prompt") or ""
    if k == "subtitle":
        return f"-- {p} --" if p else ""
    if k == "ref":
        return f"> {p}"
    val = ""
    if k == "oneof":
        opts = d.get("options", [])
        dflt = next((o["label"] for o in opts if o["value"] == d.get("default")), None)
        val = f"[{dflt or '?'}]  ({' / '.join(o['label'] for o in opts[:6])}{' ...' if len(opts) > 6 else ''})"
    elif k == "numeric":
        val = f"[{d.get('default', d.get('min'))}]  range {d.get('min')}..{d.get('max')} step {d.get('step')}"
    elif k == "checkbox":
        val = f"[{'x' if d.get('default') else ' '}]"
    elif k == "text":
        val = d.get("text_two") or ""
    flag = " (grey)" if d.get("default_grayed") else ""
    flag += " (?)" if d.get("default_visibility") == "uncertain" else ""
    return f"{p}  {val}{flag}"


def write_tree(schema: dict, fh, visible_only: bool = True) -> None:
    roots = schema["roots"] + schema.get("driver_pages", [])
    for r in roots:
        f = schema["forms"][r]
        fh.write(f"\n=== {f['title'] or r} [{r}] ===\n")
        for depth, _iid, d in iter_tree(schema, r, visible_only=visible_only):
            line = _fmt(d)
            if line:
                fh.write("  " * (depth + 1) + line + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="biosai")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract", help="extract BIOS setup schema from a firmware image")
    e.add_argument("image")
    e.add_argument("-o", "--out", default="out")
    e.add_argument("-p", "--profile", help="board hardware_profile.json (runtime state)")
    t = sub.add_parser("tree", help="print menu tree from a schema")
    t.add_argument("schema")
    t.add_argument("--all", action="store_true", help="include hidden items")
    b = sub.add_parser("bundle", help="copy schema + board layout/profile into the emulator app")
    b.add_argument("schema")
    b.add_argument("board", help="boards/<board> directory (layout.json, hardware_profile.json)")
    b.add_argument("--dest", default=os.path.join("app", "public", "data"))
    sv = sub.add_parser("serve", help="run the AI tutor API (and the built emulator app)")
    sv.add_argument("--schema", default=os.path.join("out", "z890-eagle-f5", "bios_schema.json"))
    sv.add_argument("--board", default=os.path.join("boards", "gigabyte-z890-eagle-wifi7"))
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    a = ap.parse_args(argv)

    if a.cmd == "extract":
        profile = None
        if a.profile:
            with open(a.profile, encoding="utf-8") as fh:
                profile = json.load(fh)
        schema = build_schema(a.image, profile)
        os.makedirs(a.out, exist_ok=True)
        sp = os.path.join(a.out, "bios_schema.json")
        with open(sp, "w", encoding="utf-8") as fh:
            json.dump(schema, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(a.out, "menu_tree.txt"), "w", encoding="utf-8") as fh:
            write_tree(schema, fh)
        st = schema["stats"]
        print(f"forms={len(schema['forms'])} items={len(schema['items'])} roots={len(schema['roots'])} "
              f"driver_pages={len(schema['driver_pages'])} visibility={st['default_visibility']}")
        print(f"wrote {sp}")
    elif a.cmd == "tree":
        with open(a.schema, encoding="utf-8") as fh:
            schema = json.load(fh)
        sys.stdout.reconfigure(encoding="utf-8")
        write_tree(schema, sys.stdout, visible_only=not a.all)
    elif a.cmd == "bundle":
        import shutil
        os.makedirs(a.dest, exist_ok=True)
        with open(a.schema, encoding="utf-8") as fh:
            schema = json.load(fh)
        with open(os.path.join(a.dest, "bios_schema.json"), "w", encoding="utf-8") as fh:
            json.dump(schema, fh, ensure_ascii=False, separators=(",", ":"))
        for f in ("layout.json", "hardware_profile.json", "cpus.json", "reference_ranges.json"):
            shutil.copy(os.path.join(a.board, f), os.path.join(a.dest, f))
        kb = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "kb", "tuning_guide.md")
        if os.path.exists(kb):
            shutil.copy(kb, os.path.join(a.dest, "kb.md"))  # tutor knowledge for the browser
        print(f"bundled into {a.dest}")
    elif a.cmd == "serve":
        import uvicorn
        from .tutor.server import create_app
        uvicorn.run(create_app(a.schema, a.board), host=a.host, port=a.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
