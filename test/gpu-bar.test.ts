// Unit tests for the pure rendering logic (src/gpu-bar.ts).
// Run with: npm test   (or: node --test "test/**/*.test.ts")
//
// Several test vectors are the *exact* colors btop 1.4.6 emitted for the
// same inputs, captured from a live terminal session and cross-checked
// against btop's source (Meter::operator() + Theme::generateGradients),
// so the gradient/fill math is pinned to btop byte-for-byte.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  gradientTable,
  progressBarBlocks,
  formatPercent,
  formatGiB,
  formatCelsius,
  tempColor,
  gradientFor,
  describeGpuRow,
  describePanel,
  barFor,
} from '../src/gpu-bar.ts'
import { VISUAL_CONFIG } from '../src/visual-config.ts'
import type { GpuStats } from '../src/types.ts'

const W = VISUAL_CONFIG.barWidth
const EMPTY = VISUAL_CONFIG.colorEmpty

// btop's default-theme gradient stops, as hex (src/btop_theme.cpp).
const CPU_GRAD = { from: '#77ca9b', via: '#cbc06c', to: '#dc4c4c' }
const USED_GRAD = { from: '#592b26', via: '#d9626d', to: '#ff4769' }
const FREE_GRAD = { from: '#384f21', via: '#b5e685', to: '#dcff85' }

function gpu(overrides: Partial<{
  index: number
  utilization_percent: number | null
  memory_used_mib: number | null
  memory_total_mib: number | null
  temperature_c: number | null
}>) {
  return {
    index: 0,
    name: 'Test GPU',
    utilization_percent: 0,
    memory_used_mib: 0,
    memory_total_mib: 12288,
    temperature_c: 0,
    ...overrides,
  }
}

// ── gradientTable ────────────────────────────────────────────────────────────

test('gradient table: 101 entries, endpoints and mid stop exact', () => {
  const t = gradientTable(CPU_GRAD.from, CPU_GRAD.via, CPU_GRAD.to)
  assert.equal(t.length, 101)
  assert.equal(t[0], CPU_GRAD.from)
  assert.equal(t[50], CPU_GRAD.via)
  assert.equal(t[100], CPU_GRAD.to)
})

test('gradient table: matches btop-emitted colors (live capture vectors)', () => {
  const cpu = gradientTable(CPU_GRAD.from, CPU_GRAD.via, CPU_GRAD.to)
  const used = gradientTable(USED_GRAD.from, USED_GRAD.via, USED_GRAD.to)
  const free = gradientTable(FREE_GRAD.from, FREE_GRAD.via, FREE_GRAD.to)
  // CPU meter, width 34, 41%: first filled cell (position 3) and last
  // filled cell (position 41) from the capture.
  assert.equal(cpu[3], '#7cca99')
  assert.equal(cpu[41], '#bbc275')
  // Swap "used" meter, width 14, 12%: the one filled cell (position 7).
  assert.equal(used[7], '#6a322f')
  // Swap "free" meter, width 14, 88%: 12th filled cell (position 86).
  assert.equal(free[86], '#d1f885')
})

test('gradient table: no mid stop blends over the full range', () => {
  const t = gradientTable('#000000', null, '#ffffff')
  assert.equal(t[0], '#000000')
  assert.equal(t[100], '#ffffff')
  // 50 * (255-0)/100 = 127.5 -> truncates to 127 = #7f7f7f
  assert.equal(t[50], '#7f7f7f')
})

test('gradient table: bad stops fall back instead of crashing', () => {
  const t = gradientTable('nope', null, '#ffffff')
  assert.equal(t[0], '#ffffff')
  assert.equal(t[100], '#ffffff')
})

// ── progressBarBlocks ────────────────────────────────────────────────────────

test('bar: 0% is all empty blocks', () => {
  const blocks = progressBarBlocks(0, W, gradientFor('utilization'), EMPTY)
  assert.equal(blocks.length, W)
  assert.ok(blocks.every((b) => b.char === VISUAL_CONFIG.emptyChar && b.color === EMPTY))
})

test('bar: 100% fills every block with its position color', () => {
  const table = gradientFor('utilization')
  const blocks = progressBarBlocks(100, W, table, EMPTY)
  for (let i = 1; i <= W; i++) {
    assert.equal(blocks[i - 1].char, VISUAL_CONFIG.filledChar)
    assert.equal(blocks[i - 1].color, table[Math.round((i * 100) / W)])
  }
})

test('bar: fill stops where the value stops', () => {
  const table = gradientFor('utilization')
  const blocks = progressBarBlocks(50, W, table, EMPTY)
  for (let i = 1; i <= W; i++) {
    const filled = 50 >= Math.round((i * 100) / W)
    assert.equal(
      blocks[i - 1].color === EMPTY,
      !filled,
      `block ${i} (position ${Math.round((i * 100) / W)})`,
    )
  }
})

