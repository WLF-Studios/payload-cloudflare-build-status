// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import type { CloudflareBuildStatusResponse, CloudflareBuildStatusWorkerBuild } from '../types.js'

import { CloudflareBuildStatus } from './CloudflareBuildStatus.js'

vi.mock('@payloadcms/ui', () => ({
  useConfig: () => ({ config: { routes: { api: '/api' } } }),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps each observed build badge after success and polls until the last build finishes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:01:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  function build(
    id: string,
    status: 'active' | 'queued' | 'success',
    createdOn: string,
  ): CloudflareBuildStatusWorkerBuild {
    const stage = {
      name: status === 'success' ? 'deploy' : 'build',
      ended_on:
        status === 'success'
          ? id === 'older-build'
            ? '2026-10-25T09:01:20.000Z'
            : new Date().toISOString()
          : null,
      started_on: createdOn,
      status: status === 'queued' ? ('idle' as const) : status,
    }
    return {
      id,
      createdOn,
      isActive: status === 'active',
      isQueued: status === 'queued',
      latestStage: stage,
      shortId: id.split('-')[0],
      stages: [stage],
      trigger:
        id === 'first-build'
          ? { publisher: 'Emily' }
          : id === 'second-build'
            ? { publisher: 'Tom' }
            : {},
    }
  }

  const first = build('first-build', 'active', '2026-10-25T10:00:00.000Z')
  const second = build('second-build', 'active', '2026-10-25T10:00:30.000Z')
  first.latestStage.name = 'deploy'
  second.latestStage.name = 'installing'
  const queued = build('queued-build', 'queued', '2026-10-25T10:00:50.000Z')
  let response: CloudflareBuildStatusResponse = {
    build: first,
    builds: [first, second, queued, build('older-build', 'success', '2026-10-25T09:00:00.000Z')],
    queuedBuilds: [queued],
    siteUrl: 'https://example.com',
    status: 'ok',
  }
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(response)))
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(3)
    expect(container.querySelector('[data-build-id="first-build"]')?.textContent).toBe(
      'Emily: Deploying62%',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.textContent).toBe(
      'Tom: Installing31%',
    )
    expect(container.querySelector('[data-build-id="queued-build"]')?.textContent).toBe('Queued')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[data-build-id="first-build"]')?.getAttribute('title')).toBe(
      'https://example.com',
    )

    const finishedFirst = build('first-build', 'success', first.createdOn)
    response = {
      ...response,
      build: finishedFirst,
      builds: [finishedFirst, second],
      queuedBuilds: [],
    }
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(2)
    expect(container.querySelector('[data-build-id="second-build"]')?.textContent).toBe(
      'Tom: Installing40s',
    )

    expect(container.querySelector('[data-build-id="first-build"]')?.textContent).toBe(
      'Emily: Published in 1m 0s',
    )
    const finishedSecond = build('second-build', 'success', second.createdOn)
    response = { ...response, build: finishedSecond, builds: [finishedFirst, finishedSecond] }
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(2)
    expect(container.querySelector('[data-build-id="first-build"]')?.textContent).toBe(
      'Emily: Published in 1m 0s',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.textContent).toBe(
      'Tom: Published in 40s',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.getAttribute('title')).toBe(
      'https://example.com',
    )
    const callsWhenFinished = fetchMock.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchMock).toHaveBeenCalledTimes(callsWhenFinished)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each([
  { durations: [40, 50, 60, 70, 80, 100, 120, 140, 160, 180], label: 'ten builds' },
  { durations: [60, 140], label: 'two available builds' },
  { durations: [100], label: 'one available build' },
])('averages $label with 20% overhead and shows elapsed time on overrun', async ({ durations }) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:01:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  function completed(
    id: string,
    endedOn: string,
    seconds: number,
  ): CloudflareBuildStatusWorkerBuild {
    const createdOn = new Date(Date.parse(endedOn) - seconds * 1000).toISOString()
    const stage = {
      name: 'deploy',
      ended_on: endedOn,
      started_on: createdOn,
      status: 'success' as const,
    }
    return {
      id,
      createdOn,
      isActive: false,
      isQueued: false,
      latestStage: stage,
      shortId: id,
      stages: [stage],
      trigger: {},
    }
  }
  const history = durations.map((seconds, index) =>
    completed(`previous-${index}`, `2026-10-25T09:${59 - index}:00.000Z`, seconds),
  )
  // The oldest result must not enter the ten-build average, even if returned first.
  const older = completed('older', '2026-10-25T09:40:00.000Z', 600)
  const finishedAfterStart = completed('concurrent', '2026-10-25T10:00:30.000Z', 600)
  const invalid = { ...history[0], id: 'invalid', createdOn: 'invalid' }
  const current: CloudflareBuildStatusWorkerBuild = {
    ...history[0],
    id: 'current',
    createdOn: '2026-10-25T10:00:00.000Z',
    isActive: true,
    latestStage: {
      name: 'build',
      ended_on: null,
      started_on: '2026-10-25T10:00:00.000Z',
      status: 'active',
    },
    shortId: 'current',
    stages: [],
    trigger: { publisher: 'Samantha.B' },
  }
  const response: CloudflareBuildStatusResponse = {
    build: current,
    builds: [
      ...(durations.length === 10 ? [older] : []),
      current,
      finishedAfterStart,
      invalid,
      ...history.reverse(),
    ],
    queuedBuilds: [],
    status: 'ok',
  }
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(response)))
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    // Each case averages 100 seconds, plus 20% = 120 seconds.
    expect(container.querySelector('[data-build-id="current"]')?.textContent).toBe(
      'Samantha.B: Building50%',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(59_000))
    expect(container.textContent).toContain('99%')
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(container.querySelector('[data-build-id="current"]')?.textContent).toBe(
      'Samantha.B: Building2m 0s',
    )
    expect(container.textContent).not.toContain('100%')
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.querySelector('[data-build-id="current"]')?.textContent).toBe(
      'Samantha.B: Building2m 10s',
    )
    expect(fetchMock).toHaveBeenCalledTimes(8)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
