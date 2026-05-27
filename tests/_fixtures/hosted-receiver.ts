/**
 * Shared fixture — bind the hosted-ingest reference receiver to an OS-
 * assigned port and return the base URL + stores + a stop function.
 *
 * Both `hosted-roundtrip.test.ts` and `adapters-otel.test.ts` use this so
 * the boilerplate to spin up the receiver isn't duplicated, and any future
 * binding tweak (HTTPS, custom host, etc.) only changes here.
 */

import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import {
  createReferenceReceiverApp,
  type ReferenceReceiverStores,
  type TenantConfig,
} from '../../examples/hosted-ingest-server/server'

export interface BoundReceiver {
  baseUrl: string
  stores: ReferenceReceiverStores
  stop: () => Promise<void>
}

export async function startReceiver(tenants: TenantConfig[]): Promise<BoundReceiver> {
  const { app, stores } = createReferenceReceiverApp({ tenants })
  // Bind to port 0 — kernel picks an unused port; we read it off the
  // returned handle so concurrent tests don't fight over the same socket.
  const handle = serve({ fetch: app.fetch, port: 0 })
  const addr = handle.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return {
    baseUrl,
    stores,
    stop: () =>
      new Promise<void>((resolve) => {
        if (typeof (handle as { close?: (cb?: () => void) => void }).close === 'function') {
          ;(handle as { close: (cb: () => void) => void }).close(() => resolve())
        } else {
          resolve()
        }
      }),
  }
}
