// Browser-side grounding for the AI tutor, used when the page runs as a
// published claude.ai Artifact (no Python server). Mirrors
// biosai/tutor/knowledge.py + server.py: menu paths, keyword retrieval over the
// firmware's options, option descriptions, and the tutor's standing rules.
import type { Item, Schema } from "./types";
import { PageBook, fsOf, hideDeps } from "./engine";
import { refFor, sanityFor, sanitySummary } from "./refs";
import { buildQIndex, describe, type QIndex } from "./explain";

const SYNONYMS: Record<string, string> = {
  overclock: "ratio multiplier turbo bclk frequency clock power limit",
  oc: "ratio multiplier turbo bclk frequency clock",
  undervolt: "voltage vcore offset loadline dlvr adaptive mode",
  undervolting: "voltage vcore offset loadline dlvr adaptive mode",
  voltage: "voltage vcore vccsa vdd vddq",
  xmp: "extreme memory profile xmp",
  expo: "extreme memory profile xmp",
  ram: "memory dram ddr5 xmp timing",
  memory: "memory dram ddr5 xmp timing",
  timings: "timing cas trcd trp tras",
  temperature: "temp thermal fan tjmax",
  temps: "temp thermal fan",
  fan: "fan smart pump",
  quiet: "fan smart silent power limit",
  quieter: "fan smart silent power limit",
  power: "power limit pl1 pl2 tdp watts iccmax",
  cstates: "c state c1e package",
  boot: "boot fast option priority",
  gpu: "display graphics pcie resize bar",
  rebar: "resize bar above 4gb mmio",
  virtualization: "vmx vt-d virtualization",
  ecores: "efficiency e-core",
  pcores: "performance p-core",
};
const STOP = new Set("the a an and or of to in on for is are what how do does i my it this that with can should be at by me you your".split(" "));

export function tokens(s: string): string[] {
  return (s.toLowerCase().replace(/x\.m\.p\.?/g, "xmp").match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));
}
function expand(q: string): string[] {
  const out = tokens(q);
  for (const t of [...out]) if (SYNONYMS[t]) out.push(...tokens(SYNONYMS[t]));
  return out;
}
const norm = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export const RULES = `You are the AI tutor inside "BIOS AI", an emulator of a real motherboard's UEFI setup.
The user is learning how BIOS options work and how to tune their PC (overclocking, undervolting, memory, fans, boot and security settings).

How to answer:
- Begin your visible answer immediately. Be practical and concise: short paragraphs, numbered steps for procedures. Plain language first, then the technical detail.
- Ground every option name, menu location, choice and default in the <bios_context> supplied with the latest message. It comes from this board's actual firmware. If an option the user asks about isn't in the context, say you can't find it on this board rather than inventing one.
- When you mention a specific option from the context, add a link marker right after its name: [[item:ID]] using the exact id from the context (e.g. "Set Extreme Memory Profile(X.M.P.) [[item:4:10739/17]] to XMP 1"). The app turns these into "show me" buttons. Only use ids that appear in the context.
- Tailor advice to the selected hardware (CPU, memory, storage, GPU). Say when something doesn't apply (ratio overclocking on a non-K CPU, XMP on a kit without XMP, no display output on a KF CPU without a GPU).
- Live readings (frequency, temperature, voltage) are simulated by the emulator; say so if the user treats them as real measurements.
- Safety: this emulator never touches real hardware. For real systems, recommend one change at a time, stress testing, watching temperatures, and how to recover (Clear CMOS). Give conservative voltage guidance and call it guidance, not a specification. Never encourage disabling thermal protection.
- Numeric options on this board show 0 as "Auto".

Background knowledge (general; board facts in the per-message context take precedence):

`;

export interface ContextInput {
  message: string;
  focus_iid?: string | null;
  hardware: Record<string, string>;
  readings: Record<string, string>;
  page_path: string;
  changes: { iid: string; path: string; from: string; to: string }[];
}

export class Tutor {
  private paths: Map<string, string[]> | null = null;
  private docs: { iid: string; tf: Map<string, number> }[] | null = null;
  private idf = new Map<string, number>();
  private qidx: QIndex;

  constructor(private schema: Schema, private book: PageBook) {
    this.qidx = buildQIndex(schema);
  }

