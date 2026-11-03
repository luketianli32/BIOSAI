import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Change, Item, Layout, Profile, Schema } from "./types";
import {
  PageBook, Values, decodeNumeric, displayValue, encodeNumeric, initialValues, isEditable, isSelectable, numericRange,
  viewRows, visibleOptions, vkey, type RowView,
} from "./engine";
import { buildQIndex, explainItem } from "./explain";
import { EasyMode } from "./EasyMode";
import { Icon } from "./Icon";
import { AiPanel, type AiPanelHandle } from "./AiPanel";
import { Tutor } from "./tutor";
import { enforcedMax, refFor, sanityCheck, sanityFor, sanityParse, sanityScale, sanitySummary } from "./refs";
import {
  CPUS, GPUS, MEM_SIZES, MEM_SPEEDS, SSD_SIZES, SSD_TYPES, describeHw, dimmSlots, gpuLink, hardwareLock, hardwareWarnings,
  loadHw, resolveHw, runtimeOverrides, saveHw, type Hw, type HwSel,
} from "./hardware";
import { computeReadings, findHandles, readingsSummary, type Readings } from "./sim";

interface Props { schema: Schema; layout: Layout; profile: Profile }

interface Anchor { top: number; left: number; width: number }
type Popup =
  | { kind: "options"; iid: string; sel: number; anchor: Anchor }
  | { kind: "numeric"; iid: string; text: string; error?: string; anchor: Anchor }
  | { kind: "save" }
  | { kind: "defaults" }
  | { kind: "search"; q: string; sel: number }
  | null;

interface Frame { page: string; sel: number }

/** vkeys + values for the runtime varstore offsets that follow the selected hardware. */
function runtimeEntries(schema: Schema, hw: Hw): [string, number][] {
  const ov = runtimeOverrides(hw);
  const out: [string, number][] = [];
  for (const it of Object.values(schema.items)) {
    if (it.question_id === undefined || !it.varstore) continue;
    const v = ov[it.varstore]?.[String(it.offset)];
    if (v !== undefined) out.push([vkey(it), v]);
  }
  return out;
}

