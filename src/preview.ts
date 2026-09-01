// Terminal preview of the GPU panel — a dev tool, not part of the plugin.
//
// It renders the exact same row data the TUI panel will show, but in a
// plain terminal, so the look can be checked without restarting anything.
//
// Each GPU is a small block: its label, then one line per metric in the
// order set by `barOrder` in src/visual-config.ts — btop-style: a short
// label, a full row of ■ blocks colored by position on a 0-100 gradient
// (the empty part is the same block in a dim color), the percent —
// colored by the gradient at its own value — and a value readout:
//
//   GPU0
//   Mem   90% ■■■■■■■■■■■■  11.2 GiB
//   Util  0% ■■■■■■■■■■■■
//
// Usage:
//   node src/preview.ts                       embedded mode: local GPU(s) via
//                                             nvidia-smi, updates in place (Ctrl+C quits)
//   node src/preview.ts --once                print one frame and exit
//   node src/preview.ts --sample              built-in sample data (no server needed)
//   node src/preview.ts --url http://host:9100  remote mode: poll that endpoint
//
// The endpoint URL comes from --url or the GPU_METRICS_URL env var. With
// neither, the preview — like the TUI panel — collects from local GPUs
// (embedded mode). There is deliberately no built-in default address.

import { VISUAL_CONFIG } from './visual-config.ts'
import { collectGpuStats, NoGpuError, NO_GPU_HINT } from './collect.ts'
import { describePanel, type BarSpec } from './gpu-bar.ts'
import type { GpuStats } from './types.ts'

// ── arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const once = args.includes('--once')
const sample = args.includes('--sample')
const urlFlag = args.indexOf('--url')
const url: string | undefined =
  urlFlag !== -1 ? args[urlFlag + 1] : process.env['GPU_METRICS_URL']

// ── ANSI helpers (terminal preview only — the TUI uses its own colors) ──────
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function fg(hex: string): string {
  const rgb = hexToRgb(hex)
  return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : ''
}

const LABEL_COLOR = VISUAL_CONFIG.colorLabel ? fg(VISUAL_CONFIG.colorLabel) : ''
const METRIC_TEXT = VISUAL_CONFIG.colorMetricText
  ? fg(VISUAL_CONFIG.colorMetricText)
  : DIM

// ── frame rendering ──────────────────────────────────────────────────────────
const SAMPLE_GPUS = [
  { index: 0, name: 'Sample GPU 0', utilization_percent: 0, memory_used_mib: 120, memory_total_mib: 12288 },
  { index: 1, name: 'Sample GPU 1', utilization_percent: 50, memory_used_mib: 6144, memory_total_mib: 12288 },
  { index: 2, name: 'Sample GPU 2', utilization_percent: 100, memory_used_mib: 12288, memory_total_mib: 12288 },
  { index: 3, name: 'Sample GPU 3', utilization_percent: null, memory_used_mib: 9947, memory_total_mib: 12288 },
]

function sampleStats(): GpuStats {
  return { timestamp: new Date().toISOString(), gpus: SAMPLE_GPUS }
}

// Line shape (btop's meter): label + space + bar + percent + "%" + (space + value).
// The bar is always exactly barWidth chars, so the readouts stay in column.
// The percent number is colored with the gradient at its own value; the
// label, "%" and value use the metric text color.
function barLine(spec: BarSpec): string {
  const bar = spec.blocks
    .map((b) => `${b.color ? fg(b.color) : DIM}${b.char}`)
    .join('')
  const pctColor = spec.percentColor ? fg(spec.percentColor) : METRIC_TEXT
  const pct = `${pctColor}${spec.percentText}${RESET}${METRIC_TEXT}%${RESET}`
  const value = spec.valueText ? ` ${METRIC_TEXT}${spec.valueText}${RESET}` : ''
  return `${BOLD}${METRIC_TEXT}${spec.label}${RESET} ${bar}${RESET}${pct}${value}`
}

function renderFrame(stats: GpuStats, mode: 'live' | 'sample' | 'local'): string {
  const lines: string[] = []
  lines.push(
    `${BOLD}GPU${RESET} ${DIM}— ${
      mode === 'live' ? 'live' : mode === 'local' ? 'local GPU(s)' : 'sample data'
    }${RESET}`,
  )
  describePanel(stats).forEach((row, i) => {
    if (i > 0) for (let g = 0; g < VISUAL_CONFIG.gapLines; g++) lines.push('')
    lines.push(`${LABEL_COLOR}${row.label}${RESET}`)
    for (const spec of row.bars) {
      lines.push(barLine(spec))
    }
  })
  const parsed = new Date(stats.timestamp)
  const clock = Number.isNaN(parsed.getTime())
    ? stats.timestamp
    : parsed.toLocaleTimeString([], { hour12: false })
  lines.push('')
  lines.push(`${DIM}updated ${clock}${RESET}`)
  return lines.join('\n') + '\n'
}

// ── output ───────────────────────────────────────────────────────────────────
const useAltScreen = !once && process.stdout.isTTY === true
let frames = 0

function writeFrame(text: string): void {
  if (!useAltScreen) {
    process.stdout.write(text)
    return
  }
  // First frame: switch to the alternate screen. After that: home + clear
  // below the cursor, so the previous frame never lingers.
  process.stdout.write(frames === 0 ? `\x1b[?1049h${text}` : `\x1b[H\x1b[J${text}`)
  frames++
}

process.on('SIGINT', () => {
  if (useAltScreen) process.stdout.write('\x1b[?1049l')
  process.exit(0)
})

// ── poll loop ────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  if (sample) {
    writeFrame(renderFrame(sampleStats(), 'sample'))
  } else if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status}`)
      const stats = (await res.json()) as GpuStats
      writeFrame(renderFrame(stats, 'live'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeFrame(
        `${BOLD}GPU${RESET} ${DIM}— live${RESET}\n` +
          `${fg(VISUAL_CONFIG.colorUtilTo)}cannot reach endpoint: ${msg}${RESET}\n` +
          `${DIM}retrying every ${VISUAL_CONFIG.refreshMs / 1000}s${RESET}\n`,
      )
    }
  } else {
    // Embedded mode — same code path as the TUI panel with no url option.
    try {
      const stats = await collectGpuStats()
      writeFrame(renderFrame(stats, 'local'))
    } catch (err) {
      if (err instanceof NoGpuError) {
        writeFrame(
          `${BOLD}GPU${RESET} ${DIM}— local${RESET}\n` +
            `${fg(VISUAL_CONFIG.colorUtilTo)}${NO_GPU_HINT}${RESET}\n`,
        )
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        writeFrame(
          `${BOLD}GPU${RESET} ${DIM}— local${RESET}\n` +
            `${fg(VISUAL_CONFIG.colorUtilTo)}cannot read GPU stats: ${msg}${RESET}\n` +
            `${DIM}retrying every ${VISUAL_CONFIG.refreshMs / 1000}s${RESET}\n`,
        )
      }
    }
  }
  if (!once) setTimeout(tick, VISUAL_CONFIG.refreshMs)
}

void tick()
