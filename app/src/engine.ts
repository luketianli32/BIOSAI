// BIOS emulator engine: values, IFR condition evaluation, page building.
// Mirrors biosai/schema/build.py (evaluate / initial_values) so the browser
// and the Python pipeline agree on what is visible.
import type { Expr, Item, Layout, Profile, Row, Schema, Page, LayoutEntry } from "./types";
import { sanityFor, sanityFormat, sanityStoredRange } from "./refs";

export const UNKNOWN = Symbol("unknown");
type V = number | boolean | typeof UNKNOWN;

export type Values = Map<string, number>; // key `${formset}:${qid}`

export const fsOf = (it: Item) => it.form.split(":")[0];
export const vkey = (it: Item) => `${fsOf(it)}:${it.question_id}`;

export function initialValues(schema: Schema, profile?: Profile): Values {
  const vals: Values = new Map();
  const vsDefaults = profile?.varstore_defaults ?? {};
  const overrides = profile?.values ?? {};
  for (const it of Object.values(schema.items)) {
    if (it.question_id === undefined) continue;
    const k = vkey(it);
    const vs = it.varstore;
    const ov = vs ? overrides[vs]?.[String(it.offset)] : undefined;
    if (ov !== undefined) { vals.set(k, ov); continue; }
    if (vs && vs in vsDefaults) { vals.set(k, vsDefaults[vs]); continue; }
    let v = it.default;
    if (v === undefined && it.kind === "oneof" && it.options?.length) v = it.options[0].value;
    if (v === undefined && it.kind === "numeric") v = it.min ?? 0;
    if (v !== undefined && !vals.has(k)) vals.set(k, v);
  }
  return vals;
}

export function evaluate(e: Expr | undefined | null, fs: string, vals: Values): V {
  if (!e) return UNKNOWN;
  const q = (id: number): V => { const v = vals.get(`${fs}:${id}`); return v === undefined ? UNKNOWN : v; };
  switch (e.op) {
    case "const": return e.v as number;
    case "eq": { const v = q(e.q!); return v === UNKNOWN ? UNKNOWN : v === e.v; }
    case "in": { const v = q(e.q!); return v === UNKNOWN ? UNKNOWN : (e.v as number[]).includes(v as number); }
    case "eq_qq": { const a = q(e.q!), b = q(e.q2!); return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a === b; }
    case "qref": return q(e.q!);
  }
  const args = (e.args ?? []).map((a) => evaluate(a, fs, vals));
  if (e.op === "not") return args[0] === UNKNOWN ? UNKNOWN : !args[0];
  if (e.op === "and") {
    if (args.some((a) => a !== UNKNOWN && !a)) return false;
    return args.includes(UNKNOWN) ? UNKNOWN : true;
  }
  if (e.op === "or") {
    if (args.some((a) => a !== UNKNOWN && !!a)) return true;
    return args.includes(UNKNOWN) ? UNKNOWN : false;
  }
  if (!args.length || args.includes(UNKNOWN)) return UNKNOWN;
  const [a, b, c] = args as number[];
  switch (e.op) {
    case "equal": return a === b;
    case "not_equal": return a !== b;
    case "greater_than": return a > b;
    case "greater_equal": return a >= b;
    case "less_than": return a < b;
    case "less_equal": return a <= b;
    case "bitwise_and": return Number(a) & Number(b);
    case "bitwise_or": return Number(a) | Number(b);
    case "add": return a + b;
    case "subtract": return a - b;
    case "multiply": return a * b;
    case "divide": return b ? Math.floor(a / b) : UNKNOWN;
    case "modulo": return b ? a % b : UNKNOWN;
    case "shift_left": return a << b;
    case "shift_right": return a >> b;
    case "to_boolean": return !!a;
    case "to_uint": return Number(a);
    case "conditional": return a ? b : c;
  }
  return UNKNOWN;
}

export interface CondState { hidden: boolean; uncertain: boolean; grayed: boolean }

export function condState(conds: Item["conditions"], fs: string, vals: Values): CondState {
  const st: CondState = { hidden: false, uncertain: false, grayed: false };
  for (const c of conds ?? []) {
    const r = evaluate(c.expr, fs, vals);
    const isHide = c.type === "suppress" || c.type === "disable";
    if (r === UNKNOWN) { if (isHide) st.uncertain = true; continue; }
    if (r) { if (isHide) st.hidden = true; else st.grayed = true; }
  }
  return st;
}

