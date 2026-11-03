// Selectable hardware for the emulator. Specs are typical published figures;
// everything shown as a live reading is simulated from them.
import type { Item } from "./types";

export interface Cpu {
  id: string; name: string; pCores: number; eCores: number;
  pMaxGHz: number; pAllCoreGHz: number; eAllCoreGHz: number;
  unlocked: boolean; igpu: boolean; baseW: number; turboW: number;
  idleV: number; series?: string; model?: string;
}
export interface MemKit {
  name: string; dimms: number; sizeGB: number; jedec: number;
  xmp?: { speed: number; timings: string; volt: number }; cudimm?: boolean;
}
export interface Ssd { name: string; capacity: string; iface: string; slot: string; nvme: boolean }
export interface Gpu { id: string; name: string; vendor: "NVIDIA" | "AMD" | "Intel" | "None"; series: string; gen: number; lanes: number }

/** Built-in fallback; the board's cpus.json (loaded at start) replaces it via setCpus(). */
export let CPUS: Cpu[] = [
  { id: "285k", name: "Intel Core Ultra 9 285K", pCores: 8, eCores: 16, pMaxGHz: 5.7, pAllCoreGHz: 5.4, eAllCoreGHz: 4.6, unlocked: true, igpu: true, baseW: 125, turboW: 250, idleV: 0.925 },
  { id: "285", name: "Intel Core Ultra 9 285", pCores: 8, eCores: 16, pMaxGHz: 5.6, pAllCoreGHz: 5.0, eAllCoreGHz: 4.4, unlocked: false, igpu: true, baseW: 65, turboW: 182, idleV: 0.90 },
  { id: "265k", name: "Intel Core Ultra 7 265K", pCores: 8, eCores: 12, pMaxGHz: 5.5, pAllCoreGHz: 5.2, eAllCoreGHz: 4.6, unlocked: true, igpu: true, baseW: 125, turboW: 250, idleV: 0.92 },
  { id: "265kf", name: "Intel Core Ultra 7 265KF", pCores: 8, eCores: 12, pMaxGHz: 5.5, pAllCoreGHz: 5.2, eAllCoreGHz: 4.6, unlocked: true, igpu: false, baseW: 125, turboW: 250, idleV: 0.92 },
  { id: "245k", name: "Intel Core Ultra 5 245K", pCores: 6, eCores: 8, pMaxGHz: 5.2, pAllCoreGHz: 5.0, eAllCoreGHz: 4.6, unlocked: true, igpu: true, baseW: 125, turboW: 159, idleV: 0.91 },
  { id: "225", name: "Intel Core Ultra 5 225", pCores: 6, eCores: 4, pMaxGHz: 4.9, pAllCoreGHz: 4.5, eAllCoreGHz: 4.0, unlocked: false, igpu: true, baseW: 65, turboW: 121, idleV: 0.89 },
];

/** Replace the CPU catalog with the board's data file (boards/<board>/cpus.json). */
export function setCpus(list: Cpu[]) {
  const ok = list.filter((c) => c && c.id && c.name && c.pCores > 0 && c.eCores >= 0);
  if (ok.length) CPUS = ok;
}

// ---- memory: capacity × frequency ------------------------------------------------
export interface Choice { id: string; name: string; group?: string }

export const MEM_SIZES: (Choice & { gb: number; dimms: number })[] = [
  { id: "16", name: "16GB (2×8GB)", gb: 16, dimms: 2 },
  { id: "32", name: "32GB (2×16GB)", gb: 32, dimms: 2 },
  { id: "48", name: "48GB (2×24GB)", gb: 48, dimms: 2 },
  { id: "64", name: "64GB (2×32GB)", gb: 64, dimms: 2 },
  { id: "96", name: "96GB (2×48GB)", gb: 96, dimms: 2 },
  { id: "128", name: "128GB (4×32GB)", gb: 128, dimms: 4 },
  { id: "192", name: "192GB (4×48GB)", gb: 192, dimms: 4 },
];

