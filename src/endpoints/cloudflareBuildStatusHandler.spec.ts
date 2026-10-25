import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLOUDFLARE_API_BASE,
  cloudflareBuildStatusHandler,
  getCloudflareBuildStatus,
} from './cloudflareBuildStatusHandler.js'

type FetchCall = {
  init?: RequestInit
  url: string
}

function createFetchMock(responses: Response[]) {
  const calls: FetchCall[] = []
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    calls.push({
      init,
      url,
    })
    const response = responses.shift()

    if (!response) {
      throw new Error('Unexpected fetch call')
    }

    return Promise.resolve(response)
  }) as unknown as typeof fetch

  return {
    calls,
    fetchFn,
  }
}

function createPayloadRequest(user: null | Record<string, unknown> = { id: 'user-id' }) {
  return {
    user,
  } as never
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('getCloudflareBuildStatus', () => {
  it('returns a config-missing response when credentials are absent', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const result = await getCloudflareBuildStatus({
      env: {},
      fetchFn,
    })

    expect(result).toMatchObject({
      build: null,
      error: 'Cloudflare credentials not configured',
      queuedBuilds: [],
      status: 'not_configured',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('normalizes a successful stopped Worker build', async () => {
    const { calls, fetchFn } = createFetchMock([
      Response.json({
        result: [
          {
            build_outcome: 'success',
            build_trigger_metadata: {
              branch: 'main',
            },
            build_uuid: 'abc-123-def',
            created_on: '2026-04-24T10:00:00.000Z',
            running_on: '2026-04-24T10:00:05.000Z',
            status: 'stopped',
            stopped_on: '2026-04-24T10:01:00.000Z',
          },
        ],
        success: true,
      }),
    ])

    const result = await getCloudflareBuildStatus({
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_API_TOKEN: 'api-token',
        CLOUDFLARE_WORKER_TAG: 'worker-tag',
        PUBLIC_SITE_URL: 'https://example.com',
      },
      fetchFn,
    })

    expect(calls[0]?.url).toBe(
      `${CLOUDFLARE_API_BASE}/accounts/account-id/builds/workers/worker-tag/builds?per_page=10`,
    )
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer api-token',
    })
    expect(result).toMatchObject({
      build: {
        id: 'abc-123-def',
        isActive: false,
        isQueued: false,
        latestStage: {
          status: 'success',
        },
        shortId: 'abc',
        trigger: {
          branch: 'main',
        },
        url: 'https://example.com',
      },
      queuedBuilds: [],
      siteUrl: 'https://example.com',
      status: 'ok',
    })
  })

  it('returns each concurrent build while keeping the current build and queue compatible', async () => {
    const { fetchFn } = createFetchMock([
      Response.json({
        result: [
          {
            build_outcome: 'success',
            build_uuid: 'finished-build',
            status: 'stopped',
            stopped_on: '2026-04-24T10:01:00.000Z',
          },
          {
            build_uuid: 'queued-build',
            created_on: '2026-04-24T10:02:00.000Z',
            status: 'queued',
          },
          {
            build_uuid: 'initializing-build',
            created_on: '2026-04-24T10:02:30.000Z',
            status: 'initializing',
          },
          {
            build_uuid: 'running-build',
            created_on: '2026-04-24T10:03:00.000Z',
            running_on: '2026-04-24T10:03:05.000Z',
            status: 'running',
          },
        ],
        success: true,
      }),
    ])

    const result = await getCloudflareBuildStatus({
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_API_TOKEN: 'api-token',
        CLOUDFLARE_WORKER_TAG: 'worker-tag',
      },
      fetchFn,
    })

    expect(result.build).toMatchObject({
      id: 'initializing-build',
      isActive: true,
      latestStage: {
        status: 'active',
      },
    })
    expect(result.queuedBuilds).toHaveLength(1)
    expect(result.queuedBuilds[0]?.id).toBe('queued-build')
    expect(result.builds.map((build) => build.id)).toEqual([
      'finished-build',
      'queued-build',
      'initializing-build',
      'running-build',
    ])
    expect(result.builds.filter((build) => build.isActive)).toHaveLength(2)
  })

  it('resolves a worker name to its immutable worker tag', async () => {
    const { calls, fetchFn } = createFetchMock([
      Response.json({
        result: [
          {
            id: 'my-worker',
            tag: 'resolved-tag',
          },
        ],
        success: true,
      }),
      Response.json({
        result: [],
        success: true,
      }),
    ])

    const result = await getCloudflareBuildStatus({
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_API_TOKEN: 'api-token',
        CLOUDFLARE_WORKER_NAME: 'my-worker',
      },
      fetchFn,
    })

    expect(calls.map((call) => call.url)).toEqual([
      `${CLOUDFLARE_API_BASE}/accounts/account-id/workers/scripts`,
      `${CLOUDFLARE_API_BASE}/accounts/account-id/builds/workers/resolved-tag/builds?per_page=10`,
    ])
    expect(result).toMatchObject({
      build: null,
      queuedBuilds: [],
      status: 'ok',
    })
  })
})

