// Tests for the shared collection layer (src/collect.ts) and the
// auto-scaling behavior of the panel renderer when the GPU count varies.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectGpuStats,
  NoGpuError,
  parseCsvLine,
  parseNvidiaSmiOutput,
  selftestStats,
} from '../src/collect.ts'
import { describePanel } from '../src/gpu-bar.ts'
import { VISUAL_CONFIG } from '../src/visual-config.ts'
import type { GpuInfo } from '../src/types.ts'
import { assertContractShape, nvidiaSmiOnPath } from './helpers.ts'

// ── CSV line parsing ─────────────────────────────────────────────────────────

test('parseCsvLine: plain line splits on commas', () => {
  assert.deepEqual(parseCsvLine('0, Tesla P100, 42, 9588, 16384'), [
    '0',
    ' Tesla P100',
    ' 42',
    ' 9588',
    ' 16384',
  ])
})

test('parseCsvLine: quoted field may contain commas', () => {
  assert.deepEqual(parseCsvLine('0, "Tesla P100, PCIe", 42, 9588, 16384'), [
    '0',
    ' Tesla P100, PCIe',
    ' 42',
    ' 9588',
    ' 16384',
  ])
})

test('parseCsvLine: escaped quotes inside a quoted field', () => {
  assert.equal(parseCsvLine('0, "Weird ""Name""", 1, 2, 3')[1], ' Weird "Name"')
})

// ── nvidia-smi output parsing ────────────────────────────────────────────────

/** Build a realistic nvidia-smi csv output string from [index,name,util,used,total] tuples. */
function smiOutput(
  gpus: Array<[number, string, number | string, number | string, number | string]>,
): string {
  return (
    gpus
      .map(([i, name, util, used, total]) =>
        [i, name, String(util), String(used), String(total)].join(', '),
      )
      .join('\n') + '\n'
  )
}

test('parse: one entry per GPU actually detected (1, 2, 4, 8)', () => {
  for (const n of [1, 2, 4, 8]) {
    const gpus: Array<[number, string, number, number, number]> = Array.from(
      { length: n },
      (_, i) => [i, `Fake GPU ${i}`, (i * 13) % 101, 1024 * (i + 1), 16384],
    )
    const parsed = parseNvidiaSmiOutput(smiOutput(gpus))
    assert.equal(parsed.length, n, `${n} GPU(s) in, ${n} out`)
    parsed.forEach((g, i) => {
      assert.equal(g.index, i)
      assert.equal(g.name, `Fake GPU ${i}`)
      assert.equal(g.utilization_percent, (i * 13) % 101)
    })
  }
})

test('parse: fields map positionally, including the full 4-GPU sample', () => {
  const parsed = parseNvidiaSmiOutput(
    smiOutput([
      [0, 'Tesla P100', 42, 9588, 16384],
      [1, 'Tesla P100', 0, 120, 16384],
      [2, 'Tesla P100', 100, 16384, 16384],
      [3, 'Tesla P100', 7, 2048, 16384],
    ]),
  )
  assert.equal(parsed.length, 4)
  assert.deepEqual(parsed[0], {
    index: 0,
    name: 'Tesla P100',
    utilization_percent: 42,
    memory_used_mib: 9588,
    memory_total_mib: 16384,
  })
  assert.deepEqual(parsed[3], {
    index: 3,
    name: 'Tesla P100',
    utilization_percent: 7,
    memory_used_mib: 2048,
    memory_total_mib: 16384,
  })
})

test('parse: "N/A" values become null (driver cannot report)', () => {
  const parsed = parseNvidiaSmiOutput(
    smiOutput([
      [0, 'Mystery GPU', 'N/A', 512, 'N/A'],
    ]),
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].utilization_percent, null)
  assert.equal(parsed[0].memory_used_mib, 512)
  assert.equal(parsed[0].memory_total_mib, null)
})

test('parse: blank and malformed lines are skipped, GPUs still counted', () => {
  const output = [
    '',
    '0, Good GPU, 10, 100, 1024',
    'garbage line',
    '1, Also Good, 20, 200, 1024',
    '2, TooShort, 30',
    '',
  ].join('\n')
  const parsed = parseNvidiaSmiOutput(output)
  assert.deepEqual(
    parsed.map((g) => g.index),
    [0, 1],
  )
})

test('parse: empty input yields no GPUs', () => {
  assert.deepEqual(parseNvidiaSmiOutput(''), [])
})

test('parse: quoted GPU model names with commas survive', () => {
  const parsed = parseNvidiaSmiOutput('0, "Some, Ranged GPU", 5, 10, 20\n')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].name, 'Some, Ranged GPU')
})

// ── collectGpuStats (adaptive: depends on whether this box has nvidia-smi) ──

test(
  'collectGpuStats: rejects NoGpuError when nvidia-smi is absent',
  { skip: nvidiaSmiOnPath() },
  async () => {
    await assert.rejects(
      collectGpuStats(),
      (err: unknown) =>
        err instanceof NoGpuError && /NVIDIA-only/.test(err.message),
    )
  },
)

test(
  'collectGpuStats: resolves a contract-shaped payload when nvidia-smi exists',
  { skip: !nvidiaSmiOnPath() },
  async () => {
    const stats = await collectGpuStats()
    assertContractShape(stats)
  },
)

// ── selftest payload ─────────────────────────────────────────────────────────

test('selftestStats: contract-shaped, 4 sample GPUs, fresh timestamp', () => {
  const before = Date.now()
  const stats = selftestStats()
  assertContractShape(stats)
  assert.equal(stats.gpus.length, 4)
  const ageMs = Date.now() - Date.parse(stats.timestamp)
  assert.ok(ageMs >= 0 && ageMs < 5000, 'timestamp is fresh')
  assert.ok(before - 1000 <= Date.parse(stats.timestamp) + 5000)
})

test('selftestStats: repeated calls return independent copies', () => {
  const a = selftestStats()
  a.gpus[0].name = 'mutated'
  const b = selftestStats()
  assert.equal(b.gpus[0].name, 'Selftest GPU 0')
})

// ── panel auto-scaling (describePanel) ───────────────────────────────────────

function fakeGpus(n: number): GpuInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `Fake GPU ${i}`,
    utilization_percent: [0, 25, 50, 75, 100][i % 5],
    memory_used_mib: 1024 * (i + 1),
    memory_total_mib: 16384,
  }))
}

for (const n of [1, 2, 4, 8]) {
  test(`panel scales to ${n} GPU(s): one row each, full-width bars, no fixed count`, () => {
    const rows = describePanel({ timestamp: '2026-08-30T00:00:00Z', gpus: fakeGpus(n) })
    assert.equal(rows.length, n)
    rows.forEach((row, i) => {
      assert.equal(row.label, `GPU${i}`)
      assert.equal(row.bars.length, VISUAL_CONFIG.barOrder.length)
      for (const bar of row.bars) {
        assert.equal(bar.blocks.length, VISUAL_CONFIG.barWidth)
      }
    })
    // Layout line budget the renderer draws (label + one line per metric,
    // gapLines blanks between blocks): 3 lines per GPU + 1 gap.
    // 8 GPUs → 31 lines; the TUI wraps the blocks in a scrollbox, so any
    // fleet size stays inside the sidebar instead of clipping.
    const totalLines = n * (1 + VISUAL_CONFIG.barOrder.length) + (n - 1) * VISUAL_CONFIG.gapLines
    assert.equal(totalLines, n * 4 - 1)
  })
}