it.each([
  { expected: 'Building1m 0s', legacy: true, status: 200 },
  { expected: 'Error', legacy: false, status: 401 },
])('handles a $status response without a builds array', async ({ expected, legacy, status }) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:01:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const response = legacy
    ? {
        build: {
          id: 'legacy',
          createdOn: '2026-10-25T10:00:00.000Z',
          isActive: true,
          isQueued: false,
          latestStage: {
            name: 'build',
            ended_on: null,
            started_on: '2026-10-25T10:00:00.000Z',
            status: 'active',
          },
          shortId: 'legacy',
          stages: [],
          trigger: {},
        },
        queuedBuilds: [],
        status: 'ok',
      }
    : { errors: [{ message: 'Unauthorized' }] }
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(response, { status })))
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.textContent).toBe(expected)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    if (legacy) {
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toBe('Building1m 10s')
    } else {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(container.textContent).toBe('Error')
    }
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

function completedBuild(id: string, endedOn: string): CloudflareBuildStatusWorkerBuild {
  const stage = {
    name: 'deploy',
    ended_on: endedOn,
    started_on: '2026-10-25T10:00:00.000Z',
    status: 'success' as const,
  }
  return {
    id,
    createdOn: stage.started_on,
    isActive: false,
    isQueued: false,
    latestStage: stage,
    shortId: id,
    stages: [stage],
    trigger: { publisher: 'Emily' },
    url: 'https://example.com/golf/',
  }
}

