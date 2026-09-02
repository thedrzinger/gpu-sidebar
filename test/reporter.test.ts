// Tests for the gpu-sidebar-reporter bin (src/reporter.ts): the HTTP
// behavior against a live selftest server (ephemeral port, no fixtures)
// plus the CLI surface (--help / no-args / --once).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

import { createReporterServer } from '../src/reporter.ts'
import { assertContractShape, nvidiaSmiOnPath } from './helpers.ts'

const REPORTER = fileURLToPath(new URL('../src/reporter.ts', import.meta.url))

async function withServer<T>(
  selftest: boolean,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = createReporterServer({ port: 0, bind: '127.0.0.1', selftest })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const addr = server.address() as AddressInfo
  try {
    return await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
}

test('selftest server: GET / is 200 application/json, contract-exact', async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    const body = (await res.json()) as unknown
    assertContractShape(body)
    assert.equal(body.gpus.length, 4)
  })
})

test('selftest server: two requests back-to-back both succeed (threaded OK)', async () => {
  await withServer(true, async (base) => {
    const [a, b] = await Promise.all([
      fetch(`${base}/`).then((r) => r.json()),
      fetch(`${base}/`).then((r) => r.json()),
    ])
    assertContractShape(a)
    assertContractShape(b)
  })
})

test('selftest server: unknown paths 404', async () => {
  await withServer(true, async (base) => {
    for (const path of ['/nope', '/metrics', '//']) {
      const res = await fetch(`${base}${path}`)
      assert.equal(res.status, 404, path)
    }
  })
})

test(
  'live server without nvidia-smi: GET / is 500 {"error"} mentioning NVIDIA',
  { skip: nvidiaSmiOnPath() },
  async () => {
    await withServer(false, async (base) => {
      const res = await fetch(`${base}/`)
      assert.equal(res.status, 500)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /nvidia-smi/)
      assert.match(body.error, /NVIDIA-only/)
    })
  },
)

test('CLI: --selftest --once prints one contract-shaped payload and exits 0', () => {
  const res = spawnSync(process.execPath, [REPORTER, '--selftest', '--once'], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  const body = JSON.parse(res.stdout) as unknown
  assertContractShape(body)
})

test('CLI: --help prints usage plus the exact tui.json line', () => {
  const res = spawnSync(process.execPath, [REPORTER, '--help'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Usage:/)
  assert.match(res.stdout, /--port/)
  assert.match(res.stdout, /--selftest/)
  assert.match(res.stdout, /tui\.json/)
  assert.match(res.stdout, /opencode\.json/)
  // The literal line to paste, with the detected host:port.
  assert.match(res.stdout, /\["gpu-sidebar", \{ "url": "http:\/\/[^\s"]+:\d+" \}\]/)
})

test('CLI: no args prints the same help and exits 0', () => {
  const res = spawnSync(process.execPath, [REPORTER], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Usage:/)
  assert.match(res.stdout, /\["gpu-sidebar", \{ "url": "http:\/\/[^\s"]+:\d+" \}\]/)
})

test('CLI: unknown flag prints an error and exits non-zero', () => {
  const res = spawnSync(process.execPath, [REPORTER, '--bogus'], { encoding: 'utf8' })
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /unknown argument/)
})

// npm installs `bin` entries as symlinks (e.g. `npm i -g`, npx). Regression
// test for a bug where invoking through such a symlink silently did
// nothing: process.argv[1] keeps the symlink path while import.meta.url
// resolves to the target's real path, so a naive equality check between
// them never matched and the CLI entry point point never ran.
test('CLI: still runs when invoked through a symlink (npm bin install)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-sidebar-symlink-'))
  const link = join(dir, 'gpu-sidebar-reporter')
  try {
    symlinkSync(REPORTER, link)
    const res = spawnSync(process.execPath, [link, '--selftest', '--once'], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assertContractShape(JSON.parse(res.stdout))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
