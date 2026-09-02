// ────────────────────────────────────────────────────────────────────────────
// VISUAL CONFIG
//
// Every visual choice for the GPU panel lives in this one block.
// Want different colors, a wider bar, a different order, a different
// refresh rate? Change it here — nowhere else in the codebase.
//
// Each GPU is rendered as a small block: its label, then one line per
// metric — a short label, the percent, the bar, and (for memory) a value
// readout. The bar style mirrors btop's meters: a full row of ■ blocks
// (the same character for filled and empty — told apart by color), where
// each block's color is fixed by its position on a 0-100 gradient table:
//
//   GPU0
//   Mem   90% ■■■■■■■■■■■■  11.2 GiB   (blocks after the fill are dim)
//   Util   0% ■■■■■■■■■■■■
//
// The gradient table is built from three hex stops per metric
// (from → via → to, 50/50 split), the same way btop builds its theme
// gradients. There are no threshold colors: a full bar simply shows the
// whole gradient, ending in the "to" color.
// ────────────────────────────────────────────────────────────────────────────
export const VISUAL_CONFIG = {
  /** Number of block characters per bar. */
  barWidth: 14,

  /** Character used for the filled part of a bar. */
  filledChar: '■',

  /** Character used for the empty part of a bar. */
  emptyChar: '■',

  /** Which bar appears where in each GPU block, top to bottom. */
  barOrder: ['memory', 'utilization'] as const,

  /** Short name shown at the start of each metric line. */
  metricLabels: { memory: 'Mem', utilization: 'Util' },

  /**
   * Memory bar gradient stops (btop's "used" gradient):
   * dark maroon → red → pink.
   */
  colorMemFrom: '#592b26',
  colorMemVia: '#d9626d',
  colorMemTo: '#ff4769',

  /**
   * Utilization bar gradient stops (btop's "cpu" gradient):
   * green → yellow → red.
   */
  colorUtilFrom: '#77ca9b',
  colorUtilVia: '#cbc06c',
  colorUtilTo: '#dc4c4c',

  /** Empty part of a bar (btop's meter_bg). */
  colorEmpty: '#404040',

  /**
   * Temperature readout gradient (shown next to Util as e.g. "28°C"):
   * blue (cool) → red (hot), linear over [tempMinC, tempMaxC].
   */
  colorTempFrom: '#4a90e2',
  colorTempTo: '#dc4c4c',

  /** At or below this temperature (°C), the readout is fully blue. */
  tempMinC: 30,

  /** At or above this temperature (°C), the readout is fully red. */
  tempMaxC: 85,

  /**
   * The text parts of a metric line (label, % sign, value readout).
   * Empty string = theme default color.
   */
  colorMetricText: '',

  /** Per-GPU label text ("GPU0"). Empty string = theme default color. */
  colorLabel: '',

  /** Label = labelPrefix + GPU index, e.g. "GPU0". */
  labelPrefix: 'GPU',

  /**
   * When true, append the GPU model name to the label
   * (e.g. "GPU0 Tesla P100"). Off by default — model names are long.
   */
  showModel: false,

  /** Blank lines between GPU blocks. */
  gapLines: 1,

  /**
   * Up to this many GPUs the panel renders as a plain, content-sized
   * block (it only takes the lines it needs, so the other sidebar
   * elements — MCP server list, LSP indicator — keep their space below).
   * Above this it switches to a scroll area, because a scroll container
   * claims its whole area and is only worth that trade-off for genuinely
   * long panels. (Each GPU block is 3 lines + 1 gap: 10 GPUs = 39 lines.)
   */
  scrollAfterGpus: 10,

  /** Update interval in milliseconds (live mode). */
  refreshMs: 2000,
} as const

/** A bar metric: which quantity a given bar represents. */
export type BarMetric = (typeof VISUAL_CONFIG.barOrder)[number]
