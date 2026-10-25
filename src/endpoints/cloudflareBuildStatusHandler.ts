import type { PayloadHandler, PayloadRequest } from 'payload'

import type {
  CloudflareBuildStatusResponse,
  CloudflareBuildStatusStage,
  CloudflareBuildStatusStageStatus,
  CloudflareBuildStatusWorkerBuild,
} from '../types.js'

import { classifyBuildFailure } from '../buildFailureReason.js'
import { getVisibleBuilds } from '../buildVisibility.js'
import { formatBuildPublishers, publisherKey } from '../publisher.js'
import { statusMessages } from '../statusMessages.js'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'

type CloudflareBuildStatusEnv = Record<string, string | undefined>
type FetchLike = typeof fetch

type WorkersBuildOutcome = 'cancelled' | 'fail' | 'skipped' | 'success' | 'terminated'
type WorkersBuildStatus = 'initializing' | 'queued' | 'running' | 'stopped'

interface WorkersBuild {
  build_outcome?: WorkersBuildOutcome
  build_trigger_metadata?: {
    branch?: string
  }
  build_uuid: string
  created_on?: string
  running_on?: null | string
  status?: WorkersBuildStatus
  stopped_on?: null | string
}

interface WorkersScript {
  id: string
  tag: string
}

interface CloudflareResultBody {
  errors?: Array<{ code?: number; message?: string }>
  messages?: string[]
  result?: unknown
  success?: boolean
}

class CloudflareApiError extends Error {
  code?: number
  status: number

  constructor(message: string, status: number, code?: number) {
    super(message)
    this.name = 'CloudflareApiError'
    this.status = status
    this.code = code
  }
}

function getAuthHeaders(apiToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
}

function getSiteUrl(env: CloudflareBuildStatusEnv): string | undefined {
  return env.PUBLIC_SITE_URL || undefined
}

