import type { Payload } from 'payload'

import config from '@payload-config'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

let payload: Payload

afterAll(async () => {
  await payload?.destroy()
})

beforeAll(async () => {
  payload = await getPayload({ config })
})

describe('Cloudflare build status plugin integration', () => {
  test('registers the admin action and status endpoint in the dev app', () => {
    expect(payload.config.admin.components?.actions).toContain(
      'payload-cloudflare-build-status/client#CloudflareBuildStatus',
    )
    expect(
      payload.config.endpoints?.some(
        (endpoint) => endpoint.method === 'get' && endpoint.path === '/cloudflare-build-status',
      ),
    ).toBe(true)
    expect((payload.collections as Record<string, unknown>)['plugin-collection']).toBeUndefined()
    expect(payload.collections.posts.config.fields).not.toContainEqual(
      expect.objectContaining({
        name: 'addedByPlugin',
      }),
    )
  })
})