test('bar: colors are positional, not index-based (btop rule)', () => {
  const table = gradientFor('utilization')
  // At 50% of width 14, blocks 1-7 fill. The 7th block sits at position
  // 50 -> the mid stop, whether or not the bar is full.
  const half = progressBarBlocks(50, W, table, EMPTY)
  assert.equal(half[6].color, table[50])
  const full = progressBarBlocks(100, W, table, EMPTY)
  assert.equal(half[6].color, full[6].color)
})

test('bar: null / undefined render fully empty', () => {
  assert.ok(progressBarBlocks(null, W, gradientFor('utilization'), EMPTY)
    .every((b) => b.color === EMPTY))
  assert.ok(progressBarBlocks(undefined, W, gradientFor('utilization'), EMPTY)
    .every((b) => b.color === EMPTY))
})

test('bar: out-of-range percentages are clamped', () => {
  const table = gradientFor('utilization')
  const over = progressBarBlocks(150, W, table, EMPTY)
  const max = progressBarBlocks(100, W, table, EMPTY)
  assert.deepEqual(over, max)
  assert.ok(progressBarBlocks(-5, W, table, EMPTY)
    .every((b) => b.color === EMPTY))
})

test('bar: always exactly the requested width', () => {
  for (const p of [0, 1, 33, 42, 99, 100]) {
    assert.equal(progressBarBlocks(p, 10, gradientFor('utilization'), EMPTY).length, 10)
  }
})

// ── readout formatting ───────────────────────────────────────────────────────

test('percent: right-aligned number in 4 columns, no % sign', () => {
  assert.equal(formatPercent(100), ' 100')
  assert.equal(formatPercent(41), '  41')
  assert.equal(formatPercent(0), '   0')
})

test('percent: rounds, clamps, and uses "--" for unknown', () => {
  assert.equal(formatPercent(99.6), ' 100')
  assert.equal(formatPercent(150), ' 100')
  assert.equal(formatPercent(-5), '   0')
  assert.equal(formatPercent(null), '  --')
  assert.equal(formatPercent(undefined), '  --')
})

test('GiB: one decimal, whole numbers drop the ".0", unknown is empty', () => {
  assert.equal(formatGiB(11468), '11.2 GiB')
  assert.equal(formatGiB(12288), '12 GiB')
  assert.equal(formatGiB(732160), '715 GiB')
  assert.equal(formatGiB(0), '0 GiB')
  assert.equal(formatGiB(null), '')
  assert.equal(formatGiB(undefined), '')
})

test('celsius: rounds to the nearest degree, unknown is empty', () => {
  assert.equal(formatCelsius(28), '28°C')
  assert.equal(formatCelsius(61.6), '62°C')
  assert.equal(formatCelsius(null), '')
  assert.equal(formatCelsius(undefined), '')
})

test('temp color: blue at/below tempMinC, red at/above tempMaxC', () => {
  const { tempMinC, tempMaxC, colorTempFrom, colorTempTo } = VISUAL_CONFIG
  assert.equal(tempColor(tempMinC), colorTempFrom)
  assert.equal(tempColor(tempMinC - 10), colorTempFrom, 'clamped below min')
  assert.equal(tempColor(tempMaxC), colorTempTo)
  assert.equal(tempColor(tempMaxC + 10), colorTempTo, 'clamped above max')
})

test('temp color: blends between blue and red, unknown is ""', () => {
  const table = gradientTable(VISUAL_CONFIG.colorTempFrom, null, VISUAL_CONFIG.colorTempTo)
  const { tempMinC, tempMaxC } = VISUAL_CONFIG
  const mid = (tempMinC + tempMaxC) / 2
  assert.equal(tempColor(mid), table[50])
  assert.equal(tempColor(null), '')
  assert.equal(tempColor(undefined), '')
})

// ── rows ─────────────────────────────────────────────────────────────────────

test('row: label is prefix + index', () => {
  const row = describeGpuRow(gpu({ index: 3 }))
  assert.equal(row.label, 'GPU3')
})

test('row: one spec per metric, in barOrder order, labels padded', () => {
  const row = describeGpuRow(gpu({}))
  assert.deepEqual(
    row.bars.map((b) => b.metric),
    [...VISUAL_CONFIG.barOrder],
  )
  const labelWidth = Math.max(
    ...VISUAL_CONFIG.barOrder.map((m) => VISUAL_CONFIG.metricLabels[m].length),
  )
  assert.ok(row.bars.every((b) => b.label.length === labelWidth))
})

test('row: every bar is exactly the configured width', () => {
  const row = describeGpuRow(gpu({ utilization_percent: 42, memory_used_mib: 6144 }))
  assert.ok(row.bars.every((b) => b.blocks.length === VISUAL_CONFIG.barWidth))
})

test('row: memory line shows value, GiB readout, and gradient-colored percent', () => {
  const row = describeGpuRow(gpu({ memory_used_mib: 11468, memory_total_mib: 12288 }))
  const mem = barFor(row, 'memory')
  // 11468/12288 = 93.33% -> 93
  assert.equal(mem.percentText, '  93')
  assert.equal(mem.percentColor, gradientFor('memory')[93])
  assert.equal(mem.valueText, '11.2 GiB')
})

