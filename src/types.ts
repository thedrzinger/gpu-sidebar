// Wire format served by the gpu-sidebar reporter (and collected locally
// in embedded mode) — see README.md ("Data contract"). Field names and
// types are part of that contract; clients depend on them, so keep this
// in sync with src/collect.ts.

export interface GpuInfo {
  /** GPU number, as reported by the source machine. */
  index: number
  /** GPU model name. */
  name: string
  /** GPU utilization 0-100, or null when the driver can't report it. */
  utilization_percent: number | null
  /** VRAM used, in MiB, or null when the driver can't report it. */
  memory_used_mib: number | null
  /** Total VRAM, in MiB, or null when the driver can't report it. */
  memory_total_mib: number | null
}

export interface GpuStats {
  /** ISO 8601 UTC timestamp of the sample. */
  timestamp: string
  /** One entry per physical GPU, in index order. */
  gpus: GpuInfo[]
}