// ---- numeric ranges ------------------------------------------------------------
/** The range a numeric option really accepts: from its help text when the firmware
 *  states one there, otherwise the IFR range. Signed when the help text says so. */
export function numericRange(it: Item): { min: number; max: number; signed: boolean; fromHelp: boolean; sanity: boolean } {
  const h = it.range_hint;
  if (h?.min !== undefined && h.max !== undefined) return { min: h.min, max: h.max, signed: h.min < 0, fromHelp: true, sanity: false };
  const s = sanityFor(it);
  if (s) {
    const r = sanityStoredRange(s);
    // 0 stays reachable: it means Auto on this board
    return { min: Math.min(r.min, 0), max: r.max, signed: !!s.signed, fromHelp: false, sanity: true };
  }
  return { min: it.min ?? 0, max: it.max ?? 0xFFFF, signed: false, fromHelp: false, sanity: false };
}
/** Stored (unsigned) value -> number the user sees, for signed ranges (two's complement). */
export function decodeNumeric(it: Item, v: number): number {
  const r = numericRange(it);
  const bits = 8 * (it.size ?? 2);
  return r.signed && v >= 2 ** (bits - 1) ? v - 2 ** bits : v;
}
export function encodeNumeric(it: Item, v: number): number {
  const bits = 8 * (it.size ?? 2);
  return v < 0 ? v + 2 ** bits : v;
}
export function formatNumeric(it: Item, v: number): string {
  const h = it.range_hint;
  const n = decodeNumeric(it, v);
  const sr = sanityFor(it);
  if (sr) return sanityFormat(sr, n);
  const signed = numericRange(it).signed;
  if (h?.unit === "mΩ" && h.scale) return `${(n * h.scale).toFixed(2)} mΩ`;
  const s = signed && n > 0 ? `+${n}` : String(n);
  return h?.unit ? `${s} ${h.unit}` : s;
}

// ---- value display -----------------------------------------------------------
export function displayValue(it: Item, vals: Values, zeroAuto: boolean): string {
  if (it.question_id === undefined) return it.text_two ?? "";
  const v = vals.get(vkey(it));
  if (v === undefined) return "";
  switch (it.kind) {
    case "oneof": return it.options?.find((o) => o.value === v)?.label ?? `0x${v.toString(16)}`;
    case "checkbox": return v ? "Enabled" : "Disabled";
    case "numeric":
      if (it.min !== undefined && it.min === it.max) return "—"; // live readout filled at boot
      if (zeroAuto && v === 0 && (it.min ?? 0) === 0) return "Auto";
      return it.display === "hex" ? `0x${v.toString(16).toUpperCase()}` : formatNumeric(it, v);
    default: return "";
  }
}

export function visibleOptions(it: Item, vals: Values) {
  const fs = fsOf(it);
  return (it.options ?? []).filter((o) => !condState(o.conditions, fs, vals).hidden);
}

// ---- pages --------------------------------------------------------------------
const norm = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function formRows(schema: Schema, formKey: string, only?: string[]): Row[] {
  const f = schema.forms[formKey];
  if (!f) return [];
  const rows: Row[] = [];
  for (const iid of f.items) {
    const it = schema.items[iid];
    if (only && !only.some((o) => norm(o) === norm(it.prompt))) continue;
    if (it.kind === "ref" && it.target && it.target !== it.form) {
      rows.push({ type: "link", label: it.prompt ?? "", page: `form:${it.target}`, iid });
    } else if (it.kind === "subtitle") {
      rows.push({ type: "subtitle", text: it.prompt ?? "", iid });
    } else if (it.kind !== "ref") {
      rows.push({ type: "item", iid });
    }
  }
  return rows;
}

function exprQids(e: Expr | null | undefined, out: Set<number>) {
  if (!e) return;
  if (e.q !== undefined) out.add(e.q);
  if (e.q2 !== undefined) out.add(e.q2);
  for (const a of e.args ?? []) exprQids(a, out);
}

/** Question ids an item's show/hide (not grey-out) rules depend on. */
export function hideDeps(it: Item): Set<number> {
  const s = new Set<number>();
  for (const c of it.conditions ?? []) if (c.type !== "grayout") exprQids(c.expr, s);
  return s;
}

