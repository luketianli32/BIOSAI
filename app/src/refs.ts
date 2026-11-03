// Sourced limits, reference values and sanity checks for numeric options the BIOS
// menu data leaves undefined (boards/<board>/reference_ranges.json).
//   rules  "enforce": documented by the board vendor and applied (e.g. ratio ceiling)
//          "reference": hardware/spec facts shown as guidance
//   sanity typical / warn / hard bands per rail type: emulator estimates, NOT the real
//          BIOS limits. Values outside "hard" are blocked as physically implausible.
// (No imports from engine.ts: engine uses these helpers for display.)
import type { Item, Schema } from "./types";

type Values = Map<string, number>;
const fsOf = (it: Item) => it.form.split(":")[0];
const vkey = (it: Item) => `${fsOf(it)}:${it.question_id}`;

export interface RefRule {
  id: string;
  kind: "enforce" | "reference";
  match: string;
  forms?: string[];
  max?: number;
  max_when?: { prompt: string; label: string; max: number };
  note: string;
  source: { title: string; url: string };
}

export interface SanityRule {
  id: string;
  match: string;
  forms?: string[];
  unit: string;          // display unit: V, mV, W, clk, ratio, T
  store: "mV" | "raw";   // how the emulator stores the number
  signed?: boolean;
  step: number;          // in display units
  typical: [number, number];
  warn: [number, number];
  hard: [number, number];
  basis: string;
  source: { title: string; url: string };
}

let RULES: (RefRule & { rx: RegExp })[] = [];
let SANITY: (SanityRule & { rx: RegExp })[] = [];

export function setRefRules(rules: RefRule[], sanity: SanityRule[] = []) {
  RULES = []; SANITY = [];
  for (const r of rules ?? []) { try { RULES.push({ ...r, rx: new RegExp(r.match) }); } catch { /* skip malformed */ } }
  for (const r of sanity ?? []) { try { SANITY.push({ ...r, rx: new RegExp(r.match) }); } catch { /* skip malformed */ } }
}

const matches = (it: Item, r: { rx: RegExp; forms?: string[] }) =>
  r.rx.test(it.prompt?.trim() ?? "") && (!r.forms || r.forms.includes(it.form));

export function refFor(it: Item): RefRule | undefined {
  return it.kind === "numeric" ? RULES.find((r) => matches(it, r)) : undefined;
}

/** Sanity rule for an option, unless the firmware's own help text already states its range. */
export function sanityFor(it: Item): SanityRule | undefined {
  if (it.kind !== "numeric" || (it.range_hint?.min !== undefined && it.range_hint?.max !== undefined)) return undefined;
  return SANITY.find((r) => matches(it, r));
}

/** Maximum a documented "enforce" rule allows right now (e.g. 85, or 120 with Core Ratio Extension Mode). */
export function enforcedMax(it: Item, schema: Schema, vals: Values): number | undefined {
  const r = refFor(it);
  if (!r || r.kind !== "enforce" || r.max === undefined) return undefined;
  if (r.max_when) {
    const fs = fsOf(it);
    const ctl = Object.values(schema.items).find((x) => x.question_id !== undefined && fsOf(x) === fs && x.prompt?.trim() === r.max_when!.prompt);
    const label = ctl?.options?.find((o) => o.value === vals.get(vkey(ctl)))?.label;
    if (label === r.max_when.label) return r.max_when.max;
  }
  return r.max;
}

// ---- sanity: units, parsing, checking -----------------------------------------
export const sanityScale = (r: SanityRule) => (r.store === "mV" && r.unit === "V" ? 1000 : 1);
const fmtUnit = (r: SanityRule, x: number) => (r.unit === "V" ? x.toFixed(3) : String(Math.round(x)));
export const fmtBand = (r: SanityRule, b: [number, number]) => `${fmtUnit(r, b[0])}–${fmtUnit(r, b[1])} ${r.unit}`;

/** Stored range the emulator accepts (the "hard" band), in stored units. */
export function sanityStoredRange(r: SanityRule): { min: number; max: number } {
  const s = sanityScale(r);
  return { min: Math.round(r.hard[0] * s), max: Math.round(r.hard[1] * s) };
}

/** Parse what the user typed into a stored value. Volts accept "1.35", "1.350V" or millivolts "1350"/"1350mV". */
export function sanityParse(r: SanityRule, text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "" ) return null;
  if (t === "auto") return 0;
  if (r.unit === "V" && r.store === "mV") {
    const mv = /^([+-]?\d+(?:\.\d+)?)mv$/.exec(t);
    if (mv) return Math.round(parseFloat(mv[1]));
    const v = /^([+-]?\d*\.?\d+)v?$/.exec(t);
    if (!v) return null;
    const n = parseFloat(v[1]);
    // a bare number of 20 or more can only be millivolts (no rail here is 20 V)
    return Math.abs(n) >= 20 ? Math.round(n) : Math.round(n * 1000);
  }
  const n = /^([+-]?\d+)[a-z]*$/.exec(t);
  return n ? parseInt(n[1], 10) : null;
}

export type SanityLevel = "ok" | "warn" | "hard";

/** Classify a stored (signed) value. 0 means Auto and is never flagged. */
export function sanityCheck(r: SanityRule, stored: number): { level: SanityLevel; message: string } {
  if (stored === 0) return { level: "ok", message: "" };
  const x = stored / sanityScale(r);
  const out = (b: [number, number]) => x < b[0] - 1e-9 || x > b[1] + 1e-9;
  const shown = `${r.signed && x > 0 ? "+" : ""}${fmtUnit(r, x)} ${r.unit}`;
  if (out(r.hard)) return { level: "hard", message: `${shown} is outside the plausible range ${fmtBand(r, r.hard)}.` };
  if (out(r.warn)) return { level: "warn", message: `${shown} is well outside the typical ${fmtBand(r, r.typical)}. Double-check before using it on real hardware.` };
  if (out(r.typical)) return { level: "warn", message: `${shown} is above or below the typical ${fmtBand(r, r.typical)}.` };
  return { level: "ok", message: "" };
}

export function sanityFormat(r: SanityRule, stored: number): string {
  const x = stored / sanityScale(r);
  return `${r.signed && x > 0 ? "+" : ""}${fmtUnit(r, x)} ${r.unit}`;
}

export function sanitySummary(r: SanityRule): string {
  return `Typical ${fmtBand(r, r.typical)} · flagged outside ${fmtBand(r, r.warn)} · blocked outside ${fmtBand(r, r.hard)}`;
}
