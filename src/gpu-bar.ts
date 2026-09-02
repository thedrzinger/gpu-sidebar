// Pure rendering logic: turn the endpoint's JSON into display-ready rows.
// No I/O, no terminal assumptions — the same rows drive both the plain
// terminal preview (src/preview.ts) and the TUI panel (src/tui.tsx, stage 3).
// All visual choices come from src/visual-config.ts.
//
// Each GPU becomes one block: a label line, then one line per metric in
// `barOrder` — a short label, the percent, the bar, and a value readout
// (GiB for memory, temperature for utilization). The bar style mirrors
// btop's meters:
//
//   GPU0
//   Mem   90% ■■■■■■■■■■■■  11.2 GiB
//   Util   0% ■■■■■■■■■■■■  28°C
//
// A bar is a full row of block characters (the same char for filled and
// empty — told apart by color). Each block's color is fixed by its
// position on a 0-100 gradient table, exactly like btop: block i (1-based)
// sits at percent position round(i*100/width) and is filled when the value
// reaches that position. There are no threshold colors — a full bar simply
// shows the whole gradient.

import { VISUAL_CONFIG, type BarMetric } from './visual-config.ts'
import type { GpuInfo, GpuStats } from './types.ts'

/** One character of a bar, plus the color to draw it in. */
export interface BarBlock {
  char: string
  /** 24-bit hex color; "" = theme default. */
  color: string
}

/**
 * One metric line of a GPU block. Renderers draw it as:
 *
 *   label + " " + <blocks left to right> + percentText + "%" + (valueText ? " " + valueText : "")
 *
 * The label and the "%" sign use the metric text color; percentText uses
 * `percentColor`; valueText uses `valueColor`; the block sequence is always
 * exactly barWidth characters, so the readouts always start in the same
 * column.
 */
export interface BarSpec {
  metric: BarMetric
  /** Metric label, padded to the widest configured label (e.g. "Mem "). */
  label: string
  /** Percent number, right-aligned in 4 columns (e.g. "  41"), or "  --". */
  percentText: string
  /**
   * Color for percentText — the gradient table value at the percent's own
   * position (btop colors the number the same way). "" = metric text color.
   */
  percentColor: string
  /** Value readout after the percent (e.g. "11.2 GiB", "28°C"), or "" when none. */
  valueText: string
  /**
   * Color for valueText — e.g. the blue-to-red temperature gradient.
   * "" = metric text color.
   */
  valueColor: string
  /** The bar, one entry per block, left to right. */
  blocks: BarBlock[]
}

export interface GpuRow {
  /** Per-GPU label, e.g. "GPU0" (or with model name, per config). */
  label: string
  /** One spec per metric, in VISUAL_CONFIG.barOrder order. */
  bars: BarSpec[]
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Build a 101-entry gradient table (index 0-100) from three hex stops,
 * the same way btop builds its theme gradients: piecewise linear RGB
 * interpolation — 0-50 blends `from`→`via` and 50-100 blends `via`→`to`
 * (or 0-100 blends `from`→`to` when there is no `via`) — with truncating
 * integer math per channel.
 */
export function gradientTable(
  from: string,
  via: string | null,
  to: string,
): string[] {
  const a = hexToRgb(from)
  const b = hexToRgb(via ?? '')
  const c = hexToRgb(to)
  // Degenerate fallbacks so a bad config can't crash the panel.
  const start = a ?? c ?? b ?? [136, 136, 136]
  const end = c ?? a ?? b ?? [136, 136, 136]
  const mid = b
  const hasMid = mid != null
  const range = hasMid ? 50 : 100

  const table: string[] = []
  for (let i = 0; i <= 100; i++) {
    // Two passes of 50 when a mid stop exists (i=50 lands exactly on `via`).
    const seg = hasMid && i > 50 ? 1 : 0
    const lo = seg === 0 ? start : (mid ?? end)
    const hi = seg === 0 ? (mid ?? end) : end
    const off = seg === 0 ? 0 : 50
    // Match C++ integer arithmetic exactly: the product is divided first
    // (truncating), then added — truncating the final sum would round
    // negative steps differently (e.g. 202 + 3*-10/50 is 202, not 201).
    const rgb = lo.map((v, ch) =>
      v + Math.trunc(((i - off) * (hi[ch] - v)) / range),
    ) as [number, number, number]
    table.push(rgbToHex(rgb))
  }
  return table
}

/**
 * One bar, as per-block chars+colors (btop's Meter algorithm):
 * block i (1-based) occupies percent position round(i*100/width); it is
 * filled — with the table color at that position — when the value reaches
 * it, otherwise it takes the flat empty color. Out-of-range values are
 * clamped, and null is treated as an empty bar.
 */
export function progressBarBlocks(
  percent: number | null | undefined,
  width: number,
  table: readonly string[],
  emptyColor: string,
): BarBlock[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const safePercent =
    percent != null && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : 0
  const blocks: BarBlock[] = []
  for (let i = 1; i <= safeWidth; i++) {
    const y = Math.round((i * 100) / safeWidth)
    if (safePercent >= y) {
      blocks.push({ char: VISUAL_CONFIG.filledChar, color: table[y] })
    } else {
      blocks.push({ char: VISUAL_CONFIG.emptyChar, color: emptyColor })
    }
  }
  return blocks
}

/** " 100", "  41", "   0" — right-aligned in 4 columns; "  --" if unknown. */
export function formatPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '  --'
  const n = Math.max(0, Math.min(100, Math.round(p)))
  return n.toString().padStart(4)
}