const rowLabel = (schema: Schema, r: Row) =>
  r.type === "link" ? r.label : r.type === "item" ? schema.items[r.iid].prompt : undefined;

/**
 * Rows picked by label in the given order (the GUI's order, from the video).
 * A label takes every match in the first form that has it (firmware keeps
 * per-hardware variants of one option). Each pick also brings its dependent
 * sub-options: rows in the same form whose show/hide rules reference the
 * picked question, transitively, in firmware order. That keeps behaviour like
 * "Vcore Voltage Mode = Adaptive reveals Internal CPU Vcore" on reordered pages.
 */
function pickRows(schema: Schema, forms: string[], only: string[]): Row[] {
  const pools = forms.map((fk) => formRows(schema, fk));
  const listed = new Set(only.map(norm));
  const used = new Set<Row>();
  const out: Row[] = [];
  for (const label of only) {
    for (const pool of pools) {
      const hits = pool.filter((r) => r.type !== "subtitle" && norm(rowLabel(schema, r)) === norm(label));
      if (!hits.length) continue;
      for (const h of hits) {
        if (used.has(h)) continue;
        used.add(h); out.push(h);
        if (h.type !== "item") continue;
        const it = schema.items[h.iid];
        if (it.question_id === undefined) continue;
        const parents = new Set<number>([it.question_id]);
        for (const r of pool) {
          if (r.type !== "item" || used.has(r)) continue;
          const ri = schema.items[r.iid];
          if (listed.has(norm(ri.prompt))) continue;
          const deps = hideDeps(ri);
          if ([...deps].some((q) => parents.has(q))) {
            used.add(r); out.push(r);
            if (ri.question_id !== undefined) parents.add(ri.question_id);
          }
        }
      }
      break;
    }
  }
  return out;
}

export class PageBook {
  private cache = new Map<string, Page>();
  constructor(private schema: Schema, private layout: Layout) {}

  tabPage(tabId: string): Page { return this.get(`tab:${tabId}`); }

  get(id: string): Page {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const slash = id.indexOf("/");
    if (id.startsWith("tab:") && slash > 0) {
      // synthetic sub-page: building the parent tab registers it
      this.get(id.slice(0, slash));
      const sub = this.cache.get(id);
      if (sub) return sub;
    }
    const p = this.build(id);
    this.cache.set(id, p);
    return p;
  }

  /** Menu path (tab › page › …) of every item reachable in the GUI, shortest first. */
  allPaths(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const seen = new Set<string>();
    const queue: { page: string; path: string[] }[] = this.layout.tabs.map((t) => ({ page: `tab:${t.id}`, path: [t.title] }));
    queue.forEach((q) => seen.add(q.page));
    while (queue.length) {
      const { page, path } = queue.shift()!;
      for (const r of this.get(page).rows) {
        if ("iid" in r && r.iid && !out.has(r.iid)) out.set(r.iid, path);
        if (r.type === "link" && !seen.has(r.page) && path.length < 9) {
          seen.add(r.page);
          queue.push({ page: r.page, path: [...path, r.label.trim()] });
        }
      }
    }
    return out;
  }

  /** Find where an item lives in the GUI: [tab index, page id stack]. */
  locate(iid: string): { tab: number; pages: string[] } | null {
    const target = this.schema.items[iid];
    if (!target) return null;
    // breadth-first across all tabs at once, so the shallowest location wins
    // (Fast Boot opens on the Boot tab, not inside a deep Tweaker sub-page)
    const seen = new Set<string>();
    const queue: { tab: number; path: string[] }[] = this.layout.tabs.map((t, i) => ({ tab: i, path: [`tab:${t.id}`] }));
    queue.forEach((q) => seen.add(q.path[0]));
    while (queue.length) {
      const { tab, path } = queue.shift()!;
      const page = this.get(path[path.length - 1]);
      for (const r of page.rows) if ("iid" in r && r.iid === iid) return { tab, pages: path };
      if (path.length > 8) continue;
      for (const r of page.rows) {
        if (r.type === "link" && !seen.has(r.page)) { seen.add(r.page); queue.push({ tab, path: [...path, r.page] }); }
      }
    }
    return null;
  }

