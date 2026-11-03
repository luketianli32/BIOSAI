// Human-readable descriptions of IFR conditions, used by the "Explain" panel
// and fed to the AI tutor as grounded context.
import type { Expr, Item, Schema } from "./types";
import { fsOf } from "./engine";

export type QIndex = Map<string, Item>; // `${fs}:${qid}` -> first item

export function buildQIndex(schema: Schema): QIndex {
  const m: QIndex = new Map();
  for (const it of Object.values(schema.items)) {
    if (it.question_id === undefined) continue;
    const k = `${fsOf(it)}:${it.question_id}`;
    const prev = m.get(k);
    if (!prev || (!prev.prompt && it.prompt)) m.set(k, it);
  }
  return m;
}

function qLabel(idx: QIndex, fs: string, q: number): string {
  const it = idx.get(`${fs}:${q}`);
  if (!it) return `hidden flag #${q}`;
  if (it.prompt) return `"${it.prompt}"`;
  return `${it.varstore ?? "var"}[+${it.offset}] (hidden flag)`;
}

function valLabel(idx: QIndex, fs: string, q: number, v: number): string {
  const it = idx.get(`${fs}:${q}`);
  const o = it?.options?.find((o) => o.value === v);
  return o ? o.label : String(v);
}

export function describe(e: Expr | null | undefined, fs: string, idx: QIndex): string {
  if (!e) return "(unknown expression)";
  switch (e.op) {
    case "eq": return `${qLabel(idx, fs, e.q!)} = ${valLabel(idx, fs, e.q!, e.v as number)}`;
    case "in": return `${qLabel(idx, fs, e.q!)} is one of [${(e.v as number[]).map((v) => valLabel(idx, fs, e.q!, v)).join(", ")}]`;
    case "eq_qq": return `${qLabel(idx, fs, e.q!)} = ${qLabel(idx, fs, e.q2!)}`;
    case "qref": return qLabel(idx, fs, e.q!);
    case "const": return String(e.v);
    case "not": return `NOT (${describe(e.args?.[0], fs, idx)})`;
    case "and": return (e.args ?? []).map((a) => `(${describe(a, fs, idx)})`).join(" AND ");
    case "or": return (e.args ?? []).map((a) => `(${describe(a, fs, idx)})`).join(" OR ");
    default: {
      const sym: Record<string, string> = { equal: "=", not_equal: "≠", greater_than: ">", greater_equal: "≥", less_than: "<", less_equal: "≤", bitwise_and: "&", bitwise_or: "|" };
      if (sym[e.op] && e.args?.length === 2) return `${describe(e.args[0], fs, idx)} ${sym[e.op]} ${describe(e.args[1], fs, idx)}`;
      return `${e.op}(${(e.args ?? []).map((a) => describe(a, fs, idx)).join(", ")})`;
    }
  }
}

export function explainItem(it: Item, idx: QIndex): string[] {
  const fs = fsOf(it);
  const lines: string[] = [];
  for (const c of it.conditions ?? []) {
    const verb = c.type === "grayout" ? "Greyed out (locked) when" : "Hidden when";
    lines.push(`${verb} ${describe(c.expr, fs, idx)}`);
  }
  return lines;
}