describe('cloudflareBuildStatusHandler', () => {
  it('returns unauthorized without calling Cloudflare when there is no user', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://example.com')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'))

    const response = await cloudflareBuildStatusHandler(createPayloadRequest(null))
    const data = await response.json()

    expect(response.status).toBe(401)
    expect(data).toEqual({
      build: null,
      builds: [],
      error: 'Unauthorized',
      queuedBuilds: [],
      siteUrl: 'https://example.com',
      status: 'error',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps Cloudflare API errors into a concise endpoint response', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-id')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'api-token')
    vi.stubEnv('CLOUDFLARE_WORKER_TAG', 'worker-tag')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          errors: [
            {
              code: 10000,
              message: 'Authentication error',
            },
          ],
          success: false,
        },
        {
          status: 403,
        },
      ),
    )

    const response = await cloudflareBuildStatusHandler(createPayloadRequest())
    const data = await response.json()

    expect(response.status).toBe(403)
    expect(data).toMatchObject({
      build: null,
      queuedBuilds: [],
      status: 'error',
    })
    expect(data.error).toContain('Cloudflare authentication failed')
  })
})

describe('live build stages', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_API_TOKEN: 'api-token',
    CLOUDFLARE_WORKER_TAG: 'worker-tag',
  }

  it('reads each concurrent build stage from structured events even when logs are truncated', async () => {
    const types = ['initializing', 'cloning', 'installing_tools_and_deps', 'building', 'deploying']
    const { calls, fetchFn } = createFetchMock([
      Response.json({
        result: types.map((type) => ({ build_uuid: type, status: 'running' })),
        success: true,
      }),
      ...types.map((type, index) =>
        Response.json({
          cursor: 'more-log-lines',
          events: types.slice(0, index + 1).map((eventType, eventIndex) => ({
            type: eventType,
            ended_on: eventIndex < index ? `2026-10-25T10:00:0${eventIndex + 1}.000Z` : null,
            started_on: `2026-10-25T10:00:0${eventIndex}.000Z`,
          })),
          lines: [[1792873558200, 'Unrelated command output']],
          truncated: true,
        }),
      ),
    ])
    const result = await getCloudflareBuildStatus({ env, fetchFn })
    expect(result.builds.map((build) => build.latestStage.name)).toEqual([
      'initializing',
      'cloning',
      'installing',
      'build',
      'deploy',
    ])
    expect(result.builds.every((build) => build.latestStage.status === 'active')).toBe(true)
    expect(result.build?.latestStage.name).toBe('initializing')
    expect(result.builds[4]?.stages[3]).toMatchObject({
      name: 'build',
      ended_on: '2026-10-25T10:00:04.000Z',
      status: 'success',
    })
    expect(calls.slice(1).map((call) => call.url)).toEqual(
      types.map((type) => `${CLOUDFLARE_API_BASE}/accounts/account-id/builds/builds/${type}/logs`),
    )
    expect(JSON.stringify(result)).not.toContain('Unrelated command output')
  })

  it('keeps build status available when events are absent or logs are forbidden', async () => {
    const { fetchFn } = createFetchMock([
      Response.json({
        result: [
          { build_uuid: 'starting', status: 'initializing' },
          { build_uuid: 'running', status: 'running' },
        ],
      }),
      Response.json({ events: [] }),
      Response.json({ success: false }, { status: 403 }),
    ])
    const result = await getCloudflareBuildStatus({ env, fetchFn })
    expect(result.status).toBe('ok')
    expect(result.builds.map((build) => build.latestStage.name)).toEqual(['initializing', 'build'])
  })
})