  private entryRows(entries: LayoutEntry[], parentId: string): Row[] {
    const rows: Row[] = [];
    entries.forEach((e, n) => {
      if ("subtitle" in e) rows.push({ type: "subtitle", text: e.subtitle ?? "" });
      else if ("pick" in e) rows.push(...pickRows(this.schema, e.pick, e.only));
      else if (!("inline_form" in e) && "heading" in e) rows.push({ type: "subtitle", text: e.heading, accent: true });
      else if ("inline_form" in e) {
        if (e.heading) rows.push({ type: "subtitle", text: e.heading, accent: true });
        rows.push(...(e.only ? pickRows(this.schema, [e.inline_form], e.only) : formRows(this.schema, e.inline_form)));
      } else if ("ref" in e) rows.push({ type: "link", label: e.label ?? this.schema.forms[e.ref]?.title ?? e.ref, page: `form:${e.ref}` });
      else if ("page" in e) {
        const pid = `${parentId}/p${n}`;
        this.cache.set(pid, { id: pid, title: e.page, rows: e.only ? pickRows(this.schema, e.forms, e.only) : e.forms.flatMap((f) => formRows(this.schema, f)) });
        rows.push({ type: "link", label: e.page, page: pid });
      } else if ("action" in e) rows.push({ type: "action", label: e.label, action: e.action });
    });
    return rows;
  }

  private build(id: string): Page {
    if (id.startsWith("form:")) {
      const fk = id.slice(5);
      return { id, title: this.schema.forms[fk]?.title ?? fk, rows: formRows(this.schema, fk), formKey: fk };
    }
    if (id.startsWith("tab:")) {
      const tab = this.layout.tabs.find((t) => t.id === id.slice(4))!;
      const rows: Row[] = [];
      if (tab.form) rows.push(...formRows(this.schema, tab.form));
      if (tab.entries) rows.push(...this.entryRows(tab.entries, id));
      if (tab.append) rows.push(...this.entryRows(tab.append, id));
      return { id, title: tab.title, rows, formKey: tab.form };
    }
    return { id, title: id, rows: [] };
  }
}

export interface RowView {
  row: Row;
  item?: Item;
  hidden: boolean;
  uncertain: boolean;
  grayed: boolean;
  lock?: string | null; // emulated hardware restriction (e.g. locked multiplier)
  indent?: number;      // 1 = sub-option shown/hidden by a setting just above it
}

export function viewRows(schema: Schema, page: Page, vals: Values, showHidden: boolean,
                         lock?: (it: Item) => string | null): RowView[] {
  const out: RowView[] = [];
  const shown = new Set<string>();
  for (const row of page.rows) {
    const item = "iid" in row && row.iid ? schema.items[row.iid] : undefined;
    const st = item ? condState(item.conditions, fsOf(item), vals) : { hidden: false, uncertain: false, grayed: false };
    if (st.hidden && !showHidden) continue;
    // Firmware often defines per-hardware variants of one option (same prompt) and
    // shows exactly one at runtime; when we can't tell which, show the first.
    const label = item?.prompt?.trim() || (row.type === "link" ? row.label : "");
    if (label && row.type !== "subtitle") {
      if (shown.has(label) && (st.uncertain || st.hidden)) continue;
      shown.add(label);
    }
    if (row.type === "subtitle" && !row.text && out.length && out[out.length - 1].row.type === "subtitle" && !(out[out.length - 1].row as { text: string }).text) continue;
    const lk = item && lock ? lock(item) : null;
    // indent rows whose show/hide rule depends on a choice shown just above them
    let indent = 0;
    if (item && row.type !== "subtitle") {
      const deps = hideDeps(item);
      if (deps.size) {
        for (let j = out.length - 1, n = 0; j >= 0 && n < 40; j--, n++) {
          const prev = out[j].item;
          if (prev?.question_id !== undefined && (prev.kind === "oneof" || prev.kind === "checkbox") && deps.has(prev.question_id)
              && fsOf(prev) === fsOf(item) && !(out[j].indent)) { indent = 1; break; }
        }
      }
    }
    out.push({ row, item, ...st, grayed: st.grayed || !!lk, lock: lk, indent });
  }
  return out;
}

export function isSelectable(v: RowView): boolean {
  if (v.row.type === "subtitle") return false;
  if (v.row.type === "item" && v.item && ["text"].includes(v.item.kind)) return false;
  return true;
}

export function isEditable(v: RowView): boolean {
  return v.row.type === "item" && !!v.item && ["oneof", "checkbox", "numeric"].includes(v.item.kind)
    && !v.grayed && !(v.item.flags ?? []).includes("read_only");
}
