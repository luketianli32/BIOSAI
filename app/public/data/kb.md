# Tuning guide: Intel Core Ultra 200S (Arrow Lake) on Z890

This guide is the AI tutor's background knowledge. Board-specific option names, locations, ranges and defaults come from the extracted BIOS, never from this file. Where a number appears below, it is conservative community guidance, not an Intel specification.

## Platform basics
- Core Ultra 200S desktop CPUs (LGA1851) have Performance cores (P-cores) and Efficient cores (E-cores) and **no Hyper-Threading**. K/KF models have unlocked multipliers; non-K models do not allow ratio overclocking.
- KF models have no integrated GPU, so a discrete graphics card is required for display output.
- Clock = BCLK (normally 100 MHz) × ratio. A P-core ratio of 57 means 5.7 GHz at 100 MHz BCLK.
- Besides the cores, the ring/fabric frequencies (ring, D2D die-to-die, NGU) affect latency, especially memory latency.
- Arrow Lake uses DLVR (digitally controlled on-die voltage regulators) fed by a VccIN_AUX/"DLVRin" rail. The core voltage the cores see is regulated on-die from that input. Treat DLVR options as advanced: the defaults (Auto) are correct for nearly everyone.
- Thermal throttle point (TjMax) is around 105 °C. Sustained temperatures in the high 90s under all-core load mean cooling, not voltage, is the limit.

## Intel Default Settings / PerfDrive profiles
- Intel defines power-delivery profiles (Baseline, Performance, and on some SKUs Extreme). They set PL1/PL2 power limits, current limits (ICCMax) and loadlines. GIGABYTE exposes them as "GIGABYTE PerfDrive" along with its own presets.
- "Baseline" is the most conservative, "Performance" is the usual out-of-box choice for K CPUs, and vendor "Unleash"/"Optimization" style presets raise limits further. Higher limits mean more heat and power for diminishing gains.
- "Intel 200S Boost" (where present) is an Intel-validated profile that raises fabric frequencies and supports faster memory. Read the option's help text in this BIOS before enabling it.

## Safe workflow (teach this every time)
1. Load optimized defaults first and note your baseline: benchmark score, max temperature, power draw.
2. Change **one thing at a time**, reboot, then test.
3. Stress test after each change: a short all-core render test (e.g. Cinebench) for a quick check; longer mixed tests (OCCT, y-cruncher, Prime95 small FFT if cooling allows) for stability; a memory tester (TestMem5, Karhu, MemTest86) for RAM changes. Watch temperatures and errors (WHEA errors in Windows Event Viewer count as instability).
4. If the system fails to POST: let memory retrain (DDR5 can take minutes), then use Clear CMOS (jumper or button) or the board's safe-boot recovery. Most boards fall back to defaults after repeated failed boots.
5. Save a known-good profile (Save & Exit › Save Profiles) before experimenting.

## Memory (DDR5)
- XMP (Extreme Memory Profile) loads the kit's rated speed, timings and voltage. Enabling it is the single most useful, lowest-risk tweak. EXPO is the AMD equivalent and does not apply here.
- Arrow Lake runs DDR5 in Gear 2 normally; Gear 4 exists for extreme speeds. CUDIMMs (with an on-module clock driver) are the reliable way to run very high speeds (≈8000+ MT/s).
- If XMP is unstable: try the next lower XMP profile, lower the frequency one step, or loosen primary timings. Four DIMMs (2 DIMMs per channel) usually cannot reach the speeds of two.
- Conservative voltage guidance for daily use: DRAM VDD/VDDQ up to the kit's XMP value (often 1.35–1.45 V). Be cautious above about 1.45 V, avoid above 1.5 V without active memory cooling. Keep memory controller voltages (VDD2, VCCSA) at Auto unless you know why you're changing them.

## CPU overclocking (K/KF only)
- Start by raising the P-core ratio by 1 (100 MHz) at a time, with voltage on Auto/Adaptive, and stress test each step. All-core targets are usually 1–3 bins below the CPU's maximum single-core boost.
- Per-core ratios (Turbo Per Core Limit Control) and active-core turbo ratios let you keep high single-core boost while limiting all-core clocks.
- E-core ratio and ring/fabric ratios can be raised separately. Ring/fabric changes affect memory stability too.
- Power limits (PL1/PL2) and current limits (ICCMax) often matter more than ratios: a CPU hitting its power limit cannot use a higher ratio. Raising limits increases heat.
- Conservative voltage guidance: let the board manage Vcore (Auto/Adaptive) while learning. If setting voltages manually, raise in small steps (about 0.010–0.025 V) and stop when temperatures or power become unacceptable. Sustained high voltage at high current degrades CPUs over time.

