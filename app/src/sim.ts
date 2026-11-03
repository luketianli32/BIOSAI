// Simulated hardware-monitor readings. They react to the selected parts and to
// a few key settings (ratio, XMP, memory multiplier, PerfDrive) so the user can
// see cause and effect. They are not predictions of real hardware.
import type { Item, Schema } from "./types";
import { Values, vkey } from "./engine";
import type { Hw } from "./hardware";

export interface Readings {
  cpuMHz: number; eMHz: number; bclk: number; cpuTemp: number; sysTemp: number; vcore: number;
  memMTs: number; memV: number; memTimings: string; xmpOn: boolean;
  v5: number; v12: number; vccsa: number; cpuFanRpm: number; optFanRpm: number;
}

export interface SimHandles { pRatio?: Item; eRatio?: Item; xmp: Item[]; memMult?: Item; perf?: Item }

export function findHandles(schema: Schema): SimHandles {
  const all = Object.values(schema.items);
  const first = (p: string) => all.find((it) => it.prompt?.trim() === p && it.question_id !== undefined && it.default_visibility !== "hidden")
    ?? all.find((it) => it.prompt?.trim() === p && it.question_id !== undefined);
  return {
    pRatio: first("Performance CPU Clock Ratio"),
    eRatio: first("Efficiency CPU Clock Ratio"),
    xmp: all.filter((it) => it.prompt?.trim() === "Extreme Memory Profile(X.M.P.)" && it.question_id !== undefined),
    memMult: first("System Memory Multiplier"),
    perf: first("GIGABYTE PerfDrive"),
  };
}

const jitter = (t: number, seed: number, amp: number) => amp * Math.sin(t * 0.9 + seed) * Math.cos(t * 0.37 + seed * 2);

export function computeReadings(hw: Hw, vals: Values, h: SimHandles, t: number): Readings {
  const get = (it?: Item) => (it ? vals.get(vkey(it)) ?? 0 : 0);
  const pr = hw.cpu.unlocked ? get(h.pRatio) : 0;
  const er = hw.cpu.unlocked ? get(h.eRatio) : 0;
  const pTarget = pr > 0 && pr < 120 ? pr * 100 : hw.cpu.pAllCoreGHz * 1000;
  const eTarget = er > 0 && er < 120 ? er * 100 : hw.cpu.eAllCoreGHz * 1000;
  const ocMHz = Math.max(0, pTarget - hw.cpu.pAllCoreGHz * 1000);

  const xmpOn = !!hw.mem.xmp && h.xmp.some((it) => {
    const v = vals.get(vkey(it));
    const label = it.options?.find((o) => o.value === v)?.label ?? "";
    return v !== undefined && v !== 0 && /XMP|EXPO|Profile/i.test(label);
  });
  const mult = get(h.memMult);
  let mem = xmpOn && hw.mem.xmp ? hw.mem.xmp.speed : hw.mem.jedec;
  if (mult > 0) mem = mult >= 1000 ? mult : mult * 100;

  const perfLabel = h.perf?.options?.find((o) => o.value === get(h.perf))?.label ?? "";
  const perfHeat = /Unleash|Extreme/i.test(perfLabel) ? 3 : /BaseLine/i.test(perfLabel) ? -2 : 0;

  const bclk = 100 + jitter(t, 1, 0.004) + 0.001;
  return {
    cpuMHz: pTarget * (bclk / 100),
    eMHz: eTarget * (bclk / 100) - 0.6 + jitter(t, 7, 0.5),
    bclk,
    cpuTemp: 36 + perfHeat + ocMHz / 100 * 1.8 + jitter(t, 2, 1.6),
    sysTemp: 33 + jitter(t, 3, 0.6),
    vcore: hw.cpu.idleV + ocMHz / 100 * 0.018 + jitter(t, 4, 0.004),
    memMTs: mem,
    memV: xmpOn && hw.mem.xmp ? hw.mem.xmp.volt : 1.1,
    memTimings: xmpOn && hw.mem.xmp ? hw.mem.xmp.timings : "JEDEC",
    xmpOn,
    v5: 5.017 + jitter(t, 5, 0.012),
    v12: 12.204 + jitter(t, 6, 0.03),
    vccsa: (xmpOn ? 1.30 : 1.20) + jitter(t, 8, 0.003),
    cpuFanRpm: Math.round(1700 + ocMHz * 1.5 + jitter(t, 9, 60)),
    optFanRpm: Math.round(1240 + jitter(t, 10, 40)),
  };
}

export function readingsSummary(r: Readings) {
  return {
    p_core_mhz: r.cpuMHz.toFixed(0), e_core_mhz: r.eMHz.toFixed(0), cpu_temp_c: r.cpuTemp.toFixed(1),
    vcore_v: r.vcore.toFixed(3), memory_mts: String(r.memMTs), dram_v: r.memV.toFixed(2), xmp: r.xmpOn ? "on" : "off",
  };
}
