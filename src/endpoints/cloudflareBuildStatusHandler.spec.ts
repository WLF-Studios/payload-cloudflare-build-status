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
        CF_ACCOUNT_ID: 'account-id',
        CF_API_TOKEN: 'api-token',
        CF_WORKER_TAG: 'worker-tag',
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

  it('selects an active build and keeps other queued builds separate', async () => {
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
        CF_ACCOUNT_ID: 'account-id',
        CF_API_TOKEN: 'api-token',
        CF_WORKER_TAG: 'worker-tag',
      },
      fetchFn,
    })

    expect(result.build).toMatchObject({
      id: 'running-build',
      isActive: true,
      latestStage: {
        status: 'active',
      },
    })
    expect(result.queuedBuilds).toHaveLength(1)
    expect(result.queuedBuilds[0]?.id).toBe('queued-build')
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
        CF_ACCOUNT_ID: 'account-id',
        CF_API_TOKEN: 'api-token',
        CF_WORKER_NAME: 'my-worker',
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
      error: 'Unauthorized',
      queuedBuilds: [],
      siteUrl: 'https://example.com',
      status: 'error',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps Cloudflare API errors into a concise endpoint response', async () => {
    vi.stubEnv('CF_ACCOUNT_ID', 'account-id')
    vi.stubEnv('CF_API_TOKEN', 'api-token')
    vi.stubEnv('CF_WORKER_TAG', 'worker-tag')
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