/** MiB as a GiB readout: "11.2 GiB"; whole numbers drop the ".0"; "" if unknown. */
export function formatGiB(mib: number | null | undefined): string {
  if (mib == null || !Number.isFinite(mib)) return ''
  const text = (mib / 1024).toFixed(1).replace(/\.0$/, '')
  return `${text} GiB`
}

/** Celsius as a readout: "28°C"; "" if unknown. */
export function formatCelsius(tempC: number | null | undefined): string {
  if (tempC == null || !Number.isFinite(tempC)) return ''
  return `${Math.round(tempC)}°C`
}

// Temperature gradient: blue (cool) at tempMinC through red (hot) at
// tempMaxC — a plain two-stop blend, built once like the bar gradients.
const TEMP_GRADIENT = gradientTable(VISUAL_CONFIG.colorTempFrom, null, VISUAL_CONFIG.colorTempTo)

/** Gradient color for a temperature: clamped to [tempMinC, tempMaxC], blue→red. */
export function tempColor(tempC: number | null | undefined): string {
  if (tempC == null || !Number.isFinite(tempC)) return ''
  const { tempMinC, tempMaxC } = VISUAL_CONFIG
  const span = tempMaxC - tempMinC
  const position = span <= 0 ? 0 : ((tempC - tempMinC) / span) * 100
  const clamped = Math.max(0, Math.min(100, Math.round(position)))
  return TEMP_GRADIENT[clamped]
}

/** Percent of total VRAM in use, or null when the driver can't report it. */
function memPercent(
  usedMib: number | null,
  totalMib: number | null,
): number | null {
  if (usedMib == null || totalMib == null || totalMib <= 0) return null
  return (usedMib / totalMib) * 100
}

/** Gradient stops for a metric, from config. */
function gradientStops(metric: BarMetric): [string, string | null, string] {
  return metric === 'memory'
    ? [VISUAL_CONFIG.colorMemFrom, VISUAL_CONFIG.colorMemVia, VISUAL_CONFIG.colorMemTo]
    : [VISUAL_CONFIG.colorUtilFrom, VISUAL_CONFIG.colorUtilVia, VISUAL_CONFIG.colorUtilTo]
}

// The config is static, so build each metric's 101-entry table once.
const GRADIENTS: Record<BarMetric, string[]> = {
  memory: gradientTable(...gradientStops('memory')),
  utilization: gradientTable(...gradientStops('utilization')),
}

/** The gradient table for a metric. */
export function gradientFor(metric: BarMetric): readonly string[] {
  return GRADIENTS[metric]
}

/** The spec for one of a row's metric lines, selected by metric. */
export function barFor(row: GpuRow, metric: BarMetric): BarSpec {
  return row.bars.find((b) => b.metric === metric)!
}

/** Turn one GPU from the endpoint payload into a display block. */
export function describeGpuRow(gpu: GpuInfo): GpuRow {
  const util = gpu.utilization_percent
  const mem = memPercent(gpu.memory_used_mib, gpu.memory_total_mib)
  const labels = VISUAL_CONFIG.metricLabels
  const labelWidth = Math.max(
    ...VISUAL_CONFIG.barOrder.map((m) => labels[m].length),
  )
  const bars: BarSpec[] = VISUAL_CONFIG.barOrder.map((metric) => {
    const percent = metric === 'memory' ? mem : util
    const table = GRADIENTS[metric]
    const known = percent != null && Number.isFinite(percent)
    return {
      metric,
      label: labels[metric].padEnd(labelWidth),
      percentText: formatPercent(percent),
      // btop colors the number with the gradient at the value's own position.
      percentColor: known ? table[Math.round(Math.max(0, Math.min(100, percent!)))] : '',
      // Memory's readout is its GiB value; utilization's is the temperature.
      valueText:
        metric === 'memory' ? formatGiB(gpu.memory_used_mib) : formatCelsius(gpu.temperature_c),
      valueColor: metric === 'utilization' ? tempColor(gpu.temperature_c) : '',
      blocks: progressBarBlocks(percent, VISUAL_CONFIG.barWidth, table, VISUAL_CONFIG.colorEmpty),
    }
  })
  return {
    label: `${VISUAL_CONFIG.labelPrefix}${gpu.index}${
      VISUAL_CONFIG.showModel ? ' ' + gpu.name : ''
    }`,
    bars,
  }
}

/** Turn a full endpoint payload into display rows, one per GPU. */
export function describePanel(stats: GpuStats): GpuRow[] {
  return stats.gpus.map((gpu) => describeGpuRow(gpu))
}