// Typical retail XMP profiles at each speed (timings tCL-tRCD-tRP-tRAS, DRAM voltage)
export const MEM_SPEEDS: (Choice & { speed: number; xmp?: { timings: string; volt: number }; cudimm?: boolean })[] = [
  { id: "4800", name: "DDR5-4800 (JEDEC, no XMP)", group: "Standard (JEDEC)", speed: 4800 },
  { id: "5600", name: "DDR5-5600 (JEDEC, no XMP)", group: "Standard (JEDEC)", speed: 5600 },
  { id: "6400", name: "DDR5-6400 (JEDEC, no XMP)", group: "Standard (JEDEC)", speed: 6400 },
  { id: "x6000", name: "DDR5-6000 XMP CL30", group: "XMP kits", speed: 6000, xmp: { timings: "30-38-38-96", volt: 1.35 } },
  { id: "x6400", name: "DDR5-6400 XMP CL32", group: "XMP kits", speed: 6400, xmp: { timings: "32-39-39-102", volt: 1.40 } },
  { id: "x7200", name: "DDR5-7200 XMP CL34", group: "XMP kits", speed: 7200, xmp: { timings: "34-45-45-115", volt: 1.40 } },
  { id: "x8000", name: "DDR5-8000 XMP CL38 (CUDIMM)", group: "XMP kits", speed: 8000, cudimm: true, xmp: { timings: "38-48-48-128", volt: 1.45 } },
  { id: "x8200", name: "DDR5-8200 XMP CL40 (CUDIMM)", group: "XMP kits", speed: 8200, cudimm: true, xmp: { timings: "40-50-50-128", volt: 1.45 } },
  { id: "x8800", name: "DDR5-8800 XMP CL42 (CUDIMM)", group: "XMP kits", speed: 8800, cudimm: true, xmp: { timings: "42-54-54-138", volt: 1.45 } },
];

function makeKit(sizeId: string, speedId: string): MemKit {
  const sz = MEM_SIZES.find((s) => s.id === sizeId) ?? MEM_SIZES[2];
  const sp = MEM_SPEEDS.find((s) => s.id === speedId) ?? MEM_SPEEDS[7];
  const per = sz.gb / sz.dimms;
  // XMP kits boot at their SPD (JEDEC) speed until XMP is enabled; CUDIMMs default to 6400
  const jedec = sp.xmp ? (sp.cudimm ? 6400 : 4800) : sp.speed;
  return {
    name: `${sz.dimms}×${per}GB DDR5-${sp.speed}${sp.xmp ? ` CL${sp.xmp.timings.split("-")[0]}` : ""}${sp.cudimm ? " CUDIMM" : ""}`,
    dimms: sz.dimms, sizeGB: sz.gb, jedec, cudimm: sp.cudimm,
    xmp: sp.xmp ? { speed: sp.speed, ...sp.xmp } : undefined,
  };
}

// ---- storage: type × capacity -------------------------------------------------------
export const SSD_TYPES: (Choice & { iface: string; slot: string; nvme: boolean })[] = [
  { id: "gen5", name: "NVMe Gen5", iface: "NVMe PCIe 5.0 x4", slot: "M.2 (CPU)", nvme: true },
  { id: "gen4", name: "NVMe Gen4", iface: "NVMe PCIe 4.0 x4", slot: "M.2 (CPU)", nvme: true },
  { id: "gen3", name: "NVMe Gen3", iface: "NVMe PCIe 3.0 x4", slot: "M.2 (chipset)", nvme: true },
  { id: "sata-ssd", name: "SATA SSD", iface: "SATA 6Gb/s", slot: "SATA port", nvme: false },
  { id: "sata-hdd", name: "SATA HDD", iface: "SATA 6Gb/s (HDD)", slot: "SATA port", nvme: false },
];
export const SSD_SIZES: Choice[] = ["500GB", "1TB", "2TB", "4TB", "8TB"].map((s) => ({ id: s, name: s }));

// ---- graphics: every current desktop GPU, grouped by series ------------------------
const g = (vendor: Gpu["vendor"], series: string, gen: number, lanes: number, names: string[]): Gpu[] =>
  names.map((n) => ({ id: n.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: n, vendor, series, gen, lanes }));

