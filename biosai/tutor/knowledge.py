"""Grounding for the AI tutor: GUI menu paths, keyword retrieval over the BIOS
schema, and plain-text descriptions of options and their dependencies.

Everything here comes from the extracted firmware, so the tutor can only point
at options that really exist on this board.
"""
from __future__ import annotations

import json
import math
import os
import re
from collections import Counter, deque
from dataclasses import dataclass

_TOKEN = re.compile(r"[a-z0-9]+")

# User vocabulary -> words that appear in BIOS option names
SYNONYMS = {
    "overclock": "ratio multiplier turbo bclk frequency clock power limit",
    "oc": "ratio multiplier turbo bclk frequency clock",
    "undervolt": "voltage vcore offset loadline dlvr adaptive mode",
    "undervolting": "voltage vcore offset loadline dlvr adaptive mode",
    "voltage": "voltage vcore vccsa vdd vddq",
    "xmp": "extreme memory profile xmp",
    "expo": "extreme memory profile xmp",
    "ram": "memory dram ddr5 xmp timing",
    "memory": "memory dram ddr5 xmp timing",
    "timings": "timing cas trcd trp tras",
    "temperature": "temp thermal fan tjmax",
    "temps": "temp thermal fan",
    "fan": "fan smart pump",
    "power": "power limit pl1 pl2 tdp watts iccmax",
    "cstates": "c state c1e package",
    "boot": "boot fast option priority",
    "gpu": "display graphics pcie resize bar",
    "rebar": "resize bar above 4gb mmio",
    "virtualization": "vmx vt-d virtualization",
    "ecores": "efficiency e-core",
    "pcores": "performance p-core",
}

STOP = set("the a an and or of to in on for is are what how do does i my it this that with can should be at by me you your".split())


def tokens(s: str) -> list[str]:
    s = re.sub(r"x\.m\.p\.?", "xmp", s.lower())
    return [t for t in _TOKEN.findall(s) if t not in STOP]


def expand(q: str) -> list[str]:
    out = tokens(q)
    for t in list(out):
        if t in SYNONYMS:
            out += tokens(SYNONYMS[t])
    return out


@dataclass
class Board:
    schema: dict
    layout: dict
    form_paths: dict[str, list[str]]
    item_paths: dict[str, list[str]]
    qindex: dict[str, dict]  # "fs:qid" -> item
    refs: list[dict] | None = None  # boards/<board>/reference_ranges.json rules

    @property
    def name(self) -> str:
        return str(self.schema["meta"].get("board_string", "unknown board"))


def _norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def _form_refs(schema: dict, fk: str) -> list[tuple[str, str]]:
    out = []
    for iid in schema["forms"].get(fk, {}).get("items", []):
        d = schema["items"][iid]
        if d["kind"] == "ref" and d.get("target") and d["target"] != d["form"]:
            out.append((d.get("prompt") or "", d["target"]))
    return out


