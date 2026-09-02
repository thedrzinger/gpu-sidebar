// The OpenCode TUI plugin: registers the sidebar_content slot and renders
// the same display rows as src/preview.ts — the pure rendering logic in
// src/gpu-bar.ts is shared, so the panel and the terminal preview always
// agree.
//
// Data source, in order of preference:
//   1. Remote mode — the plugin options (`url` entry in tui.json) or
//      $GPU_METRICS_URL: polls that endpoint (e.g. a gpu-sidebar-reporter
//      on another machine).
//   2. Embedded mode — no URL at all: calls collectGpuStats() in-process,
//      i.e. OpenCode and the GPU(s) are on the same machine.
//
// There is deliberately no built-in default address — keeps the package
// shareable.
//
// NOTE: this deliberately avoids JSX syntax (the host can load this file
// directly via a `file:` plugin reference, executed by Bun's default JSX
// transform, which we don't control) — but it is NOT static/imperative
// under the hood. sidebar_content's render callback is invoked by
// @opentui/solid's Slot component exactly ONCE per mount (confirmed by
// reading its source: the call is memoized on plugin-entry identity, which
// never changes here) — api.renderer.requestRender() only flushes a repaint
// of whatever's already mounted, it does not re-invoke render callbacks.
// So the tree must update itself reactively from the inside: state lives in
// solid-js signals, and insert() is called with a *function* accessor
// (rather than a plain value) so @opentui/solid wraps it in a
// createRenderEffect that re-runs — reconciling the mounted node tree in
// place — whenever a signal it reads changes. See src/tui.tsx git history /
// AGENTS.md for the debugging trail if this needs revisiting.

import { createElement, insert, setProp } from '@opentui/solid'
import { createSignal } from 'solid-js'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import type { PluginOptions } from '@opencode-ai/plugin'

import { collectGpuStats, NoGpuError, NO_GPU_HINT } from './collect.ts'
import { describePanel, type BarSpec, type GpuRow } from './gpu-bar.ts'
import { VISUAL_CONFIG } from './visual-config.ts'
import type { GpuStats } from './types.ts'

// ── low-level node builders (mirrors the pattern used by other working
// OpenCode TUI sidebar plugins) ──────────────────────────────────────────────

function element(tag: string, props: Record<string, unknown>, children: unknown[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value)
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) insert(node, child)
  }
  return node
}

function text(props: Record<string, unknown>, children: unknown[] = []) {
  return element('text', props, children)
}

function box(props: Record<string, unknown>, children: unknown[] = []) {
  return element('box', props, children)
}

function span(props: Record<string, unknown>, children: unknown[] = []) {
  return element('span', props, children)
}

function bold(props: Record<string, unknown>, children: unknown[] = []) {
  return element('b', props, children)
}

// ── data source ──────────────────────────────────────────────────────────────

function resolveUrl(options: PluginOptions | undefined): string | undefined {
  const fromOptions = options?.url
  if (typeof fromOptions === 'string' && fromOptions.trim()) {
    return fromOptions.trim()
  }
  const fromEnv = process.env['GPU_METRICS_URL']
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined
}

async function fetchStats(url: string): Promise<GpuStats> {
  const signal = AbortSignal.timeout(VISUAL_CONFIG.refreshMs + 3000)
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status}`)
  const payload = (await res.json()) as GpuStats
  if (!payload || !Array.isArray(payload.gpus)) {
    throw new Error('unexpected response shape')
  }
  return payload
}

// ── rendering ────────────────────────────────────────────────────────────────

function themed(api: TuiPluginApi, hex: string, fallback: 'text' | 'textMuted') {
  return hex || api.theme.current[fallback]
}

function metricLine(api: TuiPluginApi, spec: BarSpec) {
  const textFg = themed(api, VISUAL_CONFIG.colorMetricText, 'textMuted')
  const blockTexts = spec.blocks.map((block) =>
    text({ fg: block.color || textFg }, [block.char]),
  )
  const children: unknown[] = [
    text({ fg: textFg }, [`${spec.label} `]),
    ...blockTexts,
    text({ fg: spec.percentColor || textFg }, [spec.percentText]),
    text({ fg: textFg }, ['%']),
  ]
  if (spec.valueText) {
    children.push(text({ fg: spec.valueColor || textFg }, [` ${spec.valueText}`]))
  }
  return box({ flexDirection: 'row', gap: 0 }, children)
}

function gpuBlock(api: TuiPluginApi, row: GpuRow) {
  const labelFg = themed(api, VISUAL_CONFIG.colorLabel, 'text')
  return box({ gap: 0 }, [
    text({}, [bold({ fg: labelFg }, [row.label])]),
    ...row.bars.map((spec) => metricLine(api, spec)),
  ])
}

function buildPanel(
  api: TuiPluginApi,
  url: string | undefined,
  stats: GpuStats | undefined,
  error: string | undefined,
  noGpu: boolean,
) {
  const rows = stats ? describePanel(stats) : undefined
  if (rows && rows.length > 0) {
    const blocks = rows.map((row) => gpuBlock(api, row))
    if (rows.length > VISUAL_CONFIG.scrollAfterGpus) {
      return box({ gap: 0 }, [
        element('scrollbox', { scrollY: true, gap: VISUAL_CONFIG.gapLines }, blocks),
      ])
    }
    return box({ gap: 0 }, [box({ gap: VISUAL_CONFIG.gapLines }, blocks)])
  }
  if (error) {
    const message =
      noGpu && !url ? NO_GPU_HINT : `GPU metrics unavailable — ${error}`
    return box({ gap: 0 }, [text({ fg: api.theme.current.textMuted }, [message])])
  }
  return box({ gap: 0 }, [text({ fg: api.theme.current.textMuted }, ['GPU metrics…'])])
}

// ── plugin entry ─────────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api, options) => {
  const url = resolveUrl(options)

  const [stats, setStats] = createSignal<GpuStats | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [noGpu, setNoGpu] = createSignal(false)
  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined

  const load = async () => {
    try {
      const next = url ? await fetchStats(url) : await collectGpuStats()
      if (disposed) return
      setStats(next)
      setError(undefined)
      setNoGpu(false)
    } catch (err) {
      if (disposed) return
      if (err instanceof NoGpuError) setNoGpu(true)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (disposed) return
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(load, VISUAL_CONFIG.refreshMs)
      api.renderer.requestRender()
    }
  }

  await load()

  api.lifecycle.onDispose(() => {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
  })

  // sidebar_content is only ever called once by the host (see note above),
  // so the container must be built once here and kept alive — updates flow
  // into it reactively via insert()'s function-accessor form, not by the
  // host calling this factory again.
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: () => {
        const container = box({ gap: 0 })
        insert(container, () => buildPanel(api, url, stats(), error(), noGpu()))
        return container as any
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'gpu-sidebar',
  tui,
}

export default plugin
