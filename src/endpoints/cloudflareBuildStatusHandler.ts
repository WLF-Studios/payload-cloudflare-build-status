import type { PayloadHandler } from 'payload'

import type {
  CloudflareBuildStatusResponse,
  CloudflareBuildStatusStage,
  CloudflareBuildStatusStageStatus,
  CloudflareBuildStatusWorkerBuild,
} from '../types.js'

import { formatBuildPublishers, publisherKey } from '../publisher.js'

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
  events?: Array<{
    ended_on?: null | string
    started_on: string
    type: string
  }>
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
    if (error.code === 10000) {
      return {
        message:
          'Cloudflare authentication failed. Workers Builds requires a user-scoped API token with Workers Builds read access.',
        status: error.status || 401,
      }
    }

    return {
      message: error.message,
      status: error.status || 500,
    }
  }

  return {
    message: 'Failed to connect to Cloudflare API',
    status: 500,
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

  if (!accountId || !apiToken) {
    return {
      build: null,
      builds: [],
      error: 'Cloudflare credentials not configured',
      queuedBuilds: [],
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
        error: 'Unauthorized',
        queuedBuilds: [],
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

    try {
      await Promise.all(
        result.builds.map(async (build) => {
          const publisher = await req.payload.kv.get<string>(publisherKey(build.id))
          if (typeof publisher === 'string' && publisher) {
            build.trigger.publisher = publisher
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

    return Response.json(result)
  } catch (error) {
    const userError = toUserError(error)

    return Response.json(
      {
        build: null,
        builds: [],
        error: userError.message,
        queuedBuilds: [],
        siteUrl: getSiteUrl(process.env),
        status: 'error',
      } satisfies CloudflareBuildStatusResponse,
      {
        status: userError.status,
      },
    )
  }
}