def compute_paths(schema: dict, layout: dict) -> tuple[dict, dict]:
    """Breadth-first walk of the GUI layout -> shortest menu path to each form,
    plus explicit paths for items placed on synthetic pages."""
    form_paths: dict[str, list[str]] = {}
    item_paths: dict[str, list[str]] = {}
    q: deque[tuple[str, list[str]]] = deque()

    def seed(fk: str, path: list[str]) -> None:
        if fk in schema["forms"] and fk not in form_paths:
            form_paths[fk] = path
            q.append((fk, path))

    def hide_deps(d: dict) -> set[int]:
        out: set[int] = set()

        def walk(e):
            if not e:
                return
            for k in ("q", "q2"):
                if k in e:
                    out.add(e[k])
            for a in e.get("args", []):
                walk(a)
        for c in d.get("conditions", []):
            if c["type"] != "grayout":
                walk(c["expr"])
        return out

    def place_only(forms: list[str], only: list[str], path: list[str]) -> None:
        for label in only:
            for fk in forms:
                ids = schema["forms"].get(fk, {}).get("items", [])
                hits = [i for i in ids if _norm(schema["items"][i].get("prompt")) == _norm(label)]
                if not hits:
                    continue
                for iid in hits:
                    d = schema["items"][iid]
                    item_paths.setdefault(iid, path)
                    if d["kind"] == "ref" and d.get("target"):
                        seed(d["target"], path + [d.get("prompt") or ""])
                    if d.get("question_id") is None:
                        continue
                    parents = {d["question_id"]}  # dependent sub-options, as in the GUI
                    for j in ids:
                        dj = schema["items"][j]
                        if hide_deps(dj) & parents:
                            item_paths.setdefault(j, path)
                            if dj.get("question_id") is not None:
                                parents.add(dj["question_id"])
                break

    for tab in layout["tabs"]:
        base = [tab["title"]]
        if tab.get("form"):
            seed(tab["form"], base)
        for e in (tab.get("entries") or []) + (tab.get("append") or []):
            if "pick" in e:
                place_only(e["pick"], e["only"], base)
            elif "inline_form" in e:
                if e.get("only"):
                    place_only([e["inline_form"]], e["only"], base)
                else:
                    seed(e["inline_form"], base)
            elif "ref" in e:
                seed(e["ref"], base + [e.get("label") or schema["forms"].get(e["ref"], {}).get("title", "")])
            elif "page" in e:
                p = base + [e["page"]]
                if e.get("only"):
                    place_only(e["forms"], e["only"], p)
                else:
                    for fk in e["forms"]:
                        seed(fk, p)
    while q:
        fk, path = q.popleft()
        for label, tgt in _form_refs(schema, fk):
            seed(tgt, path + [label])
    return form_paths, item_paths


def load_board(schema_path: str, board_dir: str) -> Board:
    with open(schema_path, encoding="utf-8") as fh:
        schema = json.load(fh)
    with open(os.path.join(board_dir, "layout.json"), encoding="utf-8") as fh:
        layout = json.load(fh)
    fp, ip = compute_paths(schema, layout)
    qidx: dict[str, dict] = {}
    for d in schema["items"].values():
        if d.get("question_id") is None:
            continue
        k = f"{d['form'].split(':')[0]}:{d['question_id']}"
        if k not in qidx or (not qidx[k].get("prompt") and d.get("prompt")):
            qidx[k] = d
    refs, sanity = [], []
    rp = os.path.join(board_dir, "reference_ranges.json")
    if os.path.exists(rp):
        with open(rp, encoding="utf-8") as fh:
            data = json.load(fh)
        for src, dst in ((data.get("rules", []), refs), (data.get("sanity", []), sanity)):
            for r in src:
                try:
                    r["_rx"] = re.compile(r["match"])
                    dst.append(r)
                except re.error:
                    pass
    b = Board(schema, layout, fp, ip, qidx, refs)
    b.sanity = sanity
    return b


def sanity_for(b: Board, d: dict) -> dict | None:
    h = d.get("range_hint") or {}
    if d.get("kind") != "numeric" or ("min" in h and "max" in h):
        return None
    p = (d.get("prompt") or "").strip()
    for r in getattr(b, "sanity", None) or []:
        if r["_rx"].search(p) and (not r.get("forms") or d["form"] in r["forms"]):
            return r
    return None


def _band(r: dict, key: str) -> str:
    lo, hi = r[key]
    f = (lambda x: f"{x:.3f}") if r["unit"] == "V" else (lambda x: str(round(x)))
    return f"{f(lo)}-{f(hi)} {r['unit']}"


def ref_for(b: Board, d: dict) -> dict | None:
    if d.get("kind") != "numeric":
        return None
    p = (d.get("prompt") or "").strip()
    for r in b.refs or []:
        if r["_rx"].search(p) and (not r.get("forms") or d["form"] in r["forms"]):
            return r
    return None


def item_path(b: Board, iid: str) -> list[str] | None:
    if iid in b.item_paths:
        return b.item_paths[iid]
    return b.form_paths.get(b.schema["items"][iid]["form"])


