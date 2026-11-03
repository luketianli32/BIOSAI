import { memo, useMemo } from "react";
import type { Item, Schema } from "./types";
import { Values, condState, displayValue, fsOf, visibleOptions, vkey } from "./engine";
import { Icon } from "./Icon";
import { dimmSlots, type Hw } from "./hardware";
import type { Readings } from "./sim";

interface Props {
  schema: Schema; vals: Values; hw: Hw; readings: Readings; zeroAuto: boolean;
  lock: (it: Item) => string | null; keyToIid: Map<string, string>;
  onSet: (it: Item, v: number) => void; onAsk: (iid: string) => void;
  onAdvanced: () => void; onSave: () => void; onDefaults: () => void; onSearch: () => void;
}

const QUICK = ["Re-Size BAR Support", "Preferred Operating Mode", "Multi-Theme", "Memory Boot Mode", "Fast Boot", "Memory Channel Detection Message"];
const DRAM = ["DDR5 Auto Booster", "DDR5 XMP Booster", "Extreme Memory Profile(X.M.P.)", "High Bandwidth", "Low Latency"];

/** Every question with each Easy Mode prompt (firmware often has several variants). */
function candidates(schema: Schema, prompts: string[]): Map<string, Item[]> {
  const m = new Map<string, Item[]>(prompts.map((p) => [p, []]));
  for (const it of Object.values(schema.items)) {
    const p = it.prompt?.trim() ?? "";
    if (it.question_id !== undefined && m.has(p)) m.get(p)!.push(it);
  }
  return m;
}

/** The variant the firmware shows right now, or nothing if its rules hide them all
 *  (e.g. DDR5 Auto Booster is hard-hidden in BIOS F5). Same rules as Advanced Mode. */
function visibleVariant(list: Item[] | undefined, vals: Values): Item | undefined {
  return list?.find((it) => !condState(it.conditions, fsOf(it), vals).hidden);
}

interface SettingProps {
  it: Item; value: number | undefined; display: string; locked: string | null;
  opts: { value: number; label: string }[]; optsKey: string; iid?: string;
  onSet: (it: Item, v: number) => void; onAsk: (iid: string) => void;
}

/** One Easy Mode setting. A stable, memoized component: the page re-renders every
 *  second (clock, live readings), and rebuilding the <select> closes its open list. */
const Setting = memo(function Setting({ it, value, display, locked, opts, iid, onSet, onAsk }: SettingProps) {
  return (
    <div className="ez-set">
      <span className="ez-label">{it.prompt?.trim()}</span>
      {it.kind === "oneof" && opts.length ? (
        <select className="part ez" disabled={!!locked} title={locked ?? undefined} value={value} aria-label={it.prompt?.trim()}
          onChange={(e) => onSet(it, Number(e.target.value))}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : <span className="ez-val">{display || "—"}</span>}
      {iid ? <button className="ask ez-ask" onClick={() => onAsk(iid)} title={`Ask AI what "${it.prompt?.trim()}" does`} aria-label={`Ask AI about ${it.prompt?.trim()}`}>✦ AI</button> : <span />}
    </div>
  );
}, (a, b) => a.it === b.it && a.value === b.value && a.locked === b.locked && a.optsKey === b.optsKey && a.display === b.display);

export function EasyMode({ schema, vals, hw, readings: r, zeroAuto, lock, keyToIid, onSet, onAsk, onAdvanced, onSave, onDefaults, onSearch }: Props) {
  const cands = useMemo(() => candidates(schema, [...QUICK, ...DRAM, "GIGABYTE PerfDrive"]), [schema]);
  const perf = visibleVariant(cands.get("GIGABYTE PerfDrive"), vals);
  const quick = QUICK.map((p) => visibleVariant(cands.get(p), vals)).filter(Boolean) as Item[];
  const dram = DRAM.map((p) => visibleVariant(cands.get(p), vals)).filter(Boolean) as Item[];
  const perfIid = perf ? keyToIid.get(vkey(perf)) : undefined;

  const settingProps = (it: Item): SettingProps => {
    const opts = it.kind === "oneof" ? visibleOptions(it, vals).filter((o) => o.label) : [];
    return {
      it, value: vals.get(vkey(it)), display: displayValue(it, vals, zeroAuto), locked: lock(it),
      opts, optsKey: opts.map((o) => o.value).join(","), iid: keyToIid.get(vkey(it)), onSet, onAsk,
    };
  };

  return (
    <div className="easy">
      <nav className="tabs">
        <button className="tab" onClick={onSearch}><Icon name="search" /> Search (Alt-F)</button>
        <button className="tab" onClick={onDefaults}><Icon name="reset" /> Load Defaults (F7)</button>
        <button className="tab" onClick={onSave}><Icon name="exit" /> Save & Exit (F10)</button>
        <button className="tab" onClick={onAdvanced}><Icon name="gauge" /> Advanced Mode (F2)</button>
      </nav>
      <div className="ez-grid">
        <section className="ez-card">
          <h3>Information</h3>
          <dl>
            <dt>MB</dt><dd>{String(schema.meta.board_string ?? "")}</dd>
            <dt>BIOS file</dt><dd>{String(schema.meta.source_file ?? "")}</dd>
            <dt>CPU</dt><dd>{hw.cpu.name}</dd>
            <dt>RAM</dt><dd>{hw.mem.sizeGB}GB</dd>
          </dl>
          <h3>DRAM Status</h3>
          <ul className="slots">{dimmSlots(hw.mem).map((s) => <li key={s.slot}><span>{s.slot}</span>{s.dimm}</li>)}</ul>
          {dram.map((it) => <Setting key={vkey(it)} {...settingProps(it)} />)}
        </section>
        <section className="ez-card">
          <div className="ez-live">
            <div><small>CPU Frequency</small><b>{r.cpuMHz.toFixed(2)}<i>MHz</i></b><em>{r.eMHz.toFixed(2)}</em></div>
            <div><small>CPU Temp.</small><b>{r.cpuTemp.toFixed(1)}<i>°C</i></b></div>
            <div><small>P/E-core Voltage</small><b>{r.vcore.toFixed(3)}<i>V</i></b></div>
            <div><small>Memory Frequency</small><b>{r.memMTs.toFixed(2)}<i>MT/s</i></b></div>
            <div><small>System Temp.</small><b>{r.sysTemp.toFixed(1)}<i>°C</i></b></div>
            <div><small>Memory Voltage</small><b>{r.memV.toFixed(3)}<i>V</i></b></div>
          </div>
          <div className="ez-head">
            <h3>PerfDrive profile</h3>
            {perfIid && <button className="ask ez-ask" onClick={() => onAsk(perfIid)} title="Ask AI which PerfDrive profile to pick" aria-label="Ask AI about GIGABYTE PerfDrive">✦ AI</button>}
          </div>
          {perf?.options?.map((o) => (
            <label key={o.value} className={vals.get(vkey(perf)) === o.value ? "ez-radio on" : "ez-radio"}>
              <input type="radio" checked={vals.get(vkey(perf)) === o.value} onChange={() => onSet(perf, o.value)} />
              {o.label}
            </label>
          ))}
          <h3>Boot Sequence</h3>
          <ul className="boot-list">
            <li>Windows Boot Manager ({hw.ssd.name} {hw.ssd.capacity})</li>
            <li>UEFI OS (USB Flash Drive)</li>
          </ul>
        </section>
        <section className="ez-card wide">
          <h3>Quick Access</h3>
          <div className="ez-quick">{quick.map((it) => <Setting key={vkey(it)} {...settingProps(it)} />)}</div>
        </section>
      </div>
    </div>
  );
}
