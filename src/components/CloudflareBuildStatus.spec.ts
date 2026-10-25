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
      ended_on: status === 'success' ? '2026-10-25T10:01:20.000Z' : null,
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
      'Emily: Deploying1m 0s',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.textContent).toBe(
      'Tom: Installing30s',
    )
    expect(container.querySelector('[data-build-id="queued-build"]')?.textContent).toBe('Queued')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(container.querySelector('[data-build-id="first-build"]')?.getAttribute('title')).toBe(
      'Emily: Cloudflare Worker build: Deploying',
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
      'Emily: Published in 1m 20s',
    )
    const finishedSecond = build('second-build', 'success', second.createdOn)
    response = { ...response, build: finishedSecond, builds: [finishedFirst, finishedSecond] }
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.querySelectorAll('[data-build-id]')).toHaveLength(2)
    expect(container.querySelector('[data-build-id="first-build"]')?.textContent).toBe(
      'Emily: Published in 1m 20s',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.textContent).toBe(
      'Tom: Published in 50s',
    )
    expect(container.querySelector('[data-build-id="second-build"]')?.getAttribute('title')).toBe(
      'Tom: Cloudflare Worker build succeeded',
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
    expect(container.textContent).toBe('Samantha.B: Building50%')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(59_000))
    expect(container.textContent).toContain('99%')
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(container.textContent).toBe('Samantha.B: Building2m 0s')
    expect(container.textContent).not.toContain('100%')
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(container.textContent).toBe('Samantha.B: Building2m 10s')
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