it('restores separate completed badges after reload and expires each three minutes after completion without polling', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:02:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const first = completedBuild('first', '2026-10-25T10:01:00.000Z')
  const second = completedBuild('second', '2026-10-25T10:01:30.000Z')
  const old = completedBuild('old', '2026-10-25T09:00:00.000Z')
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      Response.json({
        build: second,
        builds: [second, first, old],
        queuedBuilds: [],
        status: 'ok',
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.append(container)
  let root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(2)
    expect(container.querySelector('[data-build-id="first"]')?.textContent).toBe(
      'Emily: Published in 1m 0s',
    )
    await act(async () => vi.advanceTimersByTimeAsync(90_000))
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(2)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(container.querySelector('[data-build-id="first"]')).toBeNull()
    expect(container.querySelector('[data-build-id="second"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(0)
    expect(container.textContent).toBe('Live')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each(['active', 'queued', 'failure', 'canceled', 'success'] as const)(
  'links only successful builds to their recorded page: %s',
  async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-25T10:02:00.000Z'))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const build = completedBuild('page', '2026-10-25T10:01:00.000Z')
    build.isActive = status === 'active'
    build.isQueued = status === 'queued'
    build.latestStage.status = status === 'queued' ? 'idle' : status
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            build,
            builds: [build],
            queuedBuilds: [],
            siteUrl: 'https://example.com',
            status: 'ok',
          }),
        ),
      ),
    )
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(CloudflareBuildStatus))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-build-id="page"]')?.getAttribute('title')).toBe(
        status === 'failure'
          ? 'The site build failed; a developer needs to check the build log.'
          : status === 'canceled'
            ? 'Publishing was canceled; publish again when you are ready.'
            : 'https://example.com/golf/',
      )
      if (status === 'success') {
        expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/golf/')
      } else {
        expect(container.querySelector('a')).toBeNull()
      }
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)

it.each(['empty', 'expired-success', 'expired-failure'])(
  'shows a plain green Live site link for %s',
  async (scenario) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-25T10:05:00.000Z'))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const build = completedBuild('old', '2026-10-25T10:01:00.000Z')
    if (scenario === 'expired-failure') {
      build.latestStage.status = 'failure'
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            build: scenario === 'empty' ? null : build,
            builds: scenario === 'empty' ? [] : [build],
            queuedBuilds: [],
            siteUrl: 'https://staging.example.com',
            status: 'ok',
          }),
        ),
      ),
    )
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(CloudflareBuildStatus))
        await Promise.resolve()
      })
      expect(container.textContent).toBe('Live')
      const link = container.querySelector('a')
      expect(link?.getAttribute('href')).toBe('https://staging.example.com')
      expect(link?.getAttribute('title')).toBe('https://staging.example.com')
      expect(link?.querySelector('span')?.style.backgroundColor).toBe('#22c55e')
      expect(container.querySelector('[data-build-id]')).toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)