## Undervolting
Undervolting lowers voltage for the same frequency: cooler, quieter, sometimes faster (less thermal/power throttling).
- **Voltage offset:** set Vcore voltage mode to an offset or adaptive-plus-offset mode and apply a small negative offset (start about −0.010 to −0.025 V and step down by about 0.010 V). Test after each step. Crashes at idle or light load mean the offset is too deep, even if heavy loads pass.
- **AC/DC loadline:** IA AC Loadline sets how much the CPU requests voltage to rise under load; lowering AC loadline (in mΩ units as the BIOS shows) reduces load voltage. DC loadline should normally match AC loadline so reported power stays accurate. Change in small steps, test carefully.
- **Lower power limits or a lower profile:** the simplest "undervolt": pick a lower Intel Default Settings / PerfDrive profile or reduce PL1/PL2. Big efficiency gains, very low risk.
- **Lower all-core ratio by one bin:** often saves a lot of voltage for a small performance loss.
- Signs of a too-aggressive undervolt: random reboots, application crashes, WHEA errors, failed boots. Back off one step.

## Voltage and ratio limits on this platform (sourced)
- How GIGABYTE's BIOS limits numbers: most voltage options use a 0–65535 placeholder range in the BIOS menu data, and the GIGABYTE screen accepts that same range. GIGABYTE's BIOS guide says "the displayed items and values may vary depending on motherboard chipset and the CPU used". So the real ceilings come from the CPU, its microcode and the voltage regulators, not from a table in the BIOS.
- Ratio ceiling (GIGABYTE BIOS Setup guide, Intel 800 Series): the overclocking ratio limit is 85, or 120 with Core Ratio Extension Mode enabled. The installed CPU may allow less.
- BIOS voltage cap: "Unlock High Voltage Limit" / "Setting High Voltage Limit" in Advanced CPU Settings. Leave it locked unless doing extreme overclocking.
- Arrow Lake DLVRs: cores, E-cores and Ring are powered by on-die DLVRs fed from the VccIA input (GIGABYTE calls it CPU DLVRin Vcore). Since microcode 0x112, Intel blocks the DLVR bypass outside extreme-overclocking modes, and microcode enforces a per-rail DLVR voltage limit (Tom's Hardware). SkatterBencher reports the Ring DLVR limit is 1.356 V by default and can be raised to 1.450 V under ambient cooling.
- DDR5 memory: VDD/VDDQ default to 1.1 V (JEDEC). Standard PMICs cap VDD/VDDQ at 1.435 V; going higher needs an unlocked PMIC (Igor's Lab). VDD2 (memory controller side) is a static 1.1 V rail by default (SkatterBencher).
- Values people actually use are examples, not limits: GIGABYTE Z890 owners report Vcore offsets around −0.060 to −0.075 V for undervolting, and CPU VDDQ ≈ 1.35–1.5 V and VDD2 ≈ 1.34–1.57 V for very fast DDR5 (Overclock.net Z890 owners thread). Always start lower and change in small steps.

## Fans and thermals
- Smart Fan curves map temperature to fan speed. Use CPU temperature for the CPU fan/pump and a system or chipset sensor for case fans. Set a sensible minimum (pumps usually run at a constant high speed).
- Thermal limits and throttling are protection; don't disable them.

## Common options explained
- Re-Size BAR Support / Above 4G MMIO: lets the CPU address all of the GPU's VRAM at once; recommended on for modern GPUs.
- C-States (C1E, C6/C7, Package C-State limit): idle power saving. Disabling them raises idle power and temperature with little benefit for most users.
- Speed Shift / EIST: let the CPU change frequency quickly; keep enabled.
- VT-x (VMX) / VT-d: virtualization; needed for WSL2, Hyper-V and virtual machines.
- Fast Boot: skips some hardware init for quicker boots; disable it when troubleshooting or changing hardware.
- CSM / Secure Boot / TPM (PTT): Windows 11 requires TPM 2.0 (Intel PTT) and supports Secure Boot; leave them enabled unless you have a specific reason.