export const GPUS: Gpu[] = [
  ...g("NVIDIA", "GeForce RTX 50 series", 5, 16, ["GeForce RTX 5090", "GeForce RTX 5080", "GeForce RTX 5070 Ti", "GeForce RTX 5070"]),
  ...g("NVIDIA", "GeForce RTX 50 series", 5, 8, ["GeForce RTX 5060 Ti", "GeForce RTX 5060"]),
  ...g("NVIDIA", "GeForce RTX 40 series", 4, 16, ["GeForce RTX 4090", "GeForce RTX 4080 SUPER", "GeForce RTX 4080", "GeForce RTX 4070 Ti SUPER", "GeForce RTX 4070 Ti", "GeForce RTX 4070 SUPER", "GeForce RTX 4070"]),
  ...g("NVIDIA", "GeForce RTX 40 series", 4, 8, ["GeForce RTX 4060 Ti", "GeForce RTX 4060"]),
  ...g("NVIDIA", "GeForce RTX 30 series", 4, 16, ["GeForce RTX 3090 Ti", "GeForce RTX 3090", "GeForce RTX 3080 Ti", "GeForce RTX 3080", "GeForce RTX 3070 Ti", "GeForce RTX 3070", "GeForce RTX 3060 Ti", "GeForce RTX 3060"]),
  ...g("NVIDIA", "GeForce RTX 30 series", 4, 8, ["GeForce RTX 3050"]),
  ...g("NVIDIA", "GeForce GTX 16 series", 3, 16, ["GeForce GTX 1660 SUPER", "GeForce GTX 1650"]),
  ...g("AMD", "Radeon RX 9000 series", 5, 16, ["Radeon RX 9070 XT", "Radeon RX 9070", "Radeon RX 9060 XT"]),
  ...g("AMD", "Radeon RX 7000 series", 4, 16, ["Radeon RX 7900 XTX", "Radeon RX 7900 XT", "Radeon RX 7900 GRE", "Radeon RX 7800 XT", "Radeon RX 7700 XT"]),
  ...g("AMD", "Radeon RX 7000 series", 4, 8, ["Radeon RX 7600 XT", "Radeon RX 7600"]),
  ...g("AMD", "Radeon RX 6000 series", 4, 16, ["Radeon RX 6950 XT", "Radeon RX 6900 XT", "Radeon RX 6800 XT", "Radeon RX 6800", "Radeon RX 6750 XT", "Radeon RX 6700 XT"]),
  ...g("AMD", "Radeon RX 6000 series", 4, 8, ["Radeon RX 6650 XT", "Radeon RX 6600 XT", "Radeon RX 6600"]),
  ...g("AMD", "Radeon RX 6000 series", 4, 4, ["Radeon RX 6500 XT"]),
  ...g("Intel", "Intel Arc B-series", 4, 8, ["Arc B580", "Arc B570"]),
  ...g("Intel", "Intel Arc A-series", 4, 16, ["Arc A770", "Arc A750", "Arc A580"]),
  ...g("Intel", "Intel Arc A-series", 4, 8, ["Arc A380"]),
  { id: "none", name: "None (use CPU integrated graphics)", vendor: "None", series: "No graphics card", gen: 0, lanes: 0 },
];
export const SLOT_GEN = 5; // PCIEX16 on this board is a CPU-attached PCIe 5.0 x16 slot

export function gpuLink(gpu: Gpu): string {
  if (gpu.vendor === "None") return "—";
  const gen = Math.min(gpu.gen, SLOT_GEN);
  return `PCIe ${gpu.gen}.0 x${gpu.lanes} @ ${gen}.0 x${gpu.lanes}`;
}

// ---- selection -------------------------------------------------------------------
export interface HwSel { cpu: string; memSize: string; memSpeed: string; ssdType: string; ssdSize: string; gpu: string }
export const DEFAULT_HW: HwSel = { cpu: "285k", memSize: "48", memSpeed: "x8200", ssdType: "gen4", ssdSize: "2TB", gpu: "geforce-rtx-4090" };

export interface Hw { cpu: Cpu; mem: MemKit; ssd: Ssd; gpu: Gpu }
export function resolveHw(s: HwSel): Hw {
  const t = SSD_TYPES.find((x) => x.id === s.ssdType) ?? SSD_TYPES[1];
  return {
    cpu: CPUS.find((c) => c.id === s.cpu) ?? CPUS[0],
    mem: makeKit(s.memSize, s.memSpeed),
    ssd: { name: `${s.ssdSize} ${t.name}`, capacity: s.ssdSize, iface: t.iface, slot: t.slot, nvme: t.nvme },
    gpu: GPUS.find((m) => m.id === s.gpu) ?? GPUS[0],
  };
}

const KEY = "biosai.hw.v2";
export function loadHw(): HwSel {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = { ...DEFAULT_HW, ...JSON.parse(raw) } as HwSel;
      if (GPUS.some((x) => x.id === s.gpu)) return s;
    }
  } catch { /* storage unavailable */ }
  return DEFAULT_HW;
}
export function saveHw(s: HwSel) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