it('uses server time for expiry when the browser clock is ten minutes ahead', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:12:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const build = completedBuild('recent', '2026-10-25T10:01:00.000Z')
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          build,
          builds: [build],
          queuedBuilds: [],
          serverTime: '2026-10-25T10:02:00.000Z',
          status: 'ok',
        }),
      ),
    ),
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.textContent).toBe('Emily: Published in 1m 0s')
    await act(async () => vi.advanceTimersByTimeAsync(119000))
    expect(container.querySelector('[data-build-id="recent"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.textContent).toBe('Live')
    expect(container.querySelector('a')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each([
  {
    label: 'Failed',
    reason: 'The site could not load its content; try publishing again shortly.',
    status: 'failure',
  },
  { label: 'Canceled', reason: 'Replaced by a newer publish.', status: 'canceled' },
])('shows only the editor reason on the $label badge', async ({ label, reason, status }) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:02:00.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const build = { ...completedBuild('failed', '2026-10-25T10:01:00.000Z'), errorReason: reason }
  build.latestStage.status = status as 'canceled' | 'failure'
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(Response.json({ build, builds: [build], queuedBuilds: [], status: 'ok' })),
    ),
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.textContent).toBe(`Emily: ${label}`)
    expect(container.querySelector('[data-build-id]')?.getAttribute('title')).toBe(reason)
    expect(container.querySelector('a')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each([
  {
    httpStatus: 500,
    label: 'Error',
    reason: 'Build status is temporarily unavailable; try again shortly.',
    response: { error: 'RAW_SECRET', status: 'error' },
  },
  {
    httpStatus: 200,
    label: 'Config missing',
    reason: 'Publishing is not configured; a developer needs to finish the setup.',
    response: { error: 'RAW_CONFIG', status: 'not_configured' },
  },
  {
    httpStatus: 0,
    label: 'Error',
    reason: 'Build status could not be reached; check your connection and try again shortly.',
    response: null,
  },
])('provides a safe hover sentence for $label', async ({ httpStatus, label, reason, response }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      response
        ? Promise.resolve(Response.json(response, { status: httpStatus }))
        : Promise.reject(new Error('RAW_NETWORK')),
    ),
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.textContent).toBe(label)
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(reason)
    expect(container.innerHTML).not.toContain('RAW_')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each(['failure', 'canceled'] as const)(
  'clears an older %s only when a newer publish succeeds, including after reload',
  async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-25T10:02:00.000Z'))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const failed = completedBuild('previous-error', '2026-10-25T10:01:00.000Z')
    failed.latestStage.status = status
    const previousSuccess = completedBuild('previous-success', '2026-10-25T10:00:45.000Z')
    previousSuccess.createdOn = '2026-10-25T09:59:00.000Z'
    const retry = completedBuild('retry', '2026-10-25T10:01:30.000Z')
    retry.createdOn = '2026-10-25T10:00:30.000Z'
    retry.url = 'https://example.com/a-different-page/'
    retry.isQueued = true
    retry.latestStage.status = 'idle'
    retry.latestStage.ended_on = null
    const laterError = completedBuild('later-error', '2026-10-25T10:01:45.000Z')
    laterError.createdOn = '2026-10-25T10:00:45.000Z'
    laterError.latestStage.status = 'failure'
    // Deliberately unsorted: chronology comes from timestamps, not array position.
    const response = {
      build: retry,
      builds: [failed, laterError, previousSuccess, retry],
      queuedBuilds: [],
      siteUrl: 'https://example.com',
      status: 'ok',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(response))),
    )
    const container = document.createElement('div')
    document.body.append(container)
    let root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(CloudflareBuildStatus))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-build-id="previous-error"]')).not.toBeNull()
      retry.isQueued = false
      retry.isActive = true
      retry.latestStage.status = 'active'
      await act(async () => vi.advanceTimersByTimeAsync(10_000))
      expect(container.querySelector('[data-build-id="previous-error"]')).not.toBeNull()
      retry.isActive = false
      retry.latestStage.status = 'success'
      retry.latestStage.ended_on = new Date().toISOString()
      await act(async () => vi.advanceTimersByTimeAsync(10_000))
      expect(container.querySelector('[data-build-id="previous-error"]')).toBeNull()
      expect(container.querySelector('[data-build-id="later-error"]')).not.toBeNull()
      expect(container.querySelectorAll('a')).toHaveLength(2)
      act(() => root.unmount())
      root = createRoot(container)
      await act(async () => {
        root.render(createElement(CloudflareBuildStatus))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-build-id="previous-error"]')).toBeNull()
      expect(container.querySelector('[data-build-id="later-error"]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)

it('does not restore a cleared error when the newer success badge expires', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T10:04:20.000Z'))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const error = completedBuild('slow-older-error', '2026-10-25T10:02:00.000Z')
  error.latestStage.status = 'failure'
  const success = completedBuild('newer-success', '2026-10-25T10:01:30.000Z')
  success.createdOn = '2026-10-25T10:00:30.000Z'
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          build: success,
          builds: [error, success],
          queuedBuilds: [],
          siteUrl: 'https://example.com',
          status: 'ok',
        }),
      ),
    ),
  )
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(CloudflareBuildStatus))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-build-id="slow-older-error"]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.textContent).toBe('Live')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  } finally {
    act(() => root.unmount())
  }
})
