// Shared test helper: assert a payload matches the data contract exactly
// (README.md, "Data contract") — same strict field-by-field validation the
// Stage 1 network tests used against the live endpoint.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import type { GpuStats } from '../src/types.ts'

const GPU_KEYS = [
  'index',
  'name',
  'utilization_percent',
  'memory_used_mib',
  'memory_total_mib',
  'temperature_c',
].sort()

export function assertContractShape(body: unknown): asserts body is GpuStats {
  assert.ok(body && typeof body === 'object', 'payload is an object')
  const stats = body as Record<string, unknown>
  assert.deepEqual(
    Object.keys(stats).sort(),
    ['gpus', 'timestamp'],
    'exact top-level key set',
  )
  assert.equal(typeof stats.timestamp, 'string', 'timestamp is a string')
  assert.ok(
    !Number.isNaN(Date.parse(stats.timestamp as string)),
    'timestamp is parseable ISO 8601',
  )
  assert.ok(Array.isArray(stats.gpus), 'gpus is an array')
  assert.ok((stats.gpus as unknown[]).length >= 1, 'at least one gpu')

  let prevIndex = -Infinity
  for (const gpu of stats.gpus as Record<string, unknown>[]) {
    assert.deepEqual(
      Object.keys(gpu).sort(),
      GPU_KEYS,
      'exact per-GPU key set',
    )
    assert.equal(typeof gpu.index, 'number', 'index is a number')
    assert.equal(typeof gpu.name, 'string', 'name is a string')
    const util = gpu.utilization_percent
    assert.ok(
      util === null ||
        (typeof util === 'number' && util >= 0 && util <= 100),
      'utilization is 0-100 or null',
    )
    for (const key of ['memory_used_mib', 'memory_total_mib', 'temperature_c'] as const) {
      const v = gpu[key]
      assert.ok(v === null || typeof v === 'number', `${key} is a number or null`)
    }
    if (
      gpu.memory_used_mib !== null &&
      gpu.memory_total_mib !== null &&
      typeof gpu.memory_total_mib === 'number'
    ) {
      assert.ok(
        (gpu.memory_used_mib as number) <= (gpu.memory_total_mib as number),
        'used <= total',
      )
    }
    assert.ok((gpu.index as number) >= prevIndex, 'gpus in index order')
    prevIndex = gpu.index as number
  }
}

/** True when nvidia-smi is usable on this machine. */
export function nvidiaSmiOnPath(): boolean {
  return spawnSync('which', ['nvidia-smi'], { stdio: 'ignore' }).status === 0
}
