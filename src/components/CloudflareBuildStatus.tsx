'use client'

import { useConfig } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CloudflareBuildStatusResponse, CloudflareBuildStatusWorkerBuild } from '../types.js'

import classes from './CloudflareBuildStatus.module.css'
import { installFetchInterceptor } from './fetchInterceptor.js'

type ClientPluginConfig = {
  endpointPath?: string
  pollIntervalSeconds?: number
}

const DEFAULT_ENDPOINT_PATH = '/cloudflare-build-status'
const DEFAULT_POLL_INTERVAL_SECONDS = 10
const PLUGIN_CUSTOM_KEY = 'cloudflareBuildStatusPlugin'
const POST_SAVE_WATCH_INTERVAL_MS = 2_000
const POST_SAVE_WATCH_MS = 30_000

const statusColors = {
  active: '#f97316',
  canceled: '#f59e0b',
  error: '#ef4444',
  idle: '#6b7280',
  loading: '#60a5fa',
  success: '#22c55e',
} as const

function getClientPluginConfig(config: unknown): ClientPluginConfig {
  const custom = (config as { custom?: Record<string, unknown> } | undefined)?.custom
  const pluginConfig = custom?.[PLUGIN_CUSTOM_KEY]

  if (!pluginConfig || typeof pluginConfig !== 'object') {
    return {}
  }

  return pluginConfig as ClientPluginConfig
}

function normalizeEndpointPath(path: string): `/${string}` {
  return (path.startsWith('/') ? path : `/${path}`) as `/${string}`
}

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  return `${minutes}m ${remainingSeconds}s`
}

function getBuildDurationSeconds(
  build: CloudflareBuildStatusWorkerBuild | null | undefined,
): null | number {
  if (!build?.createdOn) {
    return null
  }

  const endedOn = build.stages.find((stage) => stage.name === 'deploy')?.ended_on

  if (!endedOn) {
    return null
  }

  const start = new Date(build.createdOn).getTime()
  const end = new Date(endedOn).getTime()

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null
  }

  return Math.floor((end - start) / 1000)
}

function getBuilds(data: CloudflareBuildStatusResponse | null): CloudflareBuildStatusWorkerBuild[] {
  if (Array.isArray(data?.builds)) {
    return data.builds
  }

  // Older endpoints return only the current build and queue; API errors may return neither.
  return [data?.build, ...(data?.queuedBuilds ?? [])].filter(
    (build): build is CloudflareBuildStatusWorkerBuild => Boolean(build),
  )
}

function getEstimatedBuildDuration(data: CloudflareBuildStatusResponse | null): null | number {
  const startedAt = Date.parse(data?.build?.createdOn ?? '')
  const completed: Array<{ endedAt: number; seconds: number }> = []

  for (const build of getBuilds(data)) {
    if (build.id === data?.build?.id || build.isActive || build.isQueued) {
      continue
    }
    const endedAt = Date.parse(
      build.stages.find((stage) => stage.name === 'deploy')?.ended_on ?? '',
    )
    const seconds = getBuildDurationSeconds(build)
    if (seconds && endedAt <= startedAt) {
      completed.push({ endedAt, seconds })
    }
  }

  const recent = completed.sort((a, b) => b.endedAt - a.endedAt).slice(0, 10)
  if (!recent.length) {
    return null
  }
  const average = recent.reduce((total, build) => total + build.seconds, 0) / recent.length
  return Math.ceil(average * 1.2)
}
function hasActiveOrQueuedBuild(data: CloudflareBuildStatusResponse | null): boolean {
  return getBuilds(data).some((build) => build.isActive || build.isQueued)
}

