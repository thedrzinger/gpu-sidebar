// Shared GPU stats collection — the ONE place that talks to nvidia-smi.
//
// Used by:
//   - src/tui.tsx      embedded mode (no `url` in tui.json: OpenCode and the
//                      GPU(s) live on the same machine)
//   - src/reporter.ts  remote mode (serves the same payload over HTTP for
//                      plugins on other machines)
//
// The payload shape is the data contract documented in README.md ("Data
// contract"). `parseNvidiaSmiOutput` is pure and fully unit-tested; the
// shell-out wrapper is deliberately thin.
//
// NVIDIA only: if nvidia-smi is not on PATH we say so plainly (NoGpuError)
// rather than guessing at other vendors.

import { spawn } from 'node:child_process'
import type { GpuInfo, GpuStats } from './types.ts'

/** The exact nvidia-smi query (same fields/order as the old Python reporter). */
export const NVIDIA_SMI_COMMAND = [
  'nvidia-smi',
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
] as const

const SMI_TIMEOUT_MS = 10_000

/**
 * Thrown when the machine has no usable NVIDIA GPU data: nvidia-smi is
 * missing from PATH, or it runs but reports no GPUs. Renderers should show
 * a friendly hint (see NO_GPU_HINT) instead of a generic error.
 */
export class NoGpuError extends Error {}

/** Any other collection failure (timeout, nvidia-smi exited non-zero, …). */
export class GpuStatsError extends Error {}

/**
 * Shown by the panel when embedded mode finds no GPU. Kept here so the TUI
 * and the terminal preview can never drift apart.
 */
export const NO_GPU_HINT =
  "No GPU detected — if running on a remote host, set { url: 'http://host:port' } in tui.json"

// ── pure parsing (unit-tested) ───────────────────────────────────────────────

/** One CSV line of nvidia-smi output into fields (handles quoted fields). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields
}

/** Integer or null — nvidia-smi prints "N/A" for values it can't report. */
function parseCount(value: string): number | null {
  const v = value.trim()
  if (!/^-?\d+$/.test(v)) return null
  return parseInt(v, 10)
}

/**
 * Parse nvidia-smi `--format=csv,noheader,nounits` output into one GpuInfo
 * per GPU actually detected — however many that is. Malformed lines are
 * skipped; blank lines are ignored. Returns [] for empty input (the
 * caller decides what that means).
 */
export function parseNvidiaSmiOutput(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const row = parseCsvLine(line)
    if (row.length < 6) continue
    const index = parseCount(row[0])
    const name = row[1].trim()
    if (index == null || !name) continue
    gpus.push({
      index,
      name,
      utilization_percent: parseCount(row[2]),
      memory_used_mib: parseCount(row[3]),
      memory_total_mib: parseCount(row[4]),
      temperature_c: parseCount(row[5]),
    })
  }
  return gpus
}

/** ISO 8601 UTC timestamp, second precision — matches the data contract. */
export function nowTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ── selftest sample (reporter --selftest) ───────────────────────────────────

// Mirrors the old Python reporter's SELFTEST_GPUS so the selftest payload
// stays recognizable. 4 GPUs on purpose: exercises the multi-GPU path.
export const SELFTEST_GPUS: GpuInfo[] = [
  { index: 0, name: 'Selftest GPU 0', utilization_percent: 12, memory_used_mib: 2048, memory_total_mib: 16384, temperature_c: 28 },
  { index: 1, name: 'Selftest GPU 1', utilization_percent: 67, memory_used_mib: 9588, memory_total_mib: 16384, temperature_c: 61 },
  { index: 2, name: 'Selftest GPU 2', utilization_percent: 0, memory_used_mib: 120, memory_total_mib: 16384, temperature_c: 30 },
  { index: 3, name: 'Selftest GPU 3', utilization_percent: 100, memory_used_mib: 15800, memory_total_mib: 16384, temperature_c: 91 },
]

/** One full selftest payload (no nvidia-smi involved). */
export function selftestStats(): GpuStats {
  return { timestamp: nowTimestamp(), gpus: SELFTEST_GPUS.map((g) => ({ ...g })) }
}

// ── live collection ──────────────────────────────────────────────────────────

/** Run nvidia-smi once, resolve with its stdout, reject with typed errors. */
export function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = NVIDIA_SMI_COMMAND
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new GpuStatsError(`nvidia-smi timed out after ${SMI_TIMEOUT_MS / 1000}s`))
    }, SMI_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ENOENT') {
        reject(new NoGpuError('nvidia-smi not found on PATH (NVIDIA-only support)'))
      } else {
        reject(new GpuStatsError(err.message))
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = (stderr || stdout).trim()
        if (detail.toLowerCase().includes('nvidia-smi: command not found')) {
          reject(new NoGpuError('nvidia-smi not found on PATH (NVIDIA-only support)'))
        } else {
          reject(new GpuStatsError(`nvidia-smi failed (exit ${code}): ${detail || 'no output'}`))
        }
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * One full payload: timestamp + one entry per GPU actually detected.
 *
 * - NoGpuError — no nvidia-smi, or nvidia-smi reports no GPUs
 * - GpuStatsError — anything else (timeout, non-zero exit, …)
 */
export async function collectGpuStats(): Promise<GpuStats> {
  let stdout: string
  try {
    stdout = await runNvidiaSmi()
  } catch (err) {
    if (err instanceof NoGpuError) throw err
    throw new GpuStatsError(err instanceof Error ? err.message : String(err))
  }
  const gpus = parseNvidiaSmiOutput(stdout)
  if (gpus.length === 0) {
    throw new NoGpuError('nvidia-smi returned no GPU data')
  }
  return { timestamp: nowTimestamp(), gpus }
}
