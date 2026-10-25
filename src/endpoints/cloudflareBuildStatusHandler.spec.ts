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
    payload: {
      kv: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
      logger: { warn: vi.fn() },
    },
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
      errorReason: 'Publishing is not configured; a developer needs to finish the setup.',
      queuedBuilds: [],
      serverTime: expect.any(String),
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
      errorReason: 'Your CMS session has ended; sign in again to see publishing progress.',
      queuedBuilds: [],
      serverTime: expect.any(String),
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
    expect(data.errorReason).toBe(
      'Build status cannot connect to the publishing service; a developer needs to restore its access.',
    )
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

describe('failed build reasons', () => {
  const now = '2026-10-25T10:02:00.000Z'
  const recentBuild = (id: string, outcome = 'fail', ended = '2026-10-25T10:01:00.000Z') => ({
    build_outcome: outcome,
    build_uuid: id,
    created_on: '2026-10-25T10:00:00.000Z',
    status: 'stopped',
    stopped_on: ended,
  })
  function setup(builds = [recentBuild('failed')]) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-id')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'api-token')
    vi.stubEnv('CLOUDFLARE_WORKER_TAG', 'worker-tag')
    const cache = new Map<string, unknown>()
    const req = {
      payload: {
        kv: {
          get: vi.fn((key: string) => Promise.resolve(cache.get(key))),
          set: vi.fn((key: string, value: unknown) => {
            cache.set(key, value)
            return Promise.resolve()
          }),
        },
        logger: { warn: vi.fn() },
      },
      user: { id: 'editor' },
    }
    const logFetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ result: { lines: [[1, 'Unknown error']], truncated: false } }),
      )
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input) =>
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes('/logs')
          ? logFetch(input)
          : Promise.resolve(Response.json({ result: builds })),
      )
    return { cache, fetchSpy, logFetch, req }
  }

  afterEach(() => vi.useRealTimers())

  it('follows log cursors, caches only the reason, and reuses it on the next poll', async () => {
    const { cache, logFetch, req } = setup()
    logFetch
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          result: { cursor: 'next/+=', lines: [[1, 'SECRET=value']], truncated: true },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ lines: [[2, 'verify-detached failed:']], truncated: false }),
      )
    const first = await (await cloudflareBuildStatusHandler(req as never)).json()
    const second = await (await cloudflareBuildStatusHandler(req as never)).json()
    expect(first.build.errorReason).toBe(
      'The site did not pass its publishing checks; a developer needs to fix the failing check.',
    )
    expect(second.build.errorReason).toBe(first.build.errorReason)
    expect(first.serverTime).toBe(now)
    expect(logFetch).toHaveBeenCalledTimes(2)
    expect(String(logFetch.mock.calls[1][0])).toContain('?cursor=next%2F%2B%3D')
    expect(cache.get('cloudflare-build-error:failed')).toBe(first.build.errorReason)
    expect(JSON.stringify(first)).not.toContain('SECRET')
    expect(JSON.stringify([...cache])).not.toContain('SECRET')
  })

  it('only downloads recent failures and cancellations, never older or successful builds', async () => {
    const { logFetch, req } = setup([
      recentBuild('old', 'fail', '2026-10-25T09:59:00.000Z'),
      recentBuild('success', 'success'),
      recentBuild('failed'),
      recentBuild('canceled', 'cancelled'),
    ])
    logFetch.mockImplementation(() =>
      Promise.resolve(Response.json({ lines: [], truncated: false })),
    )
    const data = await (await cloudflareBuildStatusHandler(req as never)).json()
    expect(logFetch.mock.calls.map(([url]) => String(url).split('/').at(-2))).toEqual([
      'failed',
      'canceled',
    ])
    expect(data.builds[0].errorReason).toBeUndefined()
    expect(data.builds[1].errorReason).toBeUndefined()
    expect(data.builds[3].errorReason).toBe(
      'Publishing was canceled; publish again when you are ready.',
    )
  })

  it('does not request logs for failures cleared by a newer successful publish', async () => {
    const { cache, logFetch, req } = setup([
      recentBuild('cleared-failure'),
      recentBuild('cleared-cancellation', 'cancelled'),
      { ...recentBuild('new-success', 'success'), created_on: '2026-10-25T10:00:30.000Z' },
      { ...recentBuild('later-error'), created_on: '2026-10-25T10:00:45.000Z' },
    ])
    const response = await cloudflareBuildStatusHandler(req as never)
    const data = await response.json()
    expect(logFetch.mock.calls.map(([url]) => String(url).split('/').at(-2))).toEqual([
      'later-error',
    ])
    expect(cache.has('cloudflare-build-error:cleared-failure')).toBe(false)
    expect(cache.has('cloudflare-build-error:cleared-cancellation')).toBe(false)
    expect(data.builds).toHaveLength(4)
    expect(data.builds[3].errorReason).toBeDefined()
  })

  it.each(['rate-limit', 'network', 'broken-cursor', 'malformed'])(
    'does not cache a %s log failure and keeps status available',
    async (failure) => {
      const { cache, logFetch, req } = setup()
      logFetch.mockReset()
      if (failure === 'network') {
        logFetch.mockRejectedValue(new Error('RAW_SECRET'))
      } else {
        logFetch.mockImplementation(() =>
          Promise.resolve(
            failure === 'rate-limit'
              ? Response.json({ errors: [{ message: 'RAW_SECRET' }] }, { status: 429 })
              : Response.json(
                  failure === 'malformed' ? {} : { cursor: 'same', lines: [], truncated: true },
                ),
          ),
        )
      }
      for (let poll = 0; poll < 2; poll++) {
        const response = await cloudflareBuildStatusHandler(req as never)
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.status).toBe('ok')
        expect(data.build.errorReason).toBeUndefined()
        expect(JSON.stringify(data)).not.toContain('RAW_SECRET')
      }
      expect(cache.size).toBe(0)
      expect(logFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(req.payload.logger.warn).toHaveBeenCalled()
    },
  )

  it('keeps a classified reason when KV is unavailable', async () => {
    const { logFetch, req } = setup()
    req.payload.kv.get.mockRejectedValue(new Error('KV unavailable'))
    req.payload.kv.set.mockRejectedValue(new Error('KV unavailable'))
    logFetch.mockImplementation(() =>
      Promise.resolve(Response.json({ lines: [[1, 'Build was timed out']], truncated: false })),
    )
    const data = await (await cloudflareBuildStatusHandler(req as never)).json()
    expect(data.status).toBe('ok')
    expect(data.build.errorReason).toContain('took too long')
  })

  it.each([
    [
      401,
      'Build status cannot connect to the publishing service; a developer needs to restore its access.',
    ],
    [
      403,
      'Build status cannot connect to the publishing service; a developer needs to restore its access.',
    ],
    [404, 'The publishing site could not be found; a developer needs to check its setup.'],
    [429, 'Build status is receiving too many requests; try again shortly.'],
    [503, 'The publishing service is temporarily unavailable; try again shortly.'],
  ])(
    'normalizes HTTP %s, logs the original error, and includes server time',
    async (status, reason) => {
      const { fetchSpy, req } = setup()
      fetchSpy.mockResolvedValue(
        Response.json({ errors: [{ message: 'RAW_SECRET' }] }, { status: Number(status) }),
      )
      const response = await cloudflareBuildStatusHandler(req as never)
      const data = await response.json()
      expect(response.status).toBe(status)
      expect(data.errorReason).toBe(reason)
      expect(data.serverTime).toBe(now)
      expect(JSON.stringify(data)).not.toContain('RAW_SECRET')
      expect(
        req.payload.logger.warn.mock.calls.some(
          ([detail]) => (detail as { err?: Error }).err?.message === 'RAW_SECRET',
        ),
      ).toBe(true)
    },
  )

  it('normalizes a server connection error and logs its details', async () => {
    const { fetchSpy, req } = setup()
    fetchSpy.mockRejectedValue(new Error('RAW_SECRET'))
    const data = await (await cloudflareBuildStatusHandler(req as never)).json()
    expect(data.errorReason).toBe('Build status is temporarily unavailable; try again shortly.')
    expect(data.serverTime).toBe(now)
    expect(JSON.stringify(data)).not.toContain('RAW_SECRET')
    expect(req.payload.logger.warn).toHaveBeenCalled()
  })

  it('explains missing worker configuration without fetching and logs the cause', async () => {
    const { fetchSpy, req } = setup()
    vi.stubEnv('CLOUDFLARE_WORKER_TAG', '')
    vi.stubEnv('CLOUDFLARE_WORKER_NAME', '')
    const data = await (await cloudflareBuildStatusHandler(req as never)).json()
    expect(data.status).toBe('not_configured')
    expect(data.errorReason).toBe(
      'Publishing is not configured; a developer needs to finish the setup.',
    )
    expect(data.serverTime).toBe(now)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(req.payload.logger.warn).toHaveBeenCalled()
  })
})