export function describeHw(hw: Hw) {
  const c = hw.cpu, m = hw.mem;
  return {
    cpu: `${c.name} (${c.pCores}P+${c.eCores}E, ${c.unlocked ? "unlocked multiplier" : "locked multiplier"}, ${c.igpu ? "has iGPU" : "no iGPU"}, ${c.baseW}W base / ${c.turboW}W turbo, P max ${c.pMaxGHz} GHz)`,
    memory: `${m.name}: ${m.dimms} DIMMs, ${m.sizeGB}GB total${m.cudimm ? ", CUDIMM" : ""}, boots at ${m.jedec} MT/s${m.xmp ? `, XMP ${m.xmp.speed} MT/s ${m.xmp.timings} @ ${m.xmp.volt.toFixed(2)}V` : ", no XMP profile"}`,
    storage: `${hw.ssd.capacity} ${hw.ssd.iface} in ${hw.ssd.slot}`,
    gpu: hw.gpu.vendor === "None" ? "No graphics card (CPU integrated graphics)" : `${hw.gpu.vendor} ${hw.gpu.name} (${gpuLink(hw.gpu)} in PCIEX16)`,
  };
}

/** DIMM slot population on this board (2 DIMMs go in A2 + B2). */
export function dimmSlots(m: MemKit): { slot: string; dimm: string }[] {
  const per = `DDR5 ${m.sizeGB / m.dimms}GB ${m.xmp?.speed ?? m.jedec}MT/s`;
  const filled = m.dimms === 4 ? ["DDR5_A1", "DDR5_A2", "DDR5_B1", "DDR5_B2"] : ["DDR5_A2", "DDR5_B2"];
  return ["DDR5_B1", "DDR5_B2", "DDR5_A1", "DDR5_A2"].map((s) => ({ slot: s, dimm: filled.includes(s) ? per : "N/A" }));
}

/** Runtime values the real BIOS fills in at boot from the installed hardware
 *  (varstore name -> byte offset -> value). Found by reading the firmware's own
 *  conditions, e.g. "Turbo P-Core 9 Ratio Limit" is hidden when ProcMitAttrib+0 < 10. */
export function runtimeOverrides(hw: Hw): Record<string, Record<string, number>> {
  const xmp = hw.mem.xmp ? 1 : 0;
  return {
    // +0 P-core count, +1 E-core count
    ProcMitAttrib: { "0": hw.cpu.pCores, "1": hw.cpu.eCores },
    // +1 kit has a profile, +9 XMP+EXPO kit, +10 EXPO, +11 XMP: picks which
    // "Extreme Memory Profile(X.M.P.)" variant the BIOS shows.
    // +3..+7 = "XMP profile 1..5 absent" (the firmware hides "XMP N" when set):
    // retail XMP kits carry profiles 1 and 2.
    MemMitAttrib: { "1": xmp, "9": 0, "10": 0, "11": xmp, "3": xmp ? 0 : 1, "4": xmp ? 0 : 1, "5": 1, "6": 1, "7": 1 },
  };
}

// ---- emulator rules that depend on the selected parts -------------------------
const RATIO = /(CPU Clock Ratio|Turbo Ratio|Ring Ratio|Ratio Limit|Flex Ratio|Core Ratio)/i;
const XMP = /(Extreme Memory Profile|XMP)/i;
const IGPU = /^(Internal Graphics|IGP Ratio)$/i;

/** Why the selected hardware locks this option (emulated), or null. */
export function hardwareLock(it: Item, hw: Hw): string | null {
  const p = it.prompt?.trim() ?? "";
  if (!hw.cpu.unlocked && RATIO.test(p)) return `${hw.cpu.name} has a locked multiplier, so ratio overclocking isn't available (K/KF CPUs only).`;
  if (!hw.mem.xmp && XMP.test(p)) return `This ${hw.mem.name} kit has no XMP profile, so there is nothing to load.`;
  if (!hw.cpu.igpu && IGPU.test(p)) return `${hw.cpu.name} has no integrated graphics.`;
  return null;
}

export function hardwareWarnings(hw: Hw): string[] {
  const w: string[] = [];
  if (!hw.cpu.igpu && hw.gpu.vendor === "None") w.push("No display output: this CPU has no iGPU and no graphics card is installed.");
  if (hw.mem.dimms === 4 && hw.mem.xmp && hw.mem.xmp.speed > 5600) w.push("4 DIMMs (2 per channel) rarely run above ~5600 MT/s; expect to lower the speed or loosen timings.");
  if (hw.mem.xmp && hw.mem.xmp.speed >= 8000 && hw.mem.dimms === 4) w.push("8000+ MT/s needs CUDIMMs in a 2-DIMM setup.");
  if (hw.gpu.vendor === "Intel") w.push("Intel Arc cards need Re-Size BAR Support enabled for full performance.");
  if (hw.gpu.gen >= 5) w.push("PCIe 5.0 card: if you see a black screen or instability, try setting the slot to Gen4 in PCIe Link Speed Configuration.");
  return w;
}