async function fetchCloudflareResult<T>(args: {
  apiToken: string
  fetchFn: FetchLike
  path: string
}): Promise<T> {
  const { apiToken, fetchFn, path } = args
  const response = await fetchFn(`${CLOUDFLARE_API_BASE}${path}`, {
    cache: 'no-store',
    headers: getAuthHeaders(apiToken),
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await response.text()
  let data: CloudflareResultBody | null = null

  try {
    data = raw ? (JSON.parse(raw) as CloudflareResultBody) : null
  } catch {
    data = null
  }

  if (!response.ok || data?.success === false) {
    const firstError = data?.errors?.[0]
    const message =
      firstError?.message || raw || `Cloudflare API request failed (${response.status})`
    throw new CloudflareApiError(message, response.status, firstError?.code)
  }

  return (data?.result ?? data ?? null) as T
}

function mapBuildOutcomeToStageStatus(
  outcome?: WorkersBuildOutcome,
): CloudflareBuildStatusStageStatus {
  const statuses: Partial<Record<WorkersBuildOutcome, CloudflareBuildStatusStageStatus>> = {
    cancelled: 'canceled',
    fail: 'failure',
    success: 'success',
    terminated: 'canceled',
  }

  return outcome ? (statuses[outcome] ?? 'idle') : 'idle'
}

function createStage(
  name: string,
  status: CloudflareBuildStatusStageStatus,
  started_on: null | string,
  ended_on: null | string,
): CloudflareBuildStatusStage {
  return {
    name,
    ended_on,
    started_on,
    status,
  }
}

function formatWorkersBuild(
  build: WorkersBuild,
  siteUrl?: string,
): CloudflareBuildStatusWorkerBuild {
  const createdOn =
    build.created_on || build.running_on || build.stopped_on || new Date().toISOString()
  const isQueued = build.status === 'queued'
  const isActive = build.status === 'initializing' || build.status === 'running'
  const finalStatus = mapBuildOutcomeToStageStatus(build.build_outcome)

  const queuedStage = createStage(
    'queued',
    isQueued ? 'active' : build.status ? 'success' : 'idle',
    build.created_on || null,
    isQueued ? null : build.running_on || build.stopped_on || null,
  )
  const buildStage = createStage(
    build.status === 'initializing' ? 'initializing' : 'build',
    isActive ? 'active' : build.status === 'stopped' ? finalStatus : 'idle',
    build.running_on || build.created_on || null,
    build.status === 'stopped' ? build.stopped_on || null : null,
  )
  const deployStage = createStage(
    'deploy',
    build.status === 'stopped' ? finalStatus : 'idle',
    build.running_on || build.created_on || null,
    build.status === 'stopped' ? build.stopped_on || null : null,
  )

  return {
    id: build.build_uuid,
    createdOn,
    isActive,
    isQueued,
    latestStage: isQueued ? queuedStage : isActive ? buildStage : deployStage,
    shortId: build.build_uuid.split('-')[0] ?? build.build_uuid,
    stages: [queuedStage, buildStage, deployStage],
    trigger: {
      branch: build.build_trigger_metadata?.branch,
    },
    url: build.build_outcome === 'success' ? siteUrl : undefined,
  }
}

interface WorkersBuildLogs {
  cursor?: string
  events?: Array<{
    ended_on?: null | string
    started_on: string
    type: string
  }>
  lines?: Array<[number, string]>
  truncated?: boolean
}

async function addLiveStages(args: {
  accountId: string
  apiToken: string
  build: CloudflareBuildStatusWorkerBuild
  fetchFn: FetchLike
}): Promise<void> {
  const { accountId, apiToken, build, fetchFn } = args
  if (!build.isActive) {
    return
  }

  try {
    // Events include the full stage timeline even when the log lines are truncated.
    const logs = await fetchCloudflareResult<WorkersBuildLogs>({
      apiToken,
      fetchFn,
      path: `/accounts/${accountId}/builds/builds/${encodeURIComponent(build.id)}/logs`,
    })
    const stageNames: Record<string, string> = {
      building: 'build',
      cloning: 'cloning',
      deploying: 'deploy',
      initializing: 'initializing',
      installing_tools_and_deps: 'installing',
    }
    const stages = (logs?.events ?? []).flatMap((event) => {
      const name = stageNames[event.type]
      return name
        ? [
            createStage(
              name,
              event.ended_on ? 'success' : 'active',
              event.started_on,
              event.ended_on ?? null,
            ),
          ]
        : []
    })
    const latestStage = stages.at(-1)
    if (latestStage) {
      build.stages = stages
      build.latestStage = latestStage
    }
  } catch {
    // Keep the overall build status when live events are temporarily unavailable.
  }
}
async function resolveWorkerTag(args: {
  accountId: string
  apiToken: string
  env: CloudflareBuildStatusEnv
  fetchFn: FetchLike
}): Promise<string> {
  const { accountId, apiToken, env, fetchFn } = args

  if (env.CLOUDFLARE_WORKER_TAG) {
    return env.CLOUDFLARE_WORKER_TAG
  }

  if (!env.CLOUDFLARE_WORKER_NAME) {
    throw new CloudflareApiError(
      'Cloudflare worker is not configured. Set CLOUDFLARE_WORKER_NAME or CLOUDFLARE_WORKER_TAG.',
      500,
    )
  }

  const scripts = await fetchCloudflareResult<WorkersScript[]>({
    apiToken,
    fetchFn,
    path: `/accounts/${accountId}/workers/scripts`,
  })
  const workerName = env.CLOUDFLARE_WORKER_NAME
  const script =
    scripts.find((item) => item.id === workerName) ||
    scripts.find((item) => item.id.toLowerCase() === workerName.toLowerCase())

  if (!script) {
    throw new CloudflareApiError(`Cloudflare worker "${workerName}" was not found.`, 404)
  }

  return script.tag
}

function toUserError(error: unknown): { message: string; status: number } {
  if (error instanceof CloudflareApiError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502
    let message: string = statusMessages.status
    if (error.code === 10000 || status === 401 || status === 403) {
      message =
        'Build status cannot connect to the publishing service; a developer needs to restore its access.'
    } else if (status === 404) {
      message = 'The publishing site could not be found; a developer needs to check its setup.'
    } else if (status === 429) {
      message = 'Build status is receiving too many requests; try again shortly.'
    } else if (status >= 500) {
      message = 'The publishing service is temporarily unavailable; try again shortly.'
    }
    return { message, status }
  }
  return { message: statusMessages.status, status: 500 }
}

async function addFailureReason(
  req: PayloadRequest,
  build: CloudflareBuildStatusWorkerBuild,
): Promise<void> {
  const status = build.latestStage.status
  if (build.isActive || build.isQueued || !['canceled', 'failure'].includes(status)) {
    return
  }
  const key = `cloudflare-build-error:${build.id}`
  try {
    const cached = await req.payload.kv.get<string>(key)
    if (typeof cached === 'string' && cached) {
      build.errorReason = cached
      return
    }
  } catch (error) {
    req.payload.logger.warn(
      { err: error },
      '[cloudflare-build-status] Could not read cached failure reason',
    )
  }

  try {
    const lines: string[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const logs = await fetchCloudflareResult<WorkersBuildLogs>({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        fetchFn: fetch,
        path: `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/builds/builds/${encodeURIComponent(build.id)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      })
      if (
        !Array.isArray(logs?.lines) ||
        typeof logs.truncated !== 'boolean' ||
        !logs.lines.every((line) => Array.isArray(line) && typeof line[1] === 'string')
      ) {
        throw new Error('Unexpected Cloudflare log response')
      }
      lines.push(...logs.lines.map((line) => line[1]))
      if (!logs.truncated) {
        break
      }
      if (!logs.cursor || cursors.has(logs.cursor)) {
        throw new Error('Incomplete Cloudflare log pagination')
      }
      cursor = logs.cursor
      cursors.add(cursor)
    } while (cursor)
    build.errorReason = classifyBuildFailure(lines.join('\n'), {
      canceled: status === 'canceled',
    }).reason
  } catch (error) {
    req.payload.logger.warn(
      { err: error },
      '[cloudflare-build-status] Could not read failed build logs',
    )
    return
  }

  try {
    await req.payload.kv.set(key, build.errorReason)
  } catch (error) {
    req.payload.logger.warn(
      { err: error },
      '[cloudflare-build-status] Could not cache failure reason',
    )
  }
}

export async function getCloudflareBuildStatus(
  args: {
    env?: CloudflareBuildStatusEnv
    fetchFn?: FetchLike
  } = {},
): Promise<CloudflareBuildStatusResponse> {
  const env = args.env ?? process.env
  const fetchFn = args.fetchFn ?? fetch
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = env.CLOUDFLARE_API_TOKEN
  const siteUrl = getSiteUrl(env)

  if (!accountId || !apiToken || (!env.CLOUDFLARE_WORKER_TAG && !env.CLOUDFLARE_WORKER_NAME)) {
    return {
      build: null,
      builds: [],
      errorReason: statusMessages.config,
      queuedBuilds: [],
      serverTime: new Date().toISOString(),
      siteUrl,
      status: 'not_configured',
    }
  }

  const workerTag = await resolveWorkerTag({
    accountId,
    apiToken,
    env,
    fetchFn,
  })
  const builds = await fetchCloudflareResult<WorkersBuild[]>({
    apiToken,
    fetchFn,
    path: `/accounts/${accountId}/builds/workers/${workerTag}/builds?per_page=10`,
  })

  if (!builds.length) {
    return {
      build: null,
      builds: [],
      queuedBuilds: [],
      serverTime: new Date().toISOString(),
      siteUrl,
      status: 'ok',
    }
  }

  const activeBuild = builds.find(
    (build) => build.status === 'running' || build.status === 'initializing',
  )
  const queuedBuilds = builds.filter(
    (build) => build.status === 'queued' && build.build_uuid !== activeBuild?.build_uuid,
  )
  const currentBuild = activeBuild || queuedBuilds[0] || builds[0]
  const otherQueuedBuilds = queuedBuilds.filter(
    (build) => build.build_uuid !== currentBuild.build_uuid,
  )

  const formattedBuilds = builds.map((build) => formatWorkersBuild(build, siteUrl))
  await Promise.all(
    formattedBuilds.map((build) => addLiveStages({ accountId, apiToken, build, fetchFn })),
  )

  return {
    build: formattedBuilds.find((build) => build.id === currentBuild.build_uuid)!,
    builds: formattedBuilds,
    queuedBuilds: formattedBuilds.filter((build) =>
      otherQueuedBuilds.some((queued) => queued.build_uuid === build.id),
    ),
    serverTime: new Date().toISOString(),
    siteUrl,
    status: 'ok',
  }
}

export const cloudflareBuildStatusHandler: PayloadHandler = async (req) => {
  if (!req.user) {
    return Response.json(
      {
        build: null,
        builds: [],
        errorReason: 'Your CMS session has ended; sign in again to see publishing progress.',
        queuedBuilds: [],
        serverTime: new Date().toISOString(),
        siteUrl: getSiteUrl(process.env),
        status: 'error',
      } satisfies CloudflareBuildStatusResponse,
      {
        status: 401,
      },
    )
  }

  try {
    const result = await getCloudflareBuildStatus()
    if (result.status === 'not_configured') {
      const missing = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].filter(
        (name) => !process.env[name],
      )
      if (!process.env.CLOUDFLARE_WORKER_TAG && !process.env.CLOUDFLARE_WORKER_NAME) {
        missing.push('CLOUDFLARE_WORKER_TAG or CLOUDFLARE_WORKER_NAME')
      }
      req.payload.logger.warn({ missing }, '[cloudflare-build-status] Missing configuration')
    }
    await Promise.all(
      getVisibleBuilds(result.builds, Date.now()).map((build) => addFailureReason(req, build)),
    )

    try {
      await Promise.all(
        result.builds.map(async (build) => {
          const stored = await req.payload.kv.get<
            { pagePath?: string; publisher?: string } | string
          >(publisherKey(build.id))
          const publisher = typeof stored === 'string' ? stored : stored?.publisher
          if (typeof publisher === 'string' && publisher) {
            build.trigger.publisher = publisher
          }
          const pagePath = typeof stored === 'object' ? stored?.pagePath : undefined
          if (
            result.siteUrl &&
            typeof pagePath === 'string' &&
            pagePath.startsWith('/') &&
            !pagePath.startsWith('//') &&
            !pagePath.includes('\\')
          ) {
            const site = new URL(result.siteUrl)
            const page = new URL(pagePath, site)
            if (page.origin === site.origin && ['http:', 'https:'].includes(page.protocol)) {
              build.url = page.toString()
            }
          }
        }),
      )
      await formatBuildPublishers(req, result.builds)
      result.build = result.builds.find((build) => build.id === result.build?.id) ?? result.build
      result.queuedBuilds = result.queuedBuilds.map(
        (queued) => result.builds.find((build) => build.id === queued.id) ?? queued,
      )
    } catch (error) {
      req.payload.logger.warn({ err: error }, '[cloudflare-build-status] Could not read publishers')
    }

    return Response.json({ ...result, serverTime: new Date().toISOString() })
  } catch (error) {
    req.payload.logger.warn({ err: error }, '[cloudflare-build-status] Could not read build status')
    const userError = toUserError(error)

    return Response.json(
      {
        build: null,
        builds: [],
        errorReason: userError.message,
        queuedBuilds: [],
        serverTime: new Date().toISOString(),
        siteUrl: getSiteUrl(process.env),
        status: 'error',
      } satisfies CloudflareBuildStatusResponse,
      {
        status: userError.status,
      },
    )
  }
}