function getStatusLabel(args: {
  buildDuration: null | number
  data: CloudflareBuildStatusResponse | null
  error: null | string
  isLoading: boolean
}): {
  color: string
  label: string
  title: string
} {
  const { buildDuration, data, error, isLoading } = args

  if (isLoading && !data) {
    return {
      color: statusColors.loading,
      label: 'Loading',
      title: 'Loading Cloudflare build status',
    }
  }

  if (error || data?.status === 'error') {
    return {
      color: statusColors.error,
      label: 'Error',
      title: error || data?.error || 'Cloudflare build status error',
    }
  }

  if (data?.status === 'not_configured') {
    return {
      color: statusColors.idle,
      label: 'Config missing',
      title: data.error || 'Cloudflare credentials are not configured',
    }
  }

  const build = data?.build

  if (!build) {
    return {
      color: statusColors.idle,
      label: 'Ready',
      title: 'No Cloudflare Worker build found',
    }
  }

  if (build.isQueued) {
    return {
      color: statusColors.idle,
      label: 'Queued',
      title: 'Cloudflare Worker build queued',
    }
  }

  if (build.isActive) {
    const stageLabels: Record<string, string> = {
      build: 'Building',
      cloning: 'Cloning',
      deploy: 'Deploying',
      initializing: 'Initializing',
      installing: 'Installing',
    }
    const label = stageLabels[build.latestStage.name] ?? 'Building'
    return {
      color: statusColors.active,
      label,
      title: `Cloudflare Worker build: ${label}`,
    }
  }

  if (build.latestStage.status === 'success') {
    return {
      color: statusColors.success,
      label: buildDuration === null ? 'Live' : `Published in ${formatTime(buildDuration)}`,
      title: 'Cloudflare Worker build succeeded',
    }
  }

  if (build.latestStage.status === 'failure') {
    return {
      color: statusColors.error,
      label: 'Failed',
      title: 'Cloudflare Worker build failed',
    }
  }

  if (build.latestStage.status === 'canceled') {
    return {
      color: statusColors.canceled,
      label: 'Canceled',
      title: 'Cloudflare Worker build canceled',
    }
  }

  return {
    color: statusColors.idle,
    label: 'Ready',
    title: 'Cloudflare Worker build status ready',
  }
}

