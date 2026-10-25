import type { PayloadRequest } from 'payload'

import { afterEach, expect, it, vi } from 'vitest'

import { cloudflareBuildStatusHandler } from './endpoints/cloudflareBuildStatusHandler.js'
import * as plugin from './index.js'

const values = new Map<string, unknown>()
const req = {
  payload: {
    config: { admin: { user: 'users' } },
    find: vi.fn().mockResolvedValue({
      docs: [{ name: 'Emily Wilson' }, { name: 'Samantha Brown' }, { name: 'Samantha Jones' }],
    }),
    kv: {
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      set: (key: string, value: unknown) => {
        values.set(key, value)
        return Promise.resolve()
      },
    },
    logger: { warn: vi.fn() },
  },
  user: { id: 'emily', name: 'Emily Wilson', collection: 'users' },
} as unknown as PayloadRequest

afterEach(() => {
  values.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('keeps each publisher attached to the exact build for every admin viewer', async () => {
  expect(plugin).toHaveProperty('recordCloudflareBuildPublisher')
  await plugin.recordCloudflareBuildPublisher({
    req,
    response: Response.json({ build_uuid: 'emily-build' }),
  })
  await plugin.recordCloudflareBuildPublisher({
    req: {
      ...req,
      user: { id: 'tom', name: 'Samantha Brown', collection: 'users' },
    } as PayloadRequest,
    response: Response.json({ result: { build_uuid: 'tom-build' } }),
  })
  // A deploy hook can return an existing queued build. Keep its original publisher.
  await plugin.recordCloudflareBuildPublisher({
    req: { ...req, user: { id: 'other', name: 'Other', collection: 'users' } } as PayloadRequest,
    response: Response.json({ already_exists: true, build_uuid: 'emily-build' }),
  })
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token')
  vi.stubEnv('CLOUDFLARE_WORKER_TAG', 'worker')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        result: [
          { build_uuid: 'emily-build', status: 'running' },
          { build_uuid: 'tom-build', status: 'queued' },
          {
            build_trigger_metadata: { author: 'git-author' },
            build_uuid: 'git-build',
            status: 'running',
          },
        ],
        success: true,
      }),
    ),
  )
  const result = await cloudflareBuildStatusHandler({
    ...req,
    user: { id: 'viewer', name: 'Viewer', collection: 'users' },
  } as PayloadRequest)
  const data = await result.json()
  expect(result.status).toBe(200)
  expect(data.build.trigger.publisher).toBe('Emily')
  expect(data.queuedBuilds[0].trigger.publisher).toBe('Samantha.B')
  expect(
    data.builds.map((build: { trigger: { publisher?: string } }) => build.trigger.publisher),
  ).toEqual(['Emily', 'Samantha.B', undefined])
})

it('does not invent a publisher for failed, malformed, or anonymous deploys', async () => {
  expect(plugin).toHaveProperty('recordCloudflareBuildPublisher')
  for (const response of [
    Response.json({ build_uuid: 'failed' }, { status: 500 }),
    Response.json({}),
    new Response('not json'),
  ]) {
    await plugin.recordCloudflareBuildPublisher({ req, response })
  }
  await plugin.recordCloudflareBuildPublisher({
    req: { ...req, user: null },
    response: Response.json({ build_uuid: 'anonymous' }),
  })
  expect(values.size).toBe(0)
})

it('does not fail a successful deployment when publisher storage is unavailable', async () => {
  expect(plugin).toHaveProperty('recordCloudflareBuildPublisher')
  const brokenReq = {
    ...req,
    payload: {
      ...req.payload,
      kv: {
        set: () => Promise.reject(new Error('offline')),
      },
    },
  } as unknown as PayloadRequest
  await expect(
    plugin.recordCloudflareBuildPublisher({
      req: brokenReq,
      response: Response.json({ build_uuid: 'build' }),
    }),
  ).resolves.toBeUndefined()
})

it('keeps build status available when publisher storage cannot be read', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account')
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token')
  vi.stubEnv('CLOUDFLARE_WORKER_TAG', 'worker')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        result: [{ build_uuid: 'build', status: 'running' }],
        success: true,
      }),
    ),
  )
  const brokenReq = {
    ...req,
    payload: {
      ...req.payload,
      kv: {
        get: () => Promise.reject(new Error('offline')),
      },
    },
  } as unknown as PayloadRequest
  const response = await cloudflareBuildStatusHandler(brokenReq)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    build: { id: 'build', isActive: true },
    status: 'ok',
  })
})
