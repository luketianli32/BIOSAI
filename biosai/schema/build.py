"""Normalize decoded IFR into the BIOS schema consumed by the emulator, the
knowledge base and the AI tutor.

Schema (bios_schema.json):
  meta        board / bios version / source hash
  formsets    {guid: {title, help, root_form}}
  varstores   {"<formset>:<id>": {...}}
  forms       {form_key: {title, formset, items: [item_id, ...]}}
  items       {item_id: {kind, prompt, help, question_id, ..., conditions}}
  roots       [form_key, ...]  top-level menu forms (tabs)

Form keys are "<formset_index>:<form_id>" so forms from different drivers never
collide. Item ids are "<form_key>/<index>".
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import re
from typing import Any, Iterable

from ..firmware.fv import FirmwareImage, load_image
from ..firmware.hii import find_hii
from ..firmware.ifr import FormSet, decode_ifr

UNKNOWN = object()


# ---- expression evaluation ----------------------------------------------------
def evaluate(expr: dict | None, values: dict[int, Any], this: Any = None) -> Any:
    """Evaluate a condition tree. Returns True/False/int or UNKNOWN."""
    if expr is None:
        return UNKNOWN
    op = expr["op"]

    def q(qid: int) -> Any:
        return values.get(qid, UNKNOWN)

    if op == "const":
        return expr["v"]
    if op == "eq":
        v = q(expr["q"])
        return UNKNOWN if v is UNKNOWN else v == expr["v"]
    if op == "in":
        v = q(expr["q"])
        return UNKNOWN if v is UNKNOWN else v in expr["v"]
    if op == "eq_qq":
        a, b = q(expr["q"]), q(expr["q2"])
        return UNKNOWN if UNKNOWN in (a, b) else a == b
    if op == "qref":
        return q(expr["q"])
    if op == "this":
        return UNKNOWN if this is None else this
    args = [evaluate(a, values, this) for a in expr.get("args", [])]
    if op == "not":
        a = args[0]
        return UNKNOWN if a is UNKNOWN else not a
    if op == "and":  # short-circuit with unknowns
        if any(a is not UNKNOWN and not a for a in args):
            return False
        return UNKNOWN if UNKNOWN in args else True
    if op == "or":
        if any(a is not UNKNOWN and a for a in args):
            return True
        return UNKNOWN if UNKNOWN in args else False
    if any(a is UNKNOWN for a in args) or not args:
        return UNKNOWN
    a = args[0]
    b = args[1] if len(args) > 1 else None
    try:
        return {
            "equal": lambda: a == b, "not_equal": lambda: a != b,
            "greater_than": lambda: a > b, "greater_equal": lambda: a >= b,
            "less_than": lambda: a < b, "less_equal": lambda: a <= b,
            "bitwise_and": lambda: a & b, "bitwise_or": lambda: a | b,
            "bitwise_not": lambda: ~a & 0xFFFFFFFFFFFFFFFF,
            "shift_left": lambda: a << b, "shift_right": lambda: a >> b,
            "add": lambda: a + b, "subtract": lambda: a - b, "multiply": lambda: a * b,
            "divide": lambda: a // b, "modulo": lambda: a % b,
            "to_boolean": lambda: bool(a), "to_uint": lambda: int(a),
            "conditional": lambda: args[1] if args[0] else args[2],
        }[op]()
    except (KeyError, TypeError, ZeroDivisionError):
        return UNKNOWN


def condition_state(conditions: list[dict], values: dict[int, Any]) -> dict[str, Any]:
    """Return {'suppressed': bool|None, 'grayed': bool|None} (None = unknown)."""
    out = {"suppressed": False, "grayed": False}
    for c in conditions:
        key = "suppressed" if c["type"] in ("suppress", "disable") else "grayed"
        r = evaluate(c["expr"], values)
        if r is UNKNOWN:
            if out[key] is False:
                out[key] = None
        elif r:
            out[key] = True
    return out


# ---- metadata --------------------------------------------------------------
def _image_meta(path: str, data: bytes) -> dict:
    meta: dict[str, Any] = {
        "source_file": path.replace("\\", "/").split("/")[-1],
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "extracted_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "vendor_firmware": "AMI Aptio V" if b"AMITSE" in data else "unknown",
    }
    # AMI "$BVDT$" block carries the BIOS version string
    i = data.find(b"$BVDT$")
    if i >= 0:
        chunk = data[i:i + 0x80]
        m = re.search(rb"[ -~]{4,}", chunk[8:])
        if m:
            meta["bvdt"] = m.group().decode()
    from ..firmware.microcode import find_microcode
    meta["microcode"] = find_microcode(data)  # CPU signatures this BIOS can run
    for pat, key in ((rb"Z\d{3}[A-Z ]*EAGLE[ -~]{0,20}", "board_string"),):
        m = re.search(pat, data)
        if m:
            meta[key] = m.group().decode(errors="replace").strip()
    return meta


# ---- build -----------------------------------------------------------------
def _formsets_from_image(img: FirmwareImage) -> list[tuple[str, FormSet]]:
    out = []
    for m in img.modules:
        res = find_hii(m.payloads())
        if not res.forms:
            continue
        table = res.string_table()
        for pkg in res.forms:
            for fs in decode_ifr(pkg.data, table):
                out.append((m.name or str(m.guid), fs))
    return out


def build_schema(bin_path: str, profile: dict | None = None,
                 root_formset_title: str = "Setup") -> dict:
    with open(bin_path, "rb") as f:
        data = f.read()
    img = FirmwareImage(data).walk()
    formsets = _formsets_from_image(img)

    schema: dict[str, Any] = {
        "schema_version": 1,
        "meta": _image_meta(bin_path, data),
        "formsets": {}, "varstores": {}, "forms": {}, "items": {}, "roots": [],
        "stats": {"fv_volumes": img.stats.volumes, "modules": len(img.modules),
                  "decompress_failures": len(img.stats.failed_decompress)},
    }
    guid_to_index: dict[str, int] = {}

    for idx, (module, fs) in enumerate(formsets):
        guid_to_index.setdefault(fs.guid, idx)
        first_form = next(iter(fs.forms), None)
        schema["formsets"][str(idx)] = {
            "guid": fs.guid, "title": fs.title, "help": fs.help, "module": module,
            "root_form": f"{idx}:{first_form}" if first_form is not None else None,
        }
        for vid, vs in fs.varstores.items():
            schema["varstores"][f"{idx}:{vid}"] = vs
        for fid, form in fs.forms.items():
            fkey = f"{idx}:{fid}"
            ids = []
            for n, it in enumerate(form.items):
                iid = f"{fkey}/{n}"
                d = it.to_dict()
                d.pop("form_id", None)
                d.pop("raw_offset", None)
                d["form"] = fkey
                if "varstore_id" in d:
                    vs = fs.varstores.get(d["varstore_id"], {})
                    d["varstore"] = vs.get("name", f"#{d['varstore_id']}")
                    d["varstore_key"] = f"{idx}:{d.pop('varstore_id')}"
                if "target_form" in d:
                    d["target"] = f"{idx}:{d.pop('target_form')}"
                ids.append(iid)
                schema["items"][iid] = d
            schema["forms"][fkey] = {"title": form.title, "formset": str(idx), "items": ids}

    # cross-formset refs
    for d in schema["items"].values():
        tfs = d.pop("target_formset", None)
        if tfs and tfs in guid_to_index and "target" in d:
            d["target"] = f"{guid_to_index[tfs]}:{d['target'].split(':')[1]}"

    # roots: forms of the main Setup formset not referenced from another form
    main = [k for k, v in schema["formsets"].items() if v["title"] == root_formset_title]
    referenced = {d["target"] for d in schema["items"].values()
                  if d.get("target") and d["target"] != d["form"]}
    for k in main:
        for fkey, f in schema["forms"].items():
            if f["formset"] == k and fkey not in referenced:
                schema["roots"].append(fkey)
    # forms of other formsets with no inbound ref are driver pages (exposed via
    # the AMI "Peripherals"/"Device Manager"-style dynamic list)
    schema["driver_pages"] = [
        v["root_form"] for k, v in schema["formsets"].items()
        if k not in main and v["root_form"] and v["root_form"] not in referenced
    ]

    if profile:
        schema["hardware_profile"] = profile
    annotate_default_visibility(schema, profile)
    annotate_numeric_ranges(schema)
    return schema


# ---- numeric ranges ---------------------------------------------------------
PLACEHOLDER_RANGES = {(0, 0xFF), (0, 0xFFFF), (0, 0xFFFFFFFF), (0, 0xFFFFFFFFFFFFFFFF)}
_RANGE_RE = re.compile(r"\brange\s*(?:is|:|of)?\s*\(?\s*(-?\d+)\s*(?:-|–|to|~)\s*(-?\d+)\s*\)?\s*(mV|mv|millivolts?|mOhms?|W|watts?|ms|MHz|%)?", re.I)
_UNIT_HINTS = [
    (re.compile(r"1/100\s*mOhm", re.I), "mΩ", 0.01),
    (re.compile(r"\bmillivolts?\b|\bin mV\b|\(mV\)|\bmV\b", re.I), "mV", 1),
    (re.compile(r"\(Watts?\)|\bin watts?\b", re.I), "W", 1),
    (re.compile(r"\bin (?:milli)?seconds\b|\bms\b", re.I), "ms", 1),
]


def numeric_range_hint(d: dict) -> dict | None:
    """Real range/unit for a numeric option, read from its own help text.
    Gigabyte stores many numbers with a placeholder IFR range (0-65535) and
    states the real one in the help string, e.g. "Range is 0-6249 (0-62.49 mOhms)"."""
    text = f"{d.get('help', '')} {d.get('prompt', '')}"
    hint: dict = {}
    m = _RANGE_RE.search(text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo < hi:
            hint.update(min=lo, max=hi, source="help text")
        unit = (m.group(3) or "").lower()
        if unit.startswith("m") and "ohm" not in unit and unit != "ms" and unit != "mhz":
            hint["unit"] = "mV"
        elif unit:
            hint["unit"] = {"mohm": "mΩ", "mohms": "mΩ", "w": "W", "watt": "W", "watts": "W", "ms": "ms", "mhz": "MHz", "%": "%"}.get(unit, unit)
    for rx, unit, scale in _UNIT_HINTS:
        if rx.search(text):
            hint.setdefault("unit", unit)
            if scale != 1:
                hint["scale"] = scale
            break
    return hint or None


def annotate_numeric_ranges(schema: dict) -> None:
    counts = {"from_ifr": 0, "from_help": 0, "unknown": 0}
    for d in schema["items"].values():
        if d["kind"] != "numeric" or d.get("min") is None:
            continue
        hint = numeric_range_hint(d)
        if hint:
            d["range_hint"] = hint
        placeholder = (d["min"], d["max"]) in PLACEHOLDER_RANGES and d["min"] != d["max"]
        if hint and "min" in hint:
            counts["from_help"] += 1
        elif placeholder:
            d["range_unknown"] = True  # the firmware's GUI enforces the real limits, not the IFR
            counts["unknown"] += 1
        else:
            counts["from_ifr"] += 1
    schema["stats"]["numeric_ranges"] = counts


def initial_values(schema: dict, profile: dict | None = None) -> dict[str, dict[int, Any]]:
    """Starting value of every question, per formset (question ids are
    formset-scoped): IFR default, else first option / numeric min, then the
    hardware profile overrides runtime varstores (capability flags etc.)."""
    profile = profile or {}
    vs_defaults = profile.get("varstore_defaults", {})
    overrides = profile.get("values", {})
    by_fs: dict[str, dict[int, Any]] = {}
    for d in schema["items"].values():
        fsk = d["form"].split(":")[0]
        vals = by_fs.setdefault(fsk, {})
        qid = d.get("question_id")
        if qid is None:
            continue
        vs = d.get("varstore")
        ov = overrides.get(vs, {}).get(str(d.get("offset"))) if vs else None
        if ov is not None:
            vals[qid] = ov
            continue
        if vs in vs_defaults:
            vals[qid] = vs_defaults[vs]
            continue
        v = d.get("default")
        if v is None and d["kind"] == "oneof" and d.get("options"):
            v = d["options"][0]["value"]
        if v is None and d["kind"] == "numeric":
            v = d.get("min", 0)
        if v is not None:
            vals.setdefault(qid, v)
    return by_fs


def annotate_default_visibility(schema: dict, profile: dict | None = None) -> None:
    by_fs = initial_values(schema, profile)
    counts = {"visible": 0, "hidden": 0, "uncertain": 0}
    for d in schema["items"].values():
        d.pop("default_grayed", None)
        st = condition_state(d.get("conditions", []), by_fs.get(d["form"].split(":")[0], {}))
        if st["suppressed"] is True:
            d["default_visibility"] = "hidden"
        elif st["suppressed"] is None:
            d["default_visibility"] = "uncertain"
        else:
            d["default_visibility"] = "visible"
        if st["grayed"]:
            d["default_grayed"] = True
        counts[d["default_visibility"]] += 1
    schema["stats"]["default_visibility"] = counts


def iter_tree(schema: dict, root: str, seen: set | None = None, depth: int = 0,
              visible_only: bool = True) -> Iterable[tuple[int, str, dict]]:
    """Depth-first walk of the menu tree from a form key."""
    seen = set() if seen is None else seen
    if root in seen or root not in schema["forms"]:
        return
    seen.add(root)
    for iid in schema["forms"][root]["items"]:
        d = schema["items"][iid]
        if visible_only and d.get("default_visibility") == "hidden":
            continue
        yield depth, iid, d
        if d["kind"] == "ref" and d.get("target"):
            yield from iter_tree(schema, d["target"], seen, depth + 1, visible_only)


__all__ = ["build_schema", "initial_values", "evaluate", "condition_state", "iter_tree", "load_image", "UNKNOWN"]
