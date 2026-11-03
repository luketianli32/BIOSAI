"""End-to-end test of the BIOS AI emulator in headless Edge (Chrome DevTools Protocol).

  uv run python -m biosai serve          # in another terminal (serves app/dist + /api)
  uv run python tests/e2e_emulator.py    # runs every check, prints PASS/FAIL, exits 1 on failure

The page is driven the way a user drives it (clicks, keys, typing); results are
read back from the DOM. One check runs the online (claude.ai Artifact) AI path
against a mocked `window.claude` runtime, since that only exists on claude.ai.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import traceback
import urllib.request

import websockets

EDGE = os.environ.get("EDGE", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
BASE = os.environ.get("BIOSAI_URL", "http://127.0.0.1:8765/")
PORT = 9334

# Helpers injected into every page load: DOM queries and user-like actions.
HELPERS = r"""
window.__sel = { selectedSets: 0, selectsRemoved: 0 };
(() => {
  const d = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected');
  Object.defineProperty(HTMLOptionElement.prototype, 'selected', {
    get() { return d.get.call(this); }, set(v) { window.__sel.selectedSets++; return d.set.call(this, v); } });
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes)
    if (n.nodeType === 1 && (n.tagName === 'SELECT' || n.querySelector?.('select'))) window.__sel.selectsRemoved++; })
    .observe(document, { childList: true, subtree: true });
})();
window.T = {
  txt: (el) => (el?.textContent ?? '').replace(/[▾🔒●]/g, '').trim(),
  rows: () => [...document.querySelectorAll('.list .row')],
  labels: () => T.rows().map((r) => T.txt(r.querySelector('.label') ?? r)),
  row: (l) => T.rows().find((r) => T.txt(r.querySelector('.label')) === l),
  value: (l) => T.txt(T.row(l)?.querySelector('.value')),
  clickValue: (l) => { const v = T.row(l)?.querySelector('.value'); if (!v) return false; v.click(); return true; },
  open: (l) => { const r = T.row(l); if (!r) return false; r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; },
  dropdown: () => [...document.querySelectorAll('.dropdown li')].map((li) => T.txt(li).replace(/ default$/, '')),
  pick: (label) => { const li = [...document.querySelectorAll('.dropdown li')].find((x) => T.txt(x).replace(/ default$/, '') === label); if (!li) return false; li.click(); return true; },
  key: (k, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o })),
  tab: (name) => { const b = [...document.querySelectorAll('nav.tabs .tab')].find((x) => T.txt(x) === name); b?.click(); return !!b; },
  crumbs: () => T.txt(document.querySelector('.crumbs')),
  setSelect: (label, value) => {
    const s = document.querySelector(`select[aria-label="${label}"]`); if (!s) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, value);
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; },
  options: (label) => [...(document.querySelector(`select[aria-label="${label}"]`)?.options ?? [])].map((o) => o.textContent),
  stat: (section, dt) => { const sec = [...document.querySelectorAll('.msec')].find((s) => T.txt(s.querySelector('.msec-head')).endsWith(section));
    const st = [...(sec?.querySelectorAll('.stat') ?? [])].find((x) => T.txt(x.querySelector('dt')) === dt); return T.txt(st?.querySelector('dd')); },
  toast: () => T.txt(document.querySelector('.toast')),
};
"""

MOCK_CLAUDE = r"""
window.__sampleCalls = [];
window.claude = { use: async (name) => name !== 'sample' ? null : async (input, opts = {}) => {
  window.__sampleCalls.push(input);
  const text = 'Set **Vcore Voltage Mode** [[item:4:10870/1]] to Adaptive Vcore first, then apply a small negative offset.';
  await new Promise((r) => setTimeout(r, 50));
  opts.onText?.({ text: text.slice(0, 20), delta: text.slice(0, 20) });
  await new Promise((r) => setTimeout(r, 50));
  opts.onText?.({ text, delta: text.slice(20) });
  return { text, truncated: false, modelTierApplied: 'default' };
} };
"""


class Page:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.errors: list[str] = []
        self.pending: dict[int, asyncio.Future] = {}
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self.pending:
                self.pending.pop(msg["id"]).set_result(msg)
            elif msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                self.errors.append("exception: " + (d.get("exception", {}).get("description") or d.get("text", ""))[:300])
            elif msg.get("method") == "Runtime.consoleAPICalled" and msg["params"]["type"] == "error":
                self.errors.append("console.error: " + " ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"]["args"])[:300])

    async def call(self, method, **params):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        msg = await asyncio.wait_for(fut, 30)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg.get("result", {})

    async def js(self, expr: str):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", "js error"))
        return r["result"].get("value")

    async def wait(self, expr: str, timeout=8.0) -> bool:
        t = 0.0
        while t < timeout:
            if await self.js(f"!!({expr})"):
                return True
            await asyncio.sleep(0.15)
            t += 0.15
        return False

    async def load(self, query: str = "", reset_storage=True):
        await self.call("Page.navigate", url=BASE + query)
        await self.wait("document.readyState === 'complete' && window.T && document.querySelector('.bios')", 20)
        if reset_storage:
            await self.js("try { localStorage.clear() } catch (e) {}")
        await asyncio.sleep(0.4)

    async def type(self, text: str):
        await self.call("Input.insertText", text=text)


RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail=""):
    RESULTS.append((name, bool(ok), str(detail)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail and not ok else ""))


async def run(p: Page):
    # ---------------------------------------------------------------- load & layout
    await p.load("?tab=tweaker")
    tabs = await p.js("[...document.querySelectorAll('nav.tabs .tab')].map(T.txt)")
    check("6 Advanced Mode tabs in the GUI's order", tabs == ["Favorites (F11)", "Tweaker", "Settings", "System Info.", "Boot", "Save & Exit"], tabs)
    labels = await p.js("T.labels()")
    check("Tweaker opens with GIGABYTE PerfDrive and 30+ rows", labels[:1] == ["GIGABYTE PerfDrive"] and len(labels) >= 30, f"{len(labels)} rows, first={labels[:1]}")
    for want in ["CPU/PCH Voltage Control", "Vcore Voltage Mode", "DRAM Voltage Control", "VDDQ CPU", "DDR5 Voltage Control"]:
        check(f"Tweaker includes '{want}'", want in labels, "")
    t1 = await p.js("T.txt(document.querySelector('.clock'))")
    await asyncio.sleep(1.3)
    t2 = await p.js("T.txt(document.querySelector('.clock'))")
    check("Clock ticks every second", t1 != t2, f"{t1!r} -> {t2!r}")

    for name in ["Favorites (F11)", "Settings", "System Info.", "Boot", "Save & Exit", "Tweaker"]:
        await p.js(f"T.tab({json.dumps(name)})")
        await asyncio.sleep(0.25)
        n = await p.js("T.rows().length")
        check(f"Tab '{name}' renders rows", n > 0, f"{n} rows")

    # ---------------------------------------------------------------- inline dropdown + dynamic options
    await p.js("T.clickValue('Vcore Voltage Mode')")
    opened = await p.wait("T.dropdown().length > 0", 3)
    opts = await p.js("T.dropdown()")
    check("Clicking a value opens its dropdown", opened and "Adaptive Vcore" in opts, opts)
    await asyncio.sleep(2.5)
    check("Dropdown stays open while the clock ticks", await p.js("T.dropdown().length > 0"), "")
    before = await p.js("T.labels().includes('Internal CPU Vcore')")
    await p.js("T.pick('Adaptive Vcore')")
    await asyncio.sleep(0.4)
    check("Picking an option sets the value", await p.js("T.value('Vcore Voltage Mode')") == "Adaptive Vcore", await p.js("T.value('Vcore Voltage Mode')"))
    after = await p.js("T.labels().includes('Internal CPU Vcore')")
    check("Adaptive Vcore reveals 'Internal CPU Vcore' (firmware rule)", (not before) and after, f"before={before} after={after}")
    check("Changed option is starred", await p.js("T.txt(T.row('Vcore Voltage Mode').querySelector('.star')) === '★'"), "")
    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Auto')")
    await asyncio.sleep(0.3)
    check("Back to Auto hides the sub-options again", not await p.js("T.labels().includes('Internal CPU Vcore')"), "")

    # ---------------------------------------------------------------- Single Core Vcore -> Special Vcore Setting
    check("'Special Vcore Setting' hidden while Vcore Voltage Mode = Auto", not await p.js("T.labels().includes('Special Vcore Setting')"), "")
    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Single Core Vcore')")
    await asyncio.sleep(0.4)
    labels = await p.js("T.labels()")
    i = labels.index("Vcore Voltage Mode")
    check("Single Core Vcore reveals 'Special Vcore Setting' right below it", labels[i + 1:i + 2] == ["Special Vcore Setting"], labels[i:i + 3])
    await p.js("T.open('Special Vcore Setting')"); await asyncio.sleep(0.4)
    sv = await p.js("T.labels()")
    check("Special Vcore Setting opens the per-core page", "PCore Setting Mode" in sv and "Pcore 0 Setting" in sv and "ECore Setting Mode" in sv, sv[:6])
    n_before = await p.js("T.labels().length")
    await p.js("T.clickValue('Pcore 0 Setting')"); await p.wait("T.dropdown().length", 3)
    pc_opts = await p.js("T.dropdown()")
    await p.js(f"T.pick({json.dumps(next((o for o in pc_opts if o != 'Auto'), pc_opts[-1]))})"); await asyncio.sleep(0.4)
    n_after = await p.js("T.labels().length")
    check("A non-Auto P-core setting reveals its Mode/Voltage/DVID rows", n_after >= n_before + 3, f"{n_before} -> {n_after} rows, options {pc_opts}")
    await p.js("T.key('Escape')"); await asyncio.sleep(0.2)
    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Auto')")
    await asyncio.sleep(0.3)

    # ---------------------------------------------------------------- numeric entry + readings
    await p.js("T.clickValue('Performance CPU Clock Ratio')")
    has_input = await p.wait("document.querySelector('.numedit input')", 3)
    await p.js("(() => { const i = document.querySelector('.numedit input'); i.focus(); i.select(); })()")
    await p.type("56")
    await p.js("T.key('Enter')")
    await asyncio.sleep(1.4)
    val = await p.js("T.value('Performance CPU Clock Ratio')")
    freq = await p.js("T.stat('CPU', 'Frequency')")
    check("Typing a ratio sets it", has_input and val == "56", f"value={val!r}")
    check("CPU frequency reading follows the ratio (≈5600 MHz)", freq.startswith("5600") or freq.startswith("5599"), freq)
    await p.js("T.clickValue('Performance CPU Clock Ratio')"); await p.wait("document.querySelector('.numedit input')", 3)
    await p.js("(() => { const i = document.querySelector('.numedit input'); i.focus(); i.select(); })()")
    await p.type("999999")
    await p.js("T.key('Enter')")
    await asyncio.sleep(0.3)
    err = await p.js("T.txt(document.querySelector('.numedit .err'))")
    check("Out-of-range number is rejected with a message", "Enter" in err, err)
    await p.js("T.key('Escape')")

    # ---------------------------------------------------------------- real ranges from help text
    async def enter(label, text):
        await p.js(f"T.clickValue({json.dumps(label)})")
        await p.wait("document.querySelector('.numedit input')", 3)
        await p.js("(() => { const i = document.querySelector('.numedit input'); i.focus(); i.select(); })()")
        await p.type(text)
        await p.js("T.key('Enter')")
        await asyncio.sleep(0.3)
        return await p.js("T.txt(document.querySelector('.numedit .err'))")

    # documented ratio ceiling (GIGABYTE BIOS guide): 85, or 120 with Core Ratio Extension Mode
    err = await enter("Performance CPU Clock Ratio", "90")
    check("Ratio above the documented 85 ceiling is rejected", "0 to 85" in err, err)
    await p.js("T.key('Escape')")
    err = await enter("Performance CPU Clock Ratio", "85")
    check("Ratio at the 85 ceiling is accepted", not err and await p.js("T.value('Performance CPU Clock Ratio')") == "85", err)
    await enter("Performance CPU Clock Ratio", "0")
    await p.js("T.clickValue('VDDQ CPU')"); await p.wait("document.querySelector('.numedit')", 3)
    ref = await p.js("T.txt(document.querySelector('.numedit .ref-note'))")
    check("VDDQ CPU shows a sourced reference note", "Reference" in ref and "Source:" in ref, ref[:120])
    await p.js("T.key('Escape')")

    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Adaptive Vcore')")
    await p.js("T.clickValue('VF Point Offset Mode')"); await p.wait("T.dropdown().length", 3)
    vfopts = await p.js("T.dropdown()")
    await p.js(f"T.pick({json.dumps(next((o for o in vfopts if o != 'Legacy'), vfopts[-1]))})"); await asyncio.sleep(0.3)
    if await p.js("!!T.row('VF Point 1 Offset')"):
        err = await enter("VF Point 1 Offset", "-50")
        check("Negative mV offset accepted and shown with unit", not err and await p.js("T.value('VF Point 1 Offset')") == "-50 mV", await p.js("T.value('VF Point 1 Offset')"))
        err = await enter("VF Point 1 Offset", "900")
        check("Help-text range enforced (VF offset ±500 mV)", "-500 to 500" in err, err)
        await p.js("T.key('Escape')")
    else:
        check("VF Point 1 Offset visible after choosing per-point mode", False, vfopts)
    await p.js("T.clickValue('VF Point Offset Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Legacy')"); await asyncio.sleep(0.3)
    await p.js("T.clickValue('Internal CPU Vcore Offset')"); await p.wait("document.querySelector('.numedit')", 3)
    note = await p.js("T.txt(document.querySelector('.numedit .range-note'))")
    check("Gigabyte-only range shows 'not defined' instead of 0–65535", "doesn't define a range" in note, note)
    await p.js("T.key('Escape')")
    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Auto')")

    # ---------------------------------------------------------------- CPU catalog + microcode
    cpus = await p.js("T.options('CPU')")
    check("CPU list includes Core Ultra 7 270K Plus and 5 250K Plus", "Intel Core Ultra 7 270K Plus" in cpus and "Intel Core Ultra 5 250K Plus" in cpus, cpus)
    check("CPU list loads the full catalog from cpus.json (14 CPUs)", len(cpus) >= 14, len(cpus))
    await p.js("T.setSelect('CPU', '270kplus')"); await asyncio.sleep(0.3)
    check("BIOS microcode check shown for the selected CPU", "microcode" in await p.js("T.txt(document.querySelector('.monitor .spec.ok'))"), "")
    await p.js("T.setSelect('CPU', '285k')"); await asyncio.sleep(0.2)

    # ---------------------------------------------------------------- per-core rows follow the CPU
    await p.js("T.open('Advanced CPU Settings')")
    await asyncio.sleep(0.4)
    check("Opening a sub-menu updates the breadcrumb", "Advanced CPU Settings" in await p.js("T.crumbs()"), await p.js("T.crumbs()"))
    await p.js("T.clickValue('Turbo Per Core Limit Control')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Manual')")
    await asyncio.sleep(0.4)
    count = "T.labels().filter((l) => /^Turbo P-Core \\d+ +Ratio Limit$/.test(l)).length"
    n285 = await p.js(count)
    await p.js("T.setSelect('CPU', '245k')"); await asyncio.sleep(0.4)
    n245 = await p.js(count)
    check("285K shows 8 per-core P ratio rows, 245K shows 6", (n285, n245) == (8, 6), f"285K={n285} 245K={n245}")
    spec = await p.js("T.txt(document.querySelector('.monitor .spec'))")
    check("CPU spec line follows the selection", spec.startswith("6P + 8E"), spec)
    await p.js("T.setSelect('CPU', '225')"); await asyncio.sleep(0.4)
    await p.js("T.key('Escape')"); await asyncio.sleep(0.3)
    locked = await p.js("T.row('Performance CPU Clock Ratio')?.querySelector('.value').textContent.includes('🔒')")
    await p.js("T.clickValue('Performance CPU Clock Ratio')"); await asyncio.sleep(0.3)
    no_editor = await p.js("!document.querySelector('.numedit')")
    check("Non-K CPU locks ratio options and explains why", locked and no_editor and "locked multiplier" in await p.js("T.toast()"), await p.js("T.toast()"))
    await p.js("T.setSelect('CPU', '285k')"); await asyncio.sleep(0.3)

    # ---------------------------------------------------------------- memory, XMP variants, readings
    await p.js("T.setSelect('Memory frequency', '5600')"); await asyncio.sleep(0.4)
    check("JEDEC-only kit: BIOS hides X.M.P.", not await p.js("T.labels().includes('Extreme Memory Profile(X.M.P.)')"), "")
    await p.js("T.setSelect('Memory frequency', 'x6000')"); await asyncio.sleep(0.4)
    check("XMP kit: X.M.P. is shown", await p.js("T.labels().includes('Extreme Memory Profile(X.M.P.)')"), "")
    await p.js("T.clickValue('Extreme Memory Profile(X.M.P.)')"); await p.wait("T.dropdown().length", 3)
    xopts = await p.js("T.dropdown()")
    check("X.M.P. offers the Intel XMP variant", "XMP 1" in xopts and not any("EXPO" in o for o in xopts), xopts)
    await p.js("T.pick('XMP 1')"); await asyncio.sleep(1.2)
    check("Enabling XMP raises memory frequency to 6000 MT/s", (await p.js("T.stat('Memory', 'Frequency')")).startswith("6000"), await p.js("T.stat('Memory', 'Frequency')"))
    await p.js("T.setSelect('Memory capacity', '128')"); await asyncio.sleep(0.4)
    slots = await p.js("[...document.querySelectorAll('.monitor .slots li')].filter((li) => !li.textContent.includes('N/A')).length")
    check("128GB fills all 4 DIMM slots", slots == 4, slots)
    await p.js("T.setSelect('Memory capacity', '48')"); await asyncio.sleep(0.2)

    # ---------------------------------------------------------------- GPU list + warnings
    gpus = await p.js("T.options('Graphics card')")
    check("Graphics list has every current GPU (45+)", len(gpus) >= 45, len(gpus))
    groups = await p.js("[...document.querySelectorAll('select[aria-label=\"Graphics card\"] optgroup')].map((g) => g.label)")
    check("GPUs are grouped by series", {"GeForce RTX 50 series", "Radeon RX 9000 series", "Intel Arc B-series"} <= set(groups), groups)
    await p.js("T.setSelect('Graphics card', 'arc-b580')"); await asyncio.sleep(0.3)
    check("Arc GPU shows the Re-Size BAR warning", "Re-Size BAR" in await p.js("T.txt(document.querySelector('.monitor'))"), "")
    link = await p.js("T.txt([...document.querySelectorAll('.msec')].find((s) => T.txt(s.querySelector('.msec-head')).endsWith('Graphics'))?.querySelector('.spec'))")
    check("GPU link width shown (Arc B580: PCIe 4.0 x8)", "PCIe 4.0 x8" in link, link)
    await p.js("T.setSelect('Graphics card', 'geforce-rtx-4090')")
    await p.js("T.setSelect('Drive type', 'sata-ssd')"); await asyncio.sleep(0.2)
    storage = await p.js("T.txt([...document.querySelectorAll('.msec')].find((s) => T.txt(s.querySelector('.msec-head')).endsWith('Storage'))?.querySelector('.spec'))")
    check("Storage type follows the selection", "SATA" in storage, storage)

    # ---------------------------------------------------------------- dropdowns not touched while idle
    await p.js("window.__sel.selectedSets = 0; window.__sel.selectsRemoved = 0")
    await asyncio.sleep(3)
    idle = await p.js("window.__sel")
    check("Advanced Mode: no dropdown touched in 3 idle seconds", idle == {"selectedSets": 0, "selectsRemoved": 0}, idle)

    # ---------------------------------------------------------------- search
    await p.js("T.key('f', { altKey: true })")
    await p.wait("document.querySelector('.modal input')", 3)
    await p.js("document.querySelector('.modal input').focus()")
    await p.type("Fast Boot")
    await asyncio.sleep(0.3)
    hits = await p.js("document.querySelectorAll('.hits li').length")
    await p.js("T.key('Enter')")
    await asyncio.sleep(0.5)
    flashed = await p.js("T.txt(document.querySelector('.row.flash .label'))")
    check("Search finds an option and jumps to it", hits > 0 and flashed == "Fast Boot", f"hits={hits} flashed={flashed!r}")

    # ---------------------------------------------------------------- save & defaults
    pending = await p.js("T.txt(document.querySelector('.pending'))")
    await p.js("T.key('F10')"); await p.wait("document.querySelector('.modal')", 3)
    rows = await p.js("document.querySelectorAll('.changes tr').length")
    check("Save & Exit lists every unsaved change", rows > 0 and str(rows) in pending, f"{rows} rows, '{pending}'")
    await p.js("T.key('Enter')"); await asyncio.sleep(0.3)
    check("Saving clears the unsaved-changes count", await p.js("T.txt(document.querySelector('.pending'))") == "No unsaved changes", "")
    flashed_tab = await p.js("T.txt(document.querySelector('nav.tabs .tab.on'))")
    check("Search jumps to the shallowest location (Fast Boot -> Boot tab)", flashed_tab == "Boot", flashed_tab)
    await p.js("T.tab('Tweaker')"); await asyncio.sleep(0.2)
    for _ in range(6):
        await p.js("T.key('Escape')")
    await asyncio.sleep(0.2)
    await p.js("T.clickValue('Vcore Voltage Mode')"); await p.wait("T.dropdown().length", 3); await p.js("T.pick('Fixed Vcore')")
    await p.js("T.key('F7')"); await p.wait("document.querySelector('.modal')", 3); await p.js("T.key('Enter')"); await asyncio.sleep(0.3)
    check("Load Optimized Defaults resets options", await p.js("T.value('Vcore Voltage Mode')") == "Auto", await p.js("T.value('Vcore Voltage Mode')"))

    # ---------------------------------------------------------------- easy mode
    await p.js("T.key('F2')")
    await p.wait("document.querySelector('.easy')", 3)
    ez = await p.js("""[...document.querySelectorAll('.ez-set')].map((s) => ({ label: T.txt(s.querySelector('.ez-label')),
        select: !!s.querySelector('select'), ai: !!s.querySelector('.ez-ask'),
        aiRight: s.querySelector('select') && s.querySelector('.ez-ask') ? s.querySelector('.ez-ask').getBoundingClientRect().left > s.querySelector('select').getBoundingClientRect().right : null }))""")
    check("Easy Mode lists settings with dropdowns", sum(1 for s in ez if s["select"]) >= 6, ez)
    check("Every Easy Mode setting has an AI button", all(s["ai"] for s in ez), [s["label"] for s in ez if not s["ai"]])
    check("AI button sits to the right of the dropdown", all(s["aiRight"] for s in ez if s["aiRight"] is not None), "")
    check("Easy Mode hides DDR5 Auto Booster (hidden in F5 firmware)", not any(s["label"] == "DDR5 Auto Booster" for s in ez), "")
    rebar = "document.querySelector('select[aria-label=\"Re-Size BAR Support\"]')"
    opt_vals = await p.js(f"[...{rebar}.options].map((o) => o.value)")
    cur = await p.js(f"{rebar}.value")
    other = next(v for v in opt_vals if v != cur)
    await p.js(f"T.setSelect('Re-Size BAR Support', '{other}')"); await asyncio.sleep(0.3)
    check("Changing an Easy Mode dropdown sticks", await p.js(f"{rebar}.value") == other, "")
    await p.js("window.__sel.selectedSets = 0; window.__sel.selectsRemoved = 0"); await asyncio.sleep(3)
    idle = await p.js("window.__sel")
    check("Easy Mode: no dropdown touched in 3 idle seconds (stays open)", idle == {"selectedSets": 0, "selectsRemoved": 0}, idle)

    # ---------------------------------------------------------------- AI via local server (offline or Claude)
    await p.js("document.querySelector('.ez-ask').click()")
    ok = await p.wait("[...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent.length > 40)", 60)
    reply = await p.js("T.txt([...document.querySelectorAll('.msg.assistant')].at(-1))")
    check("Ask AI (local server) answers about the option", ok and len(reply) > 40, reply[:120])
    has_goto = await p.js("!!document.querySelector('.msg.assistant .goto')")
    check("Answer has 'show me' links", has_goto, "")
    if has_goto:
        target = await p.js("T.txt(document.querySelector('.msg.assistant .goto')).replace(/^↗ /, '')")
        await p.js("document.querySelector('.msg.assistant .goto').click()"); await asyncio.sleep(0.6)
        check("'Show me' jumps to the option in Advanced Mode", await p.js("T.txt(document.querySelector('.row.flash .label'))") == target, target)

    # ---------------------------------------------------------------- phone width
    await p.call("Emulation.setDeviceMetricsOverride", width=400, height=860, deviceScaleFactor=1, mobile=True)
    await p.load("?tab=tweaker")
    sw = await p.js("[document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]")
    check("Phone width: the page itself never scrolls sideways", sw[0] <= sw[2] and sw[1] <= sw[2], sw)
    await p.call("Emulation.clearDeviceMetricsOverride")


async def run_artifact_mode(p: Page):
    sid = (await p.call("Page.addScriptToEvaluateOnNewDocument", source=MOCK_CLAUDE))["identifier"]
    try:
        await p.load("?tab=tweaker")
        ok = await p.wait("T.txt(document.querySelector('.badge')).includes('your account')", 12)
        check("Online mode: uses the viewer's Claude (mocked claude.ai runtime)", ok, await p.js("T.txt(document.querySelector('.badge'))"))
        check("Online mode: no API-key button", not await p.js("!!document.querySelector('.connect-btn')"), "")
        await p.js("document.querySelector('.chips button').click()")
        got = await p.wait("document.querySelector('.msg.assistant .goto')", 10)
        calls = await p.js("window.__sampleCalls")
        first = calls[0] if calls else []
        joined = " ".join(t["content"] for t in first) if isinstance(first, list) else str(first)
        check("Online mode: prompt carries rules, knowledge base and BIOS context",
              "BIOS AI" in joined and "Tuning guide" in joined and "<bios_context>" in joined and "[4:" in joined, joined[:160])
        check("Online mode: answer renders with a 'show me' link", got, "")
        await p.js("document.querySelector('.msg.assistant .goto').click()"); await asyncio.sleep(0.6)
        check("Online mode: link jumps to Vcore Voltage Mode", await p.js("T.txt(document.querySelector('.row.flash .label'))") == "Vcore Voltage Mode", "")
        await p.js("document.querySelector('.ai-input textarea').focus()")
        await p.type("and then?")
        await p.js("document.querySelector('.ai-input button').click()")
        await p.wait("window.__sampleCalls.length >= 2", 10)
        second = (await p.js("window.__sampleCalls"))[1]
        check("Online mode: follow-ups keep the conversation", isinstance(second, list) and any(t["role"] == "assistant" for t in second) and second[-1]["role"] == "user", [t["role"] for t in second])
    finally:
        await p.call("Page.removeScriptToEvaluateOnNewDocument", identifier=sid)


async def main() -> int:
    prof = tempfile.mkdtemp(prefix="biosai-e2e-")
    proc = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--no-first-run", f"--remote-debugging-port={PORT}",
                             f"--user-data-dir={prof}", "--window-size=1920,1080", "about:blank"])
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version"); break
            except OSError:
                await asyncio.sleep(0.25)
        page = next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json")) if t["type"] == "page")
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
            p = Page(ws)
            for d in ("Page", "Runtime"):
                await p.call(f"{d}.enable")
            await p.call("Emulation.setDeviceMetricsOverride", width=1920, height=1080, deviceScaleFactor=1, mobile=False)
            await p.call("Emulation.clearDeviceMetricsOverride")
            await p.call("Page.addScriptToEvaluateOnNewDocument", source=HELPERS)
            for name, fn in (("Emulator", run), ("Online AI mode", run_artifact_mode)):
                print(f"\n== {name}")
                try:
                    await fn(p)
                except Exception as e:  # a crash in one block is a failure, not the end of the run
                    check(f"{name}: run without crashing", False, f"{e!r}\n{traceback.format_exc(limit=2)}")
            check("No JavaScript errors in the console", not p.errors, p.errors[:5])
    finally:
        proc.terminate()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