  pathOf(iid: string): string[] | null {
    this.paths ??= this.book.allPaths();
    return this.paths.get(iid) ?? null;
  }

  private index() {
    if (this.docs) return this.docs;
    const docs: { iid: string; tf: Map<string, number> }[] = [];
    const df = new Map<string, number>();
    for (const [iid, d] of Object.entries(this.schema.items)) {
      if (!d.prompt || d.kind === "subtitle") continue;
      const path = this.pathOf(iid);
      if (!path && d.default_visibility === "hidden") continue;
      const tf = new Map<string, number>();
      const add = (t: string, w: number) => tf.set(t, (tf.get(t) ?? 0) + w);
      tokens(d.prompt).forEach((t) => add(t, 3));
      tokens(d.help ?? "").slice(0, 60).forEach((t) => add(t, 1));
      tokens((path ?? []).join(" ")).forEach((t) => add(t, 1));
      docs.push({ iid, tf });
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + docs.length / c));
    return (this.docs = docs);
  }

  search(query: string, k = 24): string[] {
    const q = expand(query);
    if (!q.length) return [];
    const scored: [number, string][] = [];
    for (const { iid, tf } of this.index()) {
      let s = 0;
      for (const t of q) { const f = tf.get(t); if (f) s += (this.idf.get(t) ?? 0) * (1 + Math.log(f)); }
      if (s <= 0) continue;
      const d = this.schema.items[iid];
      if (this.pathOf(iid)) s *= 1.6;
      if (d.default_visibility === "hidden") s *= 0.5;
      scored.push([s, iid]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [, iid] of scored) {
      const d = this.schema.items[iid];
      const key = [norm(d.prompt), (this.pathOf(iid) ?? []).join(" "), (d.options ?? []).slice(0, 3).map((o) => o.label).join("|")].join("#");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(iid);
      if (out.length >= k) break;
    }
    return out;
  }

  private valueLabel(d: Item, v: number | undefined): string {
    if (v === undefined) return "?";
    if (d.kind === "oneof") return d.options?.find((o) => o.value === v)?.label ?? String(v);
    if (d.kind === "checkbox") return v ? "Enabled" : "Disabled";
    if (d.kind === "numeric" && v === 0 && (d.min ?? 0) === 0) return "Auto";
    return String(v);
  }

  /** The setting just above an item that shows/hides it (e.g. "Pcore 0 Setting" for its
   *  "Voltage" row), so generic firmware labels read unambiguously. */
  parentOf(iid: string): Item | undefined {
    const d = this.schema.items[iid];
    const deps = hideDeps(d);
    if (!deps.size) return undefined;
    const ids = this.schema.forms[d.form]?.items ?? [];
    for (let i = ids.indexOf(iid) - 1, n = 0; i >= 0 && n < 40; i--, n++) {
      const p = this.schema.items[ids[i]];
      if (p.question_id !== undefined && deps.has(p.question_id) && (p.kind === "oneof" || p.kind === "checkbox") && p.prompt) return p;
    }
    return undefined;
  }

  describeItem(iid: string, full: boolean, current?: Map<string, string>): string {
    const d = this.schema.items[iid];
    const path = this.pathOf(iid);
    const parent = this.parentOf(iid);
    const label = parent ? `${parent.prompt!.trim()} › ${d.prompt?.trim() ?? ""}` : d.prompt?.trim() ?? "";
    const where = path ? [...path, label].join(" › ")
      : `(not reachable in this board's GUI) ${this.schema.forms[d.form]?.title} › ${d.prompt?.trim()}`;
    const parts = [`[${iid}] ${where}`, `type=${d.kind}`];
    if (d.kind === "oneof") {
      const opts = (d.options ?? []).map((o) => o.label);
      const n = full ? 40 : 8;
      parts.push(`choices=${opts.slice(0, n).join(" / ")}${opts.length > n ? " …" : ""}`);
    }
    if (d.kind === "numeric") {
      const h = d.range_hint;
      const unit = h?.unit === "mΩ" ? " in 1/100 mΩ" : h?.unit ? ` ${h.unit}` : "";
      if (h?.min !== undefined && h.max !== undefined) parts.push(`range=${h.min}..${h.max}${unit} (from the option's help text; 0 = Auto on this board)`);
      else if (d.range_unknown) parts.push(`range=NOT DEFINED in the firmware menu data${unit ? `, unit${unit}` : ""} (the real BIOS screen accepts the same 0-65535; the CPU and voltage regulators enforce physical limits: don't state exact limits, give conservative guidance); 0 = Auto`);
      else parts.push(`range=${d.min}..${d.max}${unit} step ${d.step} (0 = Auto on this board)`);
      const sr = sanityFor(d);
      if (sr) parts.push(`SANITY CHECK (emulator estimate, not a BIOS limit; values entered in ${sr.unit}${sr.unit === "V" ? ", stored as mV" : ""}): ${sanitySummary(sr)}. Basis: ${sr.basis} [source: ${sr.source.title}${sr.source.url ? " " + sr.source.url : ""}]`);
      const ref = refFor(d);
      if (ref) parts.push(`${ref.kind === "enforce" ? `DOCUMENTED LIMIT max ${ref.max}${ref.max_when ? ` (${ref.max_when.max} when ${ref.max_when.prompt} = ${ref.max_when.label})` : ""}` : "REFERENCE (not a BIOS limit)"}: ${ref.note} [source: ${ref.source.title} ${ref.source.url}]`);
    }
    if (d.default !== undefined) parts.push(`default=${this.valueLabel(d, d.default)}`);
    if (current?.has(iid)) parts.push(`CURRENT (user changed)=${current.get(iid)}`);
    if (d.help && d.help.trim().toUpperCase() !== "N/A") {
      const h = d.help.replace(/\n/g, " ");
      parts.push(`help="${full ? h : h.slice(0, 220)}"`);
    }
    if (full && d.varstore) parts.push(`stored=${d.varstore}+0x${(d.offset ?? 0).toString(16).toUpperCase()} (${d.size} bytes)`);
    if (d.flags?.includes("reset_required")) parts.push("needs reboot");
    if (d.default_visibility === "hidden") parts.push("HIDDEN on this hardware by default");
    if (full) {
      for (const c of d.conditions ?? []) {
        parts.push(`${c.type === "grayout" ? "greyed when" : "hidden when"} ${describe(c.expr, fsOf(d), this.qidx)}`);
      }
    }
    return parts.join("; ");
  }

  context(input: ContextInput): string {
    const current = new Map(input.changes.filter((c) => c.iid).map((c) => [c.iid, `${c.to} (was ${c.from})`]));
    let query = input.message;
    const focus = input.focus_iid && this.schema.items[input.focus_iid] ? input.focus_iid : null;
    if (focus) query += " " + (this.schema.items[focus].prompt ?? "");
    const hits = this.search(query, 24);
    for (const c of input.changes) if (c.iid && this.schema.items[c.iid] && !hits.includes(c.iid)) hits.push(c.iid);

    const lines = ["<bios_context>", "Selected hardware:"];
    for (const k of ["cpu", "memory", "storage", "gpu"]) if (input.hardware[k]) lines.push(`- ${k}: ${input.hardware[k]}`);
    const r = Object.entries(input.readings);
    if (r.length) lines.push("Simulated live readings: " + r.map(([k, v]) => `${k}=${v}`).join(", "));
    if (input.page_path) lines.push(`User is viewing: ${input.page_path}`);
    if (focus) {
      lines.push("Option the user is asking about (full detail):");
      lines.push("- " + this.describeItem(focus, true, current));
    }
    if (input.changes.length) {
      lines.push("Unsaved changes the user made in the emulator:");
      for (const c of input.changes) lines.push(`- ${c.path}: ${c.from} -> ${c.to}${c.iid ? ` [${c.iid}]` : ""}`);
    }
    lines.push("Related options on this board (id, menu path, details):");
    for (const iid of hits) if (iid !== focus) lines.push("- " + this.describeItem(iid, false, current));
    lines.push("</bios_context>");
    return lines.join("\n");
  }

  boardLine(): string {
    const m = this.schema.meta;
    return `\n\nThis board: ${m.board_string}, firmware file ${m.source_file} (${m.vendor_firmware}).`;
  }
}