export const CloudflareBuildStatus = () => {
  const { config } = useConfig()
  const clientPluginConfig = getClientPluginConfig(config)
  const endpointPath = normalizeEndpointPath(
    clientPluginConfig.endpointPath ?? DEFAULT_ENDPOINT_PATH,
  )
  const activePollIntervalMs =
    (clientPluginConfig.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
  const [data, setData] = useState<CloudflareBuildStatusResponse | null>(null)
  const [observedBuildIDs, setObservedBuildIDs] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<null | string>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [postSaveWatchUntil, setPostSaveWatchUntil] = useState<null | number>(null)
  const requestSequenceRef = useRef(0)

  const statusURL = useMemo(
    () =>
      formatAdminURL({
        apiRoute: config.routes.api,
        path: endpointPath,
      }),
    [config.routes.api, endpointPath],
  )

  const fetchStatus = useCallback(async (): Promise<CloudflareBuildStatusResponse | null> => {
    const requestID = requestSequenceRef.current + 1
    requestSequenceRef.current = requestID

    try {
      const response = await fetch(statusURL, {
        cache: 'no-store',
      })
      const nextData = (await response.json()) as CloudflareBuildStatusResponse

      if (requestID !== requestSequenceRef.current) {
        return null
      }

      if (response.ok && nextData.status === 'ok') {
        setObservedBuildIDs((previous) => {
          const ids = new Set(previous)
          for (const build of getBuilds(nextData)) {
            if (build.isActive || build.isQueued) {
              ids.add(build.id)
            }
          }
          return ids.size === previous.size ? previous : ids
        })
      }
      setData(nextData)
      setError(response.ok ? null : nextData.error || `Error: ${response.status}`)

      return nextData
    } catch {
      if (requestID === requestSequenceRef.current) {
        setError('Connection error')
      }

      return null
    } finally {
      if (requestID === requestSequenceRef.current) {
        setIsLoading(false)
      }
    }
  }, [statusURL])

  useEffect(() => {
    installFetchInterceptor(endpointPath)
    setIsLoading(true)
    void fetchStatus()
  }, [endpointPath, fetchStatus])

  const hasActiveOrQueued = hasActiveOrQueuedBuild(data)
  const shouldPoll = hasActiveOrQueued || postSaveWatchUntil !== null
  const statusPollIntervalMs = hasActiveOrQueued
    ? activePollIntervalMs
    : POST_SAVE_WATCH_INTERVAL_MS

  useEffect(() => {
    const handleSaveComplete = () => {
      setPostSaveWatchUntil(Date.now() + POST_SAVE_WATCH_MS)
      void fetchStatus().then((nextData) => {
        if (hasActiveOrQueuedBuild(nextData)) {
          setPostSaveWatchUntil(null)
        }
      })
    }

    window.addEventListener('payload-save-complete', handleSaveComplete)

    return () => window.removeEventListener('payload-save-complete', handleSaveComplete)
  }, [fetchStatus])

  useEffect(() => {
    if (postSaveWatchUntil === null) {
      return
    }

    const remainingMs = Math.max(0, postSaveWatchUntil - Date.now())
    const timeout = window.setTimeout(() => {
      setPostSaveWatchUntil(null)
    }, remainingMs)

    return () => window.clearTimeout(timeout)
  }, [postSaveWatchUntil])

  useEffect(() => {
    if (hasActiveOrQueued && postSaveWatchUntil !== null) {
      setPostSaveWatchUntil(null)
    }
  }, [hasActiveOrQueued, postSaveWatchUntil])

  useEffect(() => {
    if (!shouldPoll) {
      return
    }

    const interval = window.setInterval(() => {
      void fetchStatus().then((nextData) => {
        if (hasActiveOrQueuedBuild(nextData)) {
          setPostSaveWatchUntil(null)
        }
      })
    }, statusPollIntervalMs)

    return () => window.clearInterval(interval)
  }, [fetchStatus, shouldPoll, statusPollIntervalMs])

  const observedBuilds = getBuilds(data).filter(
    (build) => build.isActive || build.isQueued || observedBuildIDs.has(build.id),
  )
  const visibleBuilds = observedBuilds.length > 0 ? observedBuilds : data?.build ? [data.build] : []

  return (
    <div className={classes.wrapper} data-admin-action="cloudflare-build-status">
      {!error && data?.status === 'ok' && visibleBuilds.length > 0 ? (
        visibleBuilds.map((build) => (
          <BuildStatusBadge
            data={{ ...data, build }}
            error={null}
            isLoading={false}
            key={build.id}
          />
        ))
      ) : (
        <BuildStatusBadge data={data} error={error} isLoading={isLoading} />
      )}
    </div>
  )
}

function BuildStatusBadge({
  data,
  error,
  isLoading,
}: {
  data: CloudflareBuildStatusResponse | null
  error: null | string
  isLoading: boolean
}) {
  const [buildDuration, setBuildDuration] = useState<null | number>(null)
  const [elapsedTime, setElapsedTime] = useState(0)
  const wasActiveRef = useRef(false)

  useEffect(() => {
    if (data?.build?.isActive || data?.build?.isQueued) {
      wasActiveRef.current = true
      setBuildDuration(null)

      return
    }

    if (wasActiveRef.current && data?.build?.latestStage.status === 'success') {
      setBuildDuration(getBuildDurationSeconds(data?.build))
      wasActiveRef.current = false
    }
  }, [
    data,
    data?.build?.id,
    data?.build?.isActive,
    data?.build?.isQueued,
    data?.build?.latestStage.status,
  ])

  useEffect(() => {
    if (!data?.build?.isActive || !data.build.createdOn) {
      return
    }

    const updateTimer = () => {
      const start = new Date(data.build?.createdOn ?? '').getTime()

      if (Number.isFinite(start)) {
        setElapsedTime(Math.max(0, Math.floor((Date.now() - start) / 1000)))
      }
    }

    updateTimer()

    const interval = window.setInterval(updateTimer, 1000)

    return () => window.clearInterval(interval)
  }, [data?.build?.createdOn, data?.build?.isActive])

  const badge = getStatusLabel({
    buildDuration,
    data,
    error,
    isLoading,
  })
  const siteUrl = data?.siteUrl
  const build = !error && data?.status === 'ok' ? data.build : null
  const estimatedDuration = getEstimatedBuildDuration(data)
  const progress =
    estimatedDuration && elapsedTime < estimatedDuration
      ? `${Math.floor((elapsedTime / estimatedDuration) * 100)}%`
      : formatTime(elapsedTime)
  const title = build?.trigger.publisher
    ? `${build.trigger.publisher}: ${badge.title}`
    : badge.title
  const badgeContent = (
    <>
      <span
        className={[classes.dot, build?.isActive ? classes.dotActive : ''].join(' ')}
        style={{ backgroundColor: badge.color }}
      />
      <span className={classes.text}>
        {build?.trigger.publisher ? `${build.trigger.publisher}: ` : ''}
        {badge.label}
      </span>

      {build?.isActive ? <span className={classes.timer}>{progress}</span> : null}
    </>
  )

  if (siteUrl) {
    return (
      <a
        className={classes.badge}
        data-build-id={build?.id}
        href={siteUrl}
        rel="noopener noreferrer"
        target="_blank"
        title={title}
      >
        {badgeContent}
      </a>
    )
  }

  return (
    <div className={classes.badge} data-build-id={build?.id} title={title}>
      {badgeContent}
    </div>
  )
}

export default CloudflareBuildStatus