# ---- descriptions -------------------------------------------------------------
def _qlabel(b: Board, fs: str, q: int) -> str:
    d = b.qindex.get(f"{fs}:{q}")
    if not d:
        return f"hidden flag #{q}"
    return f'"{d["prompt"]}"' if d.get("prompt") else f"{d.get('varstore', 'var')}[+{d.get('offset')}] (hardware flag)"


def _vlabel(b: Board, fs: str, q: int, v: int) -> str:
    d = b.qindex.get(f"{fs}:{q}") or {}
    for o in d.get("options", []):
        if o["value"] == v:
            return o["label"]
    return str(v)


def describe_expr(b: Board, e: dict | None, fs: str) -> str:
    if not e:
        return "(unknown)"
    op = e["op"]
    if op == "eq":
        return f"{_qlabel(b, fs, e['q'])} = {_vlabel(b, fs, e['q'], e['v'])}"
    if op == "in":
        return f"{_qlabel(b, fs, e['q'])} in [{', '.join(_vlabel(b, fs, e['q'], v) for v in e['v'])}]"
    if op == "qref":
        return _qlabel(b, fs, e["q"])
    if op == "const":
        return str(e["v"])
    args = e.get("args", [])
    if op == "not":
        return f"NOT ({describe_expr(b, args[0], fs)})"
    if op in ("and", "or"):
        return f" {op.upper()} ".join(f"({describe_expr(b, a, fs)})" for a in args)
    return f"{op}({', '.join(describe_expr(b, a, fs) for a in args)})"


def value_label(d: dict, v) -> str:
    if v is None:
        return "?"
    if d["kind"] == "oneof":
        for o in d.get("options", []):
            if o["value"] == v:
                return o["label"]
    if d["kind"] == "checkbox":
        return "Enabled" if v else "Disabled"
    if d["kind"] == "numeric" and v == 0 and (d.get("min") or 0) == 0:
        return "Auto"
    return str(v)


def _hide_qids(d: dict) -> set[int]:
    out: set[int] = set()

    def walk(e):
        if not e:
            return
        for k in ("q", "q2"):
            if k in e:
                out.add(e[k])
        for a in e.get("args", []):
            walk(a)
    for c in d.get("conditions", []):
        if c["type"] != "grayout":
            walk(c["expr"])
    return out


def parent_of(b: Board, iid: str) -> dict | None:
    """The setting just above an item that shows/hides it ("Pcore 0 Setting" for its
    "Voltage" row), so generic firmware labels read unambiguously."""
    d = b.schema["items"][iid]
    deps = _hide_qids(d)
    if not deps:
        return None
    ids = b.schema["forms"][d["form"]]["items"]
    i = ids.index(iid)
    for j in range(i - 1, max(-1, i - 41), -1):
        p = b.schema["items"][ids[j]]
        if p.get("question_id") in deps and p["kind"] in ("oneof", "checkbox") and p.get("prompt"):
            return p
    return None