test('row: utilization line shows percent and temperature, gradient-colored', () => {
  const row = describeGpuRow(gpu({ utilization_percent: 42, temperature_c: 58 }))
  const util = barFor(row, 'utilization')
  assert.equal(util.percentText, '  42')
  assert.equal(util.percentColor, gradientFor('utilization')[42])
  assert.equal(util.valueText, '58°C')
  assert.equal(util.valueColor, tempColor(58))
})

test('row: memory line has no value color (temperature only shows on utilization)', () => {
  const row = describeGpuRow(gpu({ memory_used_mib: 6144, memory_total_mib: 12288 }))
  assert.equal(barFor(row, 'memory').valueColor, '')
})

test('row: a full bar ends in the gradient "to" color', () => {
  const row = describeGpuRow(gpu({ utilization_percent: 100 }))
  const util = barFor(row, 'utilization')
  assert.equal(util.blocks[W - 1].color, VISUAL_CONFIG.colorUtilTo)
  assert.equal(util.percentColor, VISUAL_CONFIG.colorUtilTo)
})

test('row: null values render empty bars with "--" readouts', () => {
  const row = describeGpuRow(
    gpu({
      utilization_percent: null,
      memory_used_mib: null,
      memory_total_mib: null,
      temperature_c: null,
    }),
  )
  for (const bar of row.bars) {
    assert.ok(bar.blocks.every((b) => b.color === EMPTY))
    assert.equal(bar.percentText, '  --')
    assert.equal(bar.percentColor, '')
  }
  assert.equal(barFor(row, 'memory').valueText, '')
  assert.equal(barFor(row, 'utilization').valueText, '')
  assert.equal(barFor(row, 'utilization').valueColor, '')
})

test('row: barFor picks the right spec per metric', () => {
  const row = describeGpuRow(
    gpu({ utilization_percent: 100, memory_used_mib: 0, memory_total_mib: 12288 }),
  )
  assert.equal(barFor(row, 'memory'), row.bars.find((b) => b.metric === 'memory'))
  assert.equal(barFor(row, 'utilization'), row.bars.find((b) => b.metric === 'utilization'))
  assert.equal(
    barFor(row, 'utilization').blocks.filter((b) => b.color !== EMPTY).length,
    W,
  )
  assert.equal(
    barFor(row, 'memory').blocks.filter((b) => b.color !== EMPTY).length,
    0,
  )
})

// ── panel ────────────────────────────────────────────────────────────────────

test('panel: one row per GPU, in index order', () => {
  const stats: GpuStats = {
    timestamp: '2026-08-30T00:00:00Z',
    gpus: [0, 1, 2, 3].map((i) =>
      gpu({ index: i, utilization_percent: i * 25, memory_used_mib: 1024 }),
    ),
  }
  const rows = describePanel(stats)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => r.label), ['GPU0', 'GPU1', 'GPU2', 'GPU3'])
})

// ── config sanity ────────────────────────────────────────────────────────────

const HEX = /^#?[0-9a-f]{6}$/i

test('config block stays sane', () => {
  assert.ok(VISUAL_CONFIG.barWidth >= 1, 'barWidth must be at least 1')
  assert.equal(VISUAL_CONFIG.filledChar.length, 1, 'filledChar must be one character')
  assert.equal(VISUAL_CONFIG.emptyChar.length, 1, 'emptyChar must be one character')
  assert.ok(VISUAL_CONFIG.refreshMs >= 250, 'refresh interval looks too aggressive')
  assert.ok(VISUAL_CONFIG.gapLines >= 0, 'gapLines must be >= 0')
  assert.ok(
    Number.isInteger(VISUAL_CONFIG.scrollAfterGpus) && VISUAL_CONFIG.scrollAfterGpus >= 1,
    'scrollAfterGpus must be a positive integer',
  )
  assert.ok(
    new Set(VISUAL_CONFIG.barOrder).size === VISUAL_CONFIG.barOrder.length,
    'barOrder must not repeat a metric',
  )
  // Gradient stops must be real hex colors (the table can't blend a theme default).
  for (const key of [
    'colorMemFrom',
    'colorMemVia',
    'colorMemTo',
    'colorUtilFrom',
    'colorUtilVia',
    'colorUtilTo',
    'colorTempFrom',
    'colorTempTo',
  ] as const) {
    assert.ok(HEX.test(VISUAL_CONFIG[key]), `${key} must be a 24-bit hex color`)
  }
  assert.ok(
    VISUAL_CONFIG.tempMinC < VISUAL_CONFIG.tempMaxC,
    'tempMinC must be less than tempMaxC',
  )
  // "" (theme default) or hex.
  for (const key of ['colorEmpty', 'colorLabel', 'colorMetricText'] as const) {
    const v = VISUAL_CONFIG[key]
    assert.ok(v === '' || HEX.test(v), `${key} must be "" or a 24-bit hex color`)
  }
})
