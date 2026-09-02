#!/usr/bin/env node
// gpu-sidebar-reporter — serve GPU stats as JSON for the gpu-sidebar
// OpenCode plugin's remote mode.
//
// Replaces the old standalone Python reporter: same data contract (see
// README.md, "Data contract"), same flags, same log lines — but one
// language, one shared collectGpuStats() with the plugin, no Python
// dependency on the GPU host.
//
// Usage:
//   gpu-sidebar-reporter [--port 9100] [--bind 0.0.0.0] [--selftest] [--once]
//
// With no args (or --help) it prints usage plus the exact tui.json line
// to add on the machine that runs the OpenCode sidebar.

import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { collectGpuStats, selftestStats } from './collect.ts'
import type { GpuStats } from './types.ts'
export const DEFAULT_PORT = 9100
const PACKAGE_NAME = 'gpu-sidebar'

export interface ReporterOptions {
  port: number
  bind: string
  selftest: boolean
}

/**
 * Build (but do not start) the reporter HTTP server.
 *
 * GET /            → 200, one payload per the data contract
 * GET anything else → 404
 * collection fails at request time → 500 {"error": "..."} (never guess)
 */
export function createReporterServer(options: ReporterOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'GET' || path !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found\n')
      return
    }
    const sample = options.selftest ? Promise.resolve(selftestStats()) : collectGpuStats()
    sample
      .then((stats) => {
        const body = JSON.stringify(stats)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        const body = JSON.stringify({ error: msg })
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      })
  })
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Best-effort: first non-internal IPv4 address, for the tui.json hint. */
function detectLanIp(): string | undefined {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return undefined
}

export function helpText(port: number): string {
  const host = detectLanIp() ?? '<this-machine>'
  return `${PACKAGE_NAME}-reporter — serve GPU stats as JSON for the ${PACKAGE_NAME} plugin

Usage:
  ${PACKAGE_NAME}-reporter [options]

Options:
  --port PORT   Port to listen on (default: ${port}, or $GPU_METRICS_PORT)
  --bind ADDR   Address to bind (default: 0.0.0.0; use 127.0.0.1 for local-only)
  --selftest    Serve built-in sample data instead of calling nvidia-smi
  --once        Print one sample as JSON and exit (no server started)
  --help        Show this help

Once it is running, point the sidebar plugin at it by adding this line to
the "plugin" list in ~/.config/opencode/tui.json — NOT opencode.json
(this is a TUI plugin; the official plugin docs don't cover that system):

  [${JSON.stringify(PACKAGE_NAME)}, { "url": ${JSON.stringify(`http://${host}:${port}`)} }]

Reads stats via nvidia-smi. NVIDIA GPUs only.
`
}

function parseArgs(argv: string[]): {
  port: number
  bind: string
  selftest: boolean
  once: boolean
  help: boolean
  badArgs: boolean
} {
  const out = {
    port: parseInt(process.env['GPU_METRICS_PORT'] ?? String(DEFAULT_PORT), 10),
    bind: '0.0.0.0',
    selftest: false,
    once: false,
    help: false,
    badArgs: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--port':
        out.port = parseInt(argv[++i] ?? '', 10)
        break
      case '--bind':
        out.bind = argv[++i] ?? out.bind
        break
      case '--selftest':
        out.selftest = true
        break
      case '--once':
        out.once = true
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        console.error(`unknown argument: ${arg}`)
        out.badArgs = true
    }
  }
  if (!Number.isFinite(out.port) || out.port <= 0 || out.port > 65535) {
    console.error('invalid --port (need a number between 1 and 65535)')
    out.badArgs = true
  }
  return out
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help || argv.length === 0) {
    console.log(helpText(args.port))
    process.exit(0)
  }
  if (args.badArgs) {
    console.error(`\nrun with --help for usage`)
    process.exit(1)
  }

  if (args.once) {
    const stats: GpuStats = args.selftest
      ? selftestStats()
      : await collectGpuStats().catch((err: unknown) => {
          console.error(
            `cannot read GPU stats: ${err instanceof Error ? err.message : String(err)}`,
          )
          process.exit(1)
        })
    console.log(JSON.stringify(stats, null, 2))
    return
  }

  if (!args.selftest) {
    // Fail fast with a clear message instead of serving 500s forever.
    try {
      const probe = await collectGpuStats()
      console.log(`[gpu-sidebar-reporter] found ${probe.gpus.length} GPU(s)`)
    } catch (err) {
      console.error(
        `cannot read GPU stats: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
  }

  const server = createReporterServer(args)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, args.bind, () => resolve())
  })
  console.log(
    `[gpu-sidebar-reporter] serving on http://${args.bind}:${args.port}/ (selftest=${args.selftest})`,
  )
  const stop = () => {
    server.close()
    console.log('[gpu-sidebar-reporter] stopped')
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

// Only run the CLI when this file is the entry point (not when imported
// by tests or by the TUI plugin). Resolve argv[1] to its real path first —
// npm installs `bin` entries as symlinks, and import.meta.url already
// reflects the module's real path, so comparing the raw argv[1] against it
// would never match through a symlinked install (e.g. `npm i -g`, npx).
const invokedDirectly =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