def describe_item(b: Board, iid: str, current: dict[str, str] | None = None, full: bool = False) -> str:
    d = b.schema["items"][iid]
    fs = d["form"].split(":")[0]
    path = item_path(b, iid)
    parent = parent_of(b, iid)
    label = f"{parent['prompt'].strip()} › {(d.get('prompt') or '').strip()}" if parent else (d.get("prompt") or "")
    where = " › ".join(path + [label]) if path else f"(not reachable in this board's GUI) {b.schema['forms'][d['form']]['title']} › {d.get('prompt')}"
    parts = [f"[{iid}] {where}", f"type={d['kind']}"]
    if d["kind"] == "oneof":
        opts = [o["label"] for o in d.get("options", [])]
        parts.append("choices=" + " / ".join(opts[: (40 if full else 8)]) + (" …" if len(opts) > (40 if full else 8) else ""))
    if d["kind"] == "numeric":
        h = d.get("range_hint") or {}
        unit = " in 1/100 mΩ" if h.get("unit") == "mΩ" else (f" {h['unit']}" if h.get("unit") else "")
        if "min" in h and "max" in h:
            parts.append(f"range={h['min']}..{h['max']}{unit} (from the option's help text; 0 = Auto on this board)")
        elif d.get("range_unknown"):
            parts.append(f"range=NOT DEFINED in the firmware menu data{(', unit' + unit) if unit else ''} "
                         "(the real BIOS screen accepts the same 0-65535; the CPU and voltage regulators enforce physical limits: don't state exact limits, give conservative guidance); 0 = Auto")
        else:
            parts.append(f"range={d.get('min')}..{d.get('max')}{unit} step {d.get('step')} (0 = Auto on this board)")
        sr = sanity_for(b, d)
        if sr:
            parts.append(f"SANITY CHECK (emulator estimate, not a BIOS limit; entered in {sr['unit']}): typical {_band(sr, 'typical')}, "
                         f"flagged outside {_band(sr, 'warn')}, blocked outside {_band(sr, 'hard')}. Basis: {sr['basis']} "
                         f"[source: {sr['source']['title']} {sr['source'].get('url', '')}]")
        ref = ref_for(b, d)
        if ref:
            if ref["kind"] == "enforce":
                mw = ref.get("max_when")
                head = f"DOCUMENTED LIMIT max {ref.get('max')}" + (f" ({mw['max']} when {mw['prompt']} = {mw['label']})" if mw else "")
            else:
                head = "REFERENCE (not a BIOS limit)"
            parts.append(f"{head}: {ref['note']} [source: {ref['source']['title']} {ref['source']['url']}]")
    if d.get("default") is not None:
        parts.append(f"default={value_label(d, d['default'])}")
    if current and iid in current:
        parts.append(f"CURRENT (user changed)={current[iid]}")
    if d.get("help"):
        h = d["help"].replace("\n", " ")
        parts.append(f"help=\"{h if full else h[:220]}\"")
    if full and d.get("varstore"):
        parts.append(f"stored={d['varstore']}+0x{d.get('offset', 0):X} ({d.get('size')} bytes)")
    if "reset_required" in d.get("flags", []):
        parts.append("needs reboot")
    if d.get("default_visibility") == "hidden":
        parts.append("HIDDEN on this hardware by default")
    conds = d.get("conditions", [])
    if conds and full:
        for c in conds:
            verb = "greyed when" if c["type"] == "grayout" else "hidden when"
            parts.append(f"{verb} {describe_expr(b, c['expr'], fs)}")
    return "; ".join(parts)


# ---- retrieval ----------------------------------------------------------------
class Index:
    def __init__(self, b: Board):
        self.b = b
        self.docs: list[tuple[str, Counter]] = []
        df: Counter = Counter()
        for iid, d in b.schema["items"].items():
            if not d.get("prompt") or d["kind"] in ("subtitle",):
                continue
            path = item_path(b, iid)
            if path is None and d.get("default_visibility") == "hidden":
                continue  # unreachable and hidden: not useful to users
            tf: Counter = Counter()
            for t in tokens(d["prompt"]):
                tf[t] += 3
            for t in tokens(d.get("help", ""))[:60]:
                tf[t] += 1
            for t in tokens(" ".join(path or [])):
                tf[t] += 1
            self.docs.append((iid, tf))
            df.update(tf.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + n / c) for t, c in df.items()}

    def search(self, query: str, k: int = 24) -> list[str]:
        q = expand(query)
        if not q:
            return []
        scored = []
        seen_prompts: set[tuple[str, str]] = set()
        for iid, tf in self.docs:
            s = sum(self.idf.get(t, 0) * (1 + math.log(tf[t])) for t in q if tf.get(t))
            if s <= 0:
                continue
            d = self.b.schema["items"][iid]
            if item_path(self.b, iid):
                s *= 1.6  # prefer options the user can actually reach
            if d.get("default_visibility") == "hidden":
                s *= 0.5
            scored.append((s, iid))
        scored.sort(reverse=True)
        out = []
        for _s, iid in scored:
            d = self.b.schema["items"][iid]
            key = (_norm(d.get("prompt")), " ".join(item_path(self.b, iid) or []),
                   tuple(o["label"] for o in d.get("options", [])[:3]))
            if key in seen_prompts:
                continue
            seen_prompts.add(key)
            out.append(iid)
            if len(out) >= k:
                break
        return out
