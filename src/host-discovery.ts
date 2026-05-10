// LAN host discovery. Browsers can't multicast, but they can fire HTTP
// requests at every IP on the local /24 with bounded concurrency, so
// we approximate "find me other oi-sving servers" by parallel-probing
// /rooms on each candidate. Each server already exposes /rooms with
// CORS open, so cross-origin probes work without server changes.
//
// This is intentionally a manual button rather than an automatic
// poll: 254 concurrent sockets on launch would burn battery on a
// phone and look like a port scan. Mobile-first, but the surface is
// platform-agnostic.

import { OiSving } from './namespace'

export interface HostRoom {
  code: string
  hostPlayerIds: string[]
  joinerCount: number
}

export interface HostScanResult {
  origin: string
  rooms: HostRoom[]
}

export interface ScanOpts {
  selfHost: string
  port: number
  timeoutMs?: number
  concurrency?: number
  signal?: AbortSignal
}

export function parseSubnet(host: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(host)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}`
}

// Returns one HostScanResult per responding /rooms endpoint. The
// caller decides what to do with the union (typically show a
// flattened room list keyed by origin so the user can pick which
// host to join).
export async function scanSubnet(opts: ScanOpts): Promise<HostScanResult[]> {
  const subnet = parseSubnet(opts.selfHost)
  if (!subnet) return []

  const timeoutMs = opts.timeoutMs ?? 600
  const concurrency = Math.max(1, opts.concurrency ?? 24)

  const queue: string[] = []
  for (let i = 1; i <= 254; i++) queue.push(`${subnet}.${i}`)

  const results: HostScanResult[] = []

  async function probe(ip: string): Promise<void> {
    const origin = `http://${ip}:${opts.port}`
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    if (opts.signal) opts.signal.addEventListener('abort', onAbort)
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${origin}/rooms`, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json().catch(() => null) as { rooms?: HostRoom[] } | null
      if (!data || !Array.isArray(data.rooms)) return
      results.push({ origin, rooms: data.rooms })
    } catch { /* unreachable / not us / aborted */ }
    finally {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }
  }

  async function worker(): Promise<void> {
    while (queue.length) {
      const ip = queue.shift()
      if (!ip) return
      if (opts.signal?.aborted) return
      await probe(ip)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

OiSving.HostDiscovery = {
  scanSubnet,
  parseSubnet,
}