export default function App({ schema, layout, profile }: Props) {
  const book = useMemo(() => new PageBook(schema, layout), [schema, layout]);
  const qidx = useMemo(() => buildQIndex(schema), [schema]);
  const tutor = useMemo(() => new Tutor(schema, book), [schema, book]);
  const keyToIid = useMemo(() => {
    const m = new Map<string, string>();
    for (const [iid, it] of Object.entries(schema.items)) if (it.question_id !== undefined && !m.has(vkey(it))) m.set(vkey(it), iid);
    return m;
  }, [schema]);
  const handles = useMemo(() => findHandles(schema), [schema]);
  // CPU models this BIOS carries microcode for (from extraction), or null for older schemas
  const ucode = useMemo(() => {
    const mc = (schema.meta as unknown as { microcode?: { model: string }[] }).microcode;
    return Array.isArray(mc) ? new Set(mc.map((m) => m.model)) : null;
  }, [schema]);
  const zeroAuto = !!layout.numeric_zero_means_auto;
  /** Range the emulator enforces: help-text range or IFR range, capped by documented vendor limits. */
  const rangeOf = (it: Item) => {
    const r = numericRange(it);
    const em = enforcedMax(it, schema, valsRef.current);
    return em !== undefined && em < r.max ? { ...r, max: em, capped: true } : { ...r, capped: false };
  };
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  const [hwSel, setHwSel] = useState<HwSel>(loadHw);
  const hw: Hw = useMemo(() => resolveHw(hwSel), [hwSel]);
  const lock = useCallback((it: Item) => hardwareLock(it, hw), [hw]);
  const updateHw = (patch: Partial<HwSel>) => setHwSel((s) => { const n = { ...s, ...patch }; saveHw(n); return n; });
  const runtime = useMemo(() => runtimeEntries(schema, hw), [schema, hw]);
  const withRuntime = (m: Values) => { const n = new Map(m); for (const [k, v] of runtime) n.set(k, v); return n; };
  const baseline = useMemo(() => withRuntime(initialValues(schema, profile)), [schema, profile, runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode, setMode] = useState<"easy" | "advanced">(params.get("mode") === "easy" ? "easy" : "advanced");
  // ?set=<iid>=<value>,... preconfigures options (deep links, demos, tests)
  const [vals, setVals] = useState<Values>(() => {
    const m = new Map(baseline);
    for (const pair of (params.get("set") ?? "").split(",").filter(Boolean)) {
      const [iid, v] = pair.split("=");
      const it = schema.items[iid];
      if (it?.question_id !== undefined && !Number.isNaN(Number(v))) m.set(vkey(it), Number(v));
    }
    return m;
  });
  const [saved, setSaved] = useState<Values>(() => new Map(baseline));
  // swapping parts updates what the BIOS "detected" without counting as a user change
  useEffect(() => { setVals(withRuntime); setSaved(withRuntime); }, [runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState(() => Math.max(0, layout.tabs.findIndex((t) => t.id === (params.get("tab") ?? "tweaker"))));
  const [stacks, setStacks] = useState<Frame[][]>(() => layout.tabs.map((t) => {
    const base = [{ page: `tab:${t.id}`, sel: 0 }];
    const deep = params.get("page");
    return deep && t.id === (params.get("tab") ?? "tweaker") ? [...base, ...deep.split(",").map((p) => ({ page: p, sel: 0 }))] : base;
  }));
  const [popup, setPopup] = useState<Popup>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [flashIid, setFlashIid] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const changePaths = useRef(new Map<string, string>());
  const valsRef = useRef<Values>(vals);
  valsRef.current = vals;
  const listRef = useRef<HTMLDivElement>(null);
  const ai = useRef<AiPanelHandle>(null);

  // one clock drives the header, the date/time rows and the simulated sensors
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(t); }, []);
  const readings = useMemo(() => computeReadings(hw, vals, handles, now.getTime() / 1000), [hw, vals, handles, now]);

  const stack = stacks[tab];
  const frame = stack[stack.length - 1];
  const page = book.get(frame.page);
  const rows = useMemo(() => viewRows(schema, page, vals, showHidden, lock), [schema, page, vals, showHidden, lock]);
  const selectable = rows.map(isSelectable);
  const sel = Math.min(frame.sel, rows.length - 1);
  const cur: RowView | undefined = rows[sel];
  const curItem: Item | undefined = cur?.item;
  const curIid = cur && "iid" in cur.row ? cur.row.iid : undefined;
  const breadcrumb = [layout.tabs[tab].title, ...stack.slice(1).map((f) => book.get(f.page).title)];

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2600); };

  const setFrame = useCallback((patch: Partial<Frame>) => {
    setStacks((s) => s.map((st, i) => (i === tab ? [...st.slice(0, -1), { ...st[st.length - 1], ...patch }] : st)));
  }, [tab]);
  const push = (pageId: string) => setStacks((s) => s.map((st, i) => (i === tab ? [...st, { page: pageId, sel: 0 }] : st)));
  const pop = () => setStacks((s) => s.map((st, i) => (i === tab && st.length > 1 ? st.slice(0, -1) : st)));

  useEffect(() => {
    if (rows.length && !selectable[sel]) {
      const n = selectable.findIndex(Boolean);
      if (n >= 0 && n !== sel) setFrame({ sel: n });
    }
  }, [rows, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, frame.page]);

  const move = (d: number) => {
    let n = sel;
    for (let k = 0; k < rows.length; k++) { n = (n + d + rows.length) % rows.length; if (selectable[n]) break; }
    setFrame({ sel: n });
  };

  const setValue = (it: Item, v: number, path?: string) => {
    const k = vkey(it);
    setVals((m) => { const n = new Map(m); n.set(k, v); return n; });
    changePaths.current.set(k, path ?? [...breadcrumb, it.prompt?.trim() ?? ""].join(" › "));
  };

  const cycle = (it: Item, d: number) => {
    const v = vals.get(vkey(it)) ?? 0;
    if (it.kind === "oneof") {
      const opts = visibleOptions(it, vals);
      const i = opts.findIndex((o) => o.value === v);
      const n = opts[(i + d + opts.length) % opts.length];
      if (n) setValue(it, n.value);
    } else if (it.kind === "checkbox") setValue(it, v ? 0 : 1);
    else if (it.kind === "numeric") {
      const sr = sanityFor(it);
      const step = sr ? Math.max(1, Math.round(sr.step * sanityScale(sr))) : it.step || 1;
      const r = rangeOf(it);
      setValue(it, encodeNumeric(it, Math.max(r.min, Math.min(r.max, decodeNumeric(it, v) + d * step))));
    }
  };

  const anchorFor = (rowIndex: number): Anchor => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${rowIndex}"] .value`);
    const r = el?.getBoundingClientRect();
    return r ? { top: r.bottom + 2, left: r.left - 8, width: Math.max(260, r.width) } : { top: 200, left: 600, width: 300 };
  };

  const activate = (rv: RowView | undefined, rowIndex: number) => {
    if (!rv) return;
    const r = rv.row;
    if (r.type === "link") return push(r.page);
    if (r.type === "action") { if (r.action === "search") setPopup({ kind: "search", q: "", sel: 0 }); return; }
    if (!rv.item || !isEditable(rv)) {
      if (rv.lock) flash(rv.lock);
      else if (rv.grayed) flash("This option is locked by another setting. See \"Depends on\" or ask the AI.");
      return;
    }
    const it = rv.item;
    const iid = (r as { iid: string }).iid;
    if (it.kind === "oneof") {
      const opts = visibleOptions(it, vals);
      setPopup({ kind: "options", iid, sel: Math.max(0, opts.findIndex((o) => o.value === vals.get(vkey(it)))), anchor: anchorFor(rowIndex) });
    } else if (it.kind === "checkbox") cycle(it, 1);
    else if (it.kind === "numeric") {
      const n = decodeNumeric(it, vals.get(vkey(it)) ?? 0);
      const sr = sanityFor(it);
      const text = sr && sr.unit === "V" && sr.store === "mV" ? (n === 0 ? "Auto" : (n / 1000).toFixed(3)) : String(n);
      setPopup({ kind: "numeric", iid, text, anchor: anchorFor(rowIndex) });
    }
  };

  const changes: Change[] = useMemo(() => {
    const out: Change[] = [];
    for (const [k, v] of vals) {
      const was = saved.get(k);
      if (was === v) continue;
      const it = qidx.get(k);
      if (!it) continue;
      const show = (x: number | undefined) => displayValue(it, new Map([[k, x ?? 0]]), zeroAuto);
      out.push({ key: k, iid: keyToIid.get(k) ?? "", path: changePaths.current.get(k) ?? it.prompt ?? k, prompt: it.prompt ?? k, from: show(was), to: show(v) });
    }
    return out;
  }, [vals, saved, qidx, zeroAuto, keyToIid]);

  // ---- navigation to an item (search results, AI "show me" chips) ----------------
  const gotoItem = (iid: string) => {
    const it = schema.items[iid];
    if (!it) return;
    const loc = book.locate(iid);
    const t = loc ? loc.tab : tab;
    const pages = loc ? loc.pages : [`tab:${layout.tabs[tab].id}`, `form:${it.form}`];
    const target = book.get(pages[pages.length - 1]);
    let rv = viewRows(schema, target, vals, showHidden, lock);
    let n = rv.findIndex((r) => "iid" in r.row && r.row.iid === iid);
    if (n < 0) {
      setShowHidden(true);
      rv = viewRows(schema, target, vals, true, lock);
      n = rv.findIndex((r) => "iid" in r.row && r.row.iid === iid);
      flash("This option is hidden with the current settings, so hidden options are now shown.");
    }
    setMode("advanced");
    setTab(t);
    setStacks((s) => s.map((st, i) => (i === t ? pages.map((p, j) => ({ page: p, sel: j === pages.length - 1 ? Math.max(0, n) : 0 })) : st)));
    setFlashIid(iid);
    window.setTimeout(() => setFlashIid(null), 2400);
    setPopup(null);
  };

  const searchHits = useMemo(() => {
    if (popup?.kind !== "search" || popup.q.trim().length < 2) return [];
    const q = popup.q.toLowerCase();
    const hits: { iid: string; it: Item; path: string[] | null; inName: boolean }[] = [];
    for (const [iid, it] of Object.entries(schema.items)) {
      if (!it.prompt || it.kind === "subtitle" || it.default_visibility === "hidden") continue;
      const inName = it.prompt.toLowerCase().includes(q);
      if (inName || (it.help ?? "").toLowerCase().includes(q)) hits.push({ iid, it, path: tutor.pathOf(iid), inName });
    }
    // name matches first, then the most accessible menu location (same-named options exist,
    // e.g. system Fast Boot on Boot vs. memory Fast Boot deep in Tweaker)
    const rank = (h: (typeof hits)[number]) => (h.inName ? 0 : 100) + (h.path ? h.path.length : 50);
    return hits.sort((a, b) => rank(a) - rank(b)).slice(0, 60);
  }, [popup, schema, tutor]);

  const askAbout = (iid: string) => {
    const it = schema.items[iid];
    ai.current?.ask(`What does "${it.prompt?.trim()}" do, and when should I change it?`, iid);
  };

  const getContext = () => ({
    hardware: describeHw(hw),
    readings: readingsSummary(readings),
    page_path: breadcrumb.join(" › ") + (curItem?.prompt ? ` › ${curItem.prompt.trim()}` : ""),
    changes: changes.map((c) => {
      const it = schema.items[c.iid];
      const sr = it ? sanityFor(it) : undefined;
      const chk = sr ? sanityCheck(sr, decodeNumeric(it, vals.get(vkey(it)) ?? 0)) : null;
      return { iid: c.iid, path: c.path, from: c.from, to: c.to + (chk && chk.level !== "ok" ? ` [SANITY WARNING: ${chk.message}]` : "") };
    }),
  });

  // ---- keyboard --------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key;
      if (popup) {
        if (k === "Escape") { setPopup(null); e.preventDefault(); return; }
        if (popup.kind === "options") {
          const it = schema.items[popup.iid];
          const opts = visibleOptions(it, vals);
          if (k === "ArrowDown") setPopup({ ...popup, sel: (popup.sel + 1) % opts.length });
          else if (k === "ArrowUp") setPopup({ ...popup, sel: (popup.sel - 1 + opts.length) % opts.length });
          else if (k === "Enter") { setValue(it, opts[popup.sel].value); setPopup(null); }
          else return;
          e.preventDefault();
        } else if (popup.kind === "numeric" && k === "Enter") {
          const it = schema.items[popup.iid];
          const t = popup.text.trim().toLowerCase();
          const r = rangeOf(it);
          const sr = sanityFor(it);
          if (sr) {
            const sv = sanityParse(sr, popup.text);
            const chk = sv === null ? null : sanityCheck(sr, sv);
            if (sv === null) setPopup({ ...popup, error: sr.unit === "V" ? "Type a voltage like 1.350 (volts) or 1350 (mV), or Auto." : `Type a whole number in ${sr.unit}, or Auto.` });
            else if (chk!.level === "hard" || (r.capped && sv > r.max)) setPopup({ ...popup, error: r.capped && sv > r.max ? `Enter a value from 0 to ${r.max}` : `Sanity check: ${chk!.message}` });
            else {
              setValue(it, encodeNumeric(it, sv)); setPopup(null);
              if (chk!.level === "warn") flash(`⚠ Sanity check: ${chk!.message} (emulator estimate, not the real BIOS limit)`);
            }
            e.preventDefault();
            return;
          }
          const v = t === "auto" ? 0 : it.display === "hex" || t.startsWith("0x") ? parseInt(t.replace(/^0x/, ""), 16) : parseInt(t, 10);
          const autoOk = t === "auto" || (v === 0 && zeroAuto);
          if (Number.isNaN(v) || (!autoOk && (v < r.min || v > r.max))) setPopup({ ...popup, error: `Enter a value from ${r.min} to ${r.max}${it.range_hint?.unit ? ` (${it.range_hint.unit === "mΩ" ? "1/100 mΩ" : it.range_hint.unit})` : ""}` });
          else { setValue(it, encodeNumeric(it, v)); setPopup(null); }
          e.preventDefault();
        } else if (popup.kind === "search") {
          if (k === "ArrowDown") { setPopup({ ...popup, sel: Math.min(popup.sel + 1, searchHits.length - 1) }); e.preventDefault(); }
          else if (k === "ArrowUp") { setPopup({ ...popup, sel: Math.max(popup.sel - 1, 0) }); e.preventDefault(); }
          else if (k === "Enter" && searchHits[popup.sel]) { gotoItem(searchHits[popup.sel].iid); e.preventDefault(); }
        } else if ((popup.kind === "save" || popup.kind === "defaults") && k === "Enter") {
          if (popup.kind === "save") { setSaved(new Map(vals)); flash("Saved (emulated). Nothing is written to real hardware."); }
          else { setVals(new Map(baseline)); flash("Optimized defaults loaded."); }
          setPopup(null);
          e.preventDefault();
        }
        return;
      }
      if (tag === "INPUT") return;
      if (k === "F2") { setMode((m) => (m === "easy" ? "advanced" : "easy")); e.preventDefault(); return; }
      if (mode === "easy") return;
      if (k === "ArrowDown") move(1);
      else if (k === "ArrowUp") move(-1);
      else if (k === "ArrowRight" && stack.length === 1) setTab((t) => (t + 1) % layout.tabs.length);
      else if (k === "ArrowLeft" && stack.length === 1) setTab((t) => (t - 1 + layout.tabs.length) % layout.tabs.length);
      else if (k === "Enter") activate(cur, sel);
      else if (k === "Escape" || k === "Backspace") pop();
      else if ((k === "+" || k === "PageUp") && curItem && cur && isEditable(cur)) cycle(curItem, 1);
      else if ((k === "-" || k === "PageDown") && curItem && cur && isEditable(cur)) cycle(curItem, -1);
      else if (k === "F7") setPopup({ kind: "defaults" });
      else if (k === "F10") setPopup({ kind: "save" });
      else if (k === "F11") setTab(0);
      else if (k === "F1" && curIid && curItem) askAbout(curIid);
      else if (k === "f" && e.altKey) setPopup({ kind: "search", q: "", sel: 0 });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectedCard = curItem && curIid ? {
    iid: curIid, item: curItem,
    details: <OptionDetails item={curItem} rv={cur!} qidx={qidx} vals={vals} zeroAuto={zeroAuto} />,
  } : undefined;

  return (
    <div className="bios">
      <header className="top">
        <div className="brand">BIOS<span>·</span>AI <small>{String(schema.meta.board_string ?? "")} · BIOS {String(schema.meta.source_file ?? "").split(".").pop()}</small>
          <span className="disclaimer">Unofficial learning emulator. Not affiliated with GIGABYTE. Nothing here changes real hardware.</span></div>
        <div className="modes">
          <button className={mode === "easy" ? "mode on" : "mode"} onClick={() => setMode("easy")}>EASY MODE</button>
          <button className={mode === "advanced" ? "mode on" : "mode"} onClick={() => setMode("advanced")}>ADVANCED MODE</button>
        </div>
        <Clock now={now} />
      </header>

      <div className="workspace">
        <div className="left">
          {mode === "easy" ? (
            <EasyMode schema={schema} vals={vals} hw={hw} readings={readings} zeroAuto={zeroAuto} lock={lock}
              onSet={(it, v) => setValue(it, v, `Easy Mode › ${it.prompt?.trim()}`)} onAsk={askAbout} onAdvanced={() => setMode("advanced")}
              onSave={() => setPopup({ kind: "save" })} onDefaults={() => setPopup({ kind: "defaults" })}
              onSearch={() => setPopup({ kind: "search", q: "", sel: 0 })} keyToIid={keyToIid} />
          ) : (
            <>
              <nav className="tabs">
                {layout.tabs.map((t, i) => (
                  <button key={t.id} className={i === tab ? "tab on" : "tab"} onClick={() => setTab(i)}>
                    <Icon name={t.icon} /> {t.title}
                  </button>
                ))}
              </nav>
              <main className="body">
                <section className="menu">
                  <div className="crumbs">{breadcrumb.join("  ›  ")}{stack.length > 1 && <button className="back" onClick={pop}>Esc · Back</button>}</div>
                  <div className="list" ref={listRef}>
                    {rows.map((rv, i) => (
                      <MenuRow key={`${frame.page}-${i}`} i={i} rv={rv} selected={i === sel} vals={vals} saved={saved} zeroAuto={zeroAuto} now={now}
                        flash={"iid" in rv.row && rv.row.iid === flashIid}
                        onSelect={() => selectable[i] && setFrame({ sel: i })}
                        onActivate={() => { if (selectable[i]) setFrame({ sel: i }); activate(rv, i); }}
                        onAsk={() => {
                          const iid = "iid" in rv.row ? rv.row.iid : undefined;
                          if (iid && rv.row.type !== "link") askAbout(iid);
                          else if (rv.row.type === "link") ai.current?.ask(`What is the "${rv.row.label}" menu for, and which settings in it matter most?`, iid);
                        }} />
                    ))}
                    {!rows.length && <div className="empty">No visible options on this page with the current settings.</div>}
                  </div>
                  <div className="helpline">{cur?.lock ?? (curItem?.help && curItem.help !== "N/A" ? curItem.help : cur?.row.type === "link" ? `Open ${cur.row.label}` : "")}</div>
                </section>
                <Monitor hw={hw} hwSel={hwSel} onHw={updateHw} r={readings} warnings={hardwareWarnings(hw)} ucode={ucode}
                  showHidden={showHidden} onShowHidden={setShowHidden} pending={changes.length} />
              </main>
              <footer className="foot">
                <span className="keys">↑↓ Select · Enter Change · +/- Adjust · Esc Back · ←→ Tabs · F1 Ask AI · F7 Defaults · F10 Save · Alt+F Search · F2 Easy</span>
                <button onClick={() => setPopup({ kind: "search", q: "", sel: 0 })}><Icon name="search" /> Search</button>
                <button onClick={() => setPopup({ kind: "save" })}><Icon name="exit" /> Save & Exit (F10)</button>
              </footer>
            </>
          )}
        </div>
        <AiPanel ref={ai} schema={schema} tutor={tutor} getContext={getContext} selected={mode === "advanced" ? selectedCard : undefined} onGoto={gotoItem} />
      </div>

      {popup?.kind === "options" && (() => {
        const it = schema.items[popup.iid];
        const opts = visibleOptions(it, vals);
        const top = Math.max(8, Math.min(popup.anchor.top, window.innerHeight - 16 - Math.min(opts.length, 12) * 34));
        return (
          <div className="scrim clear" onClick={() => setPopup(null)}>
            <ul className="dropdown" style={{ top, left: popup.anchor.left, minWidth: popup.anchor.width }} onClick={(e) => e.stopPropagation()}>
              {opts.map((o, i) => (
                <li key={o.value} className={i === popup.sel ? "on" : ""} onMouseEnter={() => setPopup({ ...popup, sel: i })}
                  onClick={() => { setValue(it, o.value); setPopup(null); }}>
                  <span className="tick">{vals.get(vkey(it)) === o.value ? "●" : ""}</span>{o.label}{o.default && <em> default</em>}
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {popup?.kind === "numeric" && (() => {
        const it = schema.items[popup.iid];
        return (
          <div className="scrim clear" onClick={() => setPopup(null)}>
            <div className="dropdown numedit" style={{ top: popup.anchor.top, left: popup.anchor.left, minWidth: popup.anchor.width }} onClick={(e) => e.stopPropagation()}>
              <input autoFocus className="num" value={popup.text} onChange={(e) => setPopup({ ...popup, text: e.target.value, error: undefined })} />
              {(() => {
                const r = rangeOf(it);
                const unit = it.range_hint?.unit === "mΩ" ? " (1/100 mΩ)" : it.range_hint?.unit ? ` ${it.range_hint.unit}` : "";
                const sr = sanityFor(it);
                if (sr) return (
                  <div className="muted range-note sanity">
                    <b>Sanity check (emulator estimate, not the real BIOS limit):</b> {sanitySummary(sr)}{r.capped ? ` · ceiling ${r.max} documented by GIGABYTE` : ""}.
                    {" "}{sr.unit === "V" ? "Type volts (1.350) or millivolts (1350). " : ""}0 = Auto. {sr.basis}{" "}
                    {sr.source.url ? <a href={sr.source.url} target="_blank" rel="noreferrer">Source: {sr.source.title}</a> : <span>Source: {sr.source.title}</span>}
                    <RefNote it={it} />
                  </div>
                );
                return it.range_unknown && !r.fromHelp
                  ? <div className="muted range-note">This BIOS's menu data doesn't define a range for this option{unit ? `; unit:${unit}` : ""}. The real BIOS screen accepts the same 0–65535; the CPU and voltage regulator enforce the physical limits. 0 = Auto.<RefNote it={it} /></div>
                  : <div className="muted">Range {r.min} to {r.max}{unit}{zeroAuto && (it.min ?? 0) === 0 ? " · 0 = Auto" : ""}{r.fromHelp ? " · from the option's help text" : ""}{r.capped ? " · ceiling documented by GIGABYTE" : ""} · Enter to apply<RefNote it={it} /></div>;
              })()}
              {popup.error && <div className="err">{popup.error}</div>}
            </div>
          </div>
        );
      })()}

      {popup?.kind === "search" && (
        <Modal title="Option Search" onClose={() => setPopup(null)} wide>
          <input autoFocus className="num" placeholder="Type a setting name, e.g. XMP, ratio, C-State…" value={popup.q}
            onChange={(e) => setPopup({ ...popup, q: e.target.value, sel: 0 })} />
          <ul className="opts hits">
            {searchHits.map((h, i) => (
              <li key={h.iid} className={i === popup.sel ? "on" : ""} onClick={() => gotoItem(h.iid)}>
                {h.it.prompt} <small>{h.path ? h.path.join(" › ") : `${schema.forms[h.it.form]?.title} (hidden menu)`}</small>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {popup?.kind === "save" && (
        <Modal title="Save & Exit Setup" onClose={() => setPopup(null)} wide>
          {changes.length ? (
            <>
              <p>These changes will be saved in the emulator only. Apply the same changes on your real board:</p>
              <table className="changes"><tbody>
                {changes.map((c) => <tr key={c.key}><td>{c.path}</td><td>{c.from}</td><td>→</td><td className="to">{c.to}</td></tr>)}
              </tbody></table>
              <button className="export" onClick={() => navigator.clipboard?.writeText(changes.map((c) => `${c.path}: ${c.from} -> ${c.to}`).join("\n")).then(() => flash("Change list copied"), () => flash("Couldn't copy here. Select the table text instead."))}>Copy change list</button>
            </>
          ) : <p>No changes to save.</p>}
          <p className="muted">Enter = Save · Esc = Cancel</p>
        </Modal>
      )}

      {popup?.kind === "defaults" && (
        <Modal title="Load Optimized Defaults" onClose={() => setPopup(null)}>
          <p>Reset every option to its factory default?</p>
          <p className="muted">Enter = Yes · Esc = No</p>
        </Modal>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function MenuRow({ i, rv, selected, vals, saved, zeroAuto, now, flash, onSelect, onActivate, onAsk }: {
  i: number; rv: RowView; selected: boolean; vals: Values; saved: Values; zeroAuto: boolean; now: Date; flash: boolean;
  onSelect: () => void; onActivate: () => void; onAsk: () => void;
}) {
  const r = rv.row;
  const cls = ["row", selected ? "sel" : "", rv.grayed ? "grey" : "", rv.hidden ? "hid" : "", flash ? "flash" : "", rv.indent ? "indent" : ""].join(" ");
  const ask = <button className="ask" title="Ask AI about this" onClick={(e) => { e.stopPropagation(); onAsk(); }}>✦ Ask AI</button>;
  if (r.type === "subtitle") return <div data-row={i} className={`row sub ${r.accent ? "accent" : ""}`}>{r.text}</div>;
  if (r.type === "link") return <div data-row={i} className={cls} onClick={onSelect} onDoubleClick={onActivate}><span className="bullet" /><span className="label">{r.label}</span><span /><span />{ask}</div>;
  if (r.type === "action") return <div data-row={i} className={cls} onClick={onSelect} onDoubleClick={onActivate}><span className="label">{r.label}</span></div>;
  const it = rv.item!;
  let v = displayValue(it, vals, zeroAuto);
  if (it.kind === "date") v = now.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", weekday: "short" });
  if (it.kind === "time") v = now.toLocaleTimeString("en-GB");
  const editable = isEditable(rv);
  const changed = it.question_id !== undefined && vals.get(vkey(it)) !== saved.get(vkey(it));
  const sr = sanityFor(it);
  const sanityWarn = sr && it.question_id !== undefined ? (() => { const c = sanityCheck(sr, decodeNumeric(it, vals.get(vkey(it)) ?? 0)); return c.level === "ok" ? "" : `Sanity check: ${c.message}`; })() : "";
  return (
    <div data-row={i} className={cls} onClick={onSelect} onDoubleClick={onActivate} title={rv.lock ?? (rv.hidden ? "Hidden on real hardware with these settings" : undefined)}>
      <span className="label">{it.prompt}</span>
      <span className="star">{changed ? "★" : ""}</span>
      <span className={editable ? "value editable" : "value"} onClick={(e) => { e.stopPropagation(); onActivate(); }}>
        {rv.lock && "🔒 "}{sanityWarn && <span className="sanity-flag" title={sanityWarn}>⚠ </span>}{v}{editable && (it.kind === "oneof" || it.kind === "checkbox") && <span className="caret">▾</span>}
      </span>
      {ask}
    </div>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={open ? "msec open" : "msec"}>
      <button className="msec-head" onClick={() => setOpen((o) => !o)}><span>{open ? "▾" : "▸"}</span> {title}</button>
      {open && <div className="msec-body">{children}</div>}
    </div>
  );
}

type PartItem = { id: string; name: string; group?: string; series?: string };
interface PartSelectProps { value: string; items: PartItem[]; onChange: (id: string) => void; label: string; half?: boolean }

/** Native dropdown; items with a group (or series) are shown under <optgroup> headings.
 *  Memoized on value/items: the page re-renders every second (clock, live readings), and
 *  React re-applying `selected` to the options would close an open dropdown list. */
const PartSelect = memo(PartSelectInner, (a, b) => a.value === b.value && a.items === b.items && a.half === b.half && a.label === b.label);

function PartSelectInner({ value, items, onChange, label, half }: PartSelectProps) {
  type T = PartItem;
  const groups: { name?: string; items: T[] }[] = [];
  for (const p of items) {
    const gname = p.group ?? p.series;
    const last = groups[groups.length - 1];
    if (last && last.name === gname) last.items.push(p); else groups.push({ name: gname, items: [p] });
  }
  const opts = (list: T[]) => list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>);
  return (
    <select className={half ? "part half" : "part"} aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((gr, i) => gr.name ? <optgroup key={i} label={gr.name}>{opts(gr.items)}</optgroup> : opts(gr.items))}
    </select>
  );
}

function Monitor({ hw, hwSel, onHw, r, warnings, showHidden, onShowHidden, pending, ucode }: {
  hw: Hw; hwSel: HwSel; onHw: (p: Partial<HwSel>) => void; r: Readings; warnings: string[]; ucode: Set<string> | null;
  showHidden: boolean; onShowHidden: (v: boolean) => void; pending: number;
}) {
  const stat = (label: string, value: string, unit = "", sub?: string) => (
    <div className="stat"><dt>{label}</dt><dd>{value}<small>{unit}</small>{sub && <i>{sub}</i>}</dd></div>
  );
  return (
    <aside className="monitor">
      <Section title="CPU">
        <PartSelect label="CPU" value={hwSel.cpu} items={CPUS as PartItem[]} onChange={(id) => onHw({ cpu: id })} />
        <dl className="grid2">
          {stat("Frequency", r.cpuMHz.toFixed(2), "MHz", r.eMHz.toFixed(2))}
          {stat("BCLK", r.bclk.toFixed(2), "MHz")}
          {stat("Temperature", r.cpuTemp.toFixed(1), "°C")}
          {stat("P/E-core Voltage", r.vcore.toFixed(3), "V")}
        </dl>
        <p className="spec">{hw.cpu.pCores}P + {hw.cpu.eCores}E cores · {hw.cpu.unlocked ? "Unlocked" : "Locked multiplier"} · {hw.cpu.igpu ? "iGPU" : "No iGPU"}</p>
        {ucode && hw.cpu.model && <p className={ucode.has(hw.cpu.model) ? "spec ok" : "warn"}>{ucode.has(hw.cpu.model) ? `✓ This BIOS has microcode for this CPU family (${hw.cpu.model})` : `⚠ No microcode for CPU model ${hw.cpu.model} in this BIOS: it may not boot. Update the BIOS first.`}</p>}
      </Section>
      <Section title="Memory">
        <div className="pair">
          <PartSelect half label="Memory capacity" value={hwSel.memSize} items={MEM_SIZES} onChange={(id) => onHw({ memSize: id })} />
          <PartSelect half label="Memory frequency" value={hwSel.memSpeed} items={MEM_SPEEDS} onChange={(id) => onHw({ memSpeed: id })} />
        </div>
        <dl className="grid2">
          {stat("Frequency", r.memMTs.toFixed(2), "MT/s")}
          {stat("Size", String(hw.mem.sizeGB * 1024), "MB")}
          {stat("DRAM Voltage", r.memV.toFixed(3), "V")}
          {stat("Timings", r.memTimings)}
        </dl>
        <ul className="slots">{dimmSlots(hw.mem).map((s) => <li key={s.slot}><span>{s.slot}</span>{s.dimm}</li>)}</ul>
      </Section>
      <Section title="Storage">
        <div className="pair">
          <PartSelect half label="Drive type" value={hwSel.ssdType} items={SSD_TYPES} onChange={(id) => onHw({ ssdType: id })} />
          <PartSelect half label="Drive capacity" value={hwSel.ssdSize} items={SSD_SIZES} onChange={(id) => onHw({ ssdSize: id })} />
        </div>
        <p className="spec">{hw.ssd.iface} · {hw.ssd.slot}</p>
      </Section>
      <Section title="Graphics">
        <PartSelect label="Graphics card" value={hwSel.gpu} items={GPUS} onChange={(id) => onHw({ gpu: id })} />
        <p className="spec">{hw.gpu.vendor === "None" ? (hw.cpu.igpu ? "Display from CPU integrated graphics" : "No display device!") : `PCIEX16 · ${gpuLink(hw.gpu)}`}</p>
      </Section>
      <Section title="Voltages & Fans" defaultOpen={false}>
        <dl className="grid2">
          {stat("+5V", r.v5.toFixed(3), "V")}
          {stat("+12V", r.v12.toFixed(3), "V")}
          {stat("VCCSA", r.vccsa.toFixed(3), "V")}
          {stat("System Temp", r.sysTemp.toFixed(1), "°C")}
          {stat("CPU_FAN", String(r.cpuFanRpm), "RPM")}
          {stat("CPU_OPT", String(r.optFanRpm), "RPM")}
        </dl>
      </Section>
      {warnings.map((w) => <p key={w} className="warn">⚠ {w}</p>)}
      <p className="sim">Readings are simulated from the selected parts and your settings.</p>
      <label className="toggle"><input type="checkbox" checked={showHidden} onChange={(e) => onShowHidden(e.target.checked)} /> Show hidden options</label>
      <div className="pending">{pending ? `${pending} unsaved change${pending > 1 ? "s" : ""}` : "No unsaved changes"}</div>
    </aside>
  );
}

function OptionDetails({ item, rv, qidx, vals, zeroAuto }: { item: Item; rv: RowView; qidx: ReturnType<typeof buildQIndex>; vals: Values; zeroAuto: boolean }) {
  return (
    <div className="explain">
      {item.help && item.help !== "N/A" && <p>{item.help}</p>}
      <dl>
        <dt>Type</dt><dd>{item.kind}{item.kind === "numeric" ? (() => {
          const r = numericRange(item);
          const unit = item.range_hint?.unit === "mΩ" ? " (1/100 mΩ)" : item.range_hint?.unit ? ` ${item.range_hint.unit}` : "";
          const sr = sanityFor(item);
          if (sr) return `, sanity check: ${sanitySummary(sr)} (emulator estimate)`;
          return item.range_unknown && !r.fromHelp ? `, range not defined in the BIOS menu data${unit ? `, unit${unit}` : ""}` : ` (${r.min} to ${r.max}${unit})`;
        })() : ""}</dd>
        {item.default !== undefined && <><dt>Default</dt><dd>{displayValue(item, new Map([[vkey(item), item.default]]), zeroAuto)}</dd></>}
        {item.varstore && <><dt>Stored in</dt><dd><code>{item.varstore}</code> +0x{item.offset?.toString(16).toUpperCase()}</dd></>}
        {item.flags?.includes("reset_required") && <><dt>Note</dt><dd>Needs a reboot</dd></>}
      </dl>
      {item.kind === "oneof" && <p className="muted">Choices: {visibleOptions(item, vals).map((o) => o.label).join(" · ")}</p>}
      {rv.lock && <p className="warn">🔒 {rv.lock}</p>}
      <RefNote it={item} />
      {(item.conditions?.length ?? 0) > 0 && (
        <details>
          <summary>Depends on ({rv.hidden ? "hidden now" : rv.grayed ? "locked now" : "available now"})</summary>
          <ul className="deps">{explainItem(item, qidx).map((l, i) => <li key={i}>{l}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Sourced limit/reference value for an option, with a link to its source. */
function RefNote({ it }: { it: Item }) {
  const r = refFor(it);
  if (!r) return null;
  return (
    <span className={r.kind === "enforce" ? "ref-note enforce" : "ref-note"}>
      <b>{r.kind === "enforce" ? "Documented limit: " : "Reference (not a BIOS limit): "}</b>{r.note}{" "}
      <a href={r.source.url} target="_blank" rel="noreferrer">Source: {r.source.title}</a>
    </span>
  );
}

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className={wide ? "modal wide" : "modal"} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}<button onClick={onClose}>×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Clock({ now }: { now: Date }) {
  return (
    <div className="clock">
      <div><div>{now.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}</div><div>{now.toLocaleDateString("en-US", { weekday: "long" })}</div></div>
      <b>{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}<span className="secs">:{String(now.getSeconds()).padStart(2, "0")}</span></b>
    </div>
  );
}
