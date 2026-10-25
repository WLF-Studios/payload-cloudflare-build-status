import type { PayloadRequest } from 'payload'

import type { CloudflareBuildStatusWorkerBuild } from './types.js'

export const publisherKey = (buildID: string): string => `cloudflare-build-publisher:${buildID}`

/** Record the authenticated publisher after a successful Cloudflare deploy-hook request. */
export async function recordCloudflareBuildPublisher({
  req,
  response,
}: {
  req: PayloadRequest
  response: Response
}): Promise<void> {
  if (!response.ok || !req.user) {
    return
  }

  const user = req.user as { email?: unknown; name?: unknown }
  const publisher =
    (typeof user.name === 'string' && user.name.trim()) ||
    (typeof user.email === 'string' && user.email.trim())
  if (!publisher) {
    return
  }

  try {
    const body: unknown = await response.clone().json()
    if (!body || typeof body !== 'object') {
      return
    }
    const result = 'result' in body ? body.result : body
    if (!result || typeof result !== 'object') {
      return
    }
    // Cloudflare may reuse a pending build. Do not replace its original publisher.
    if ('already_exists' in result && result.already_exists === true) {
      return
    }
    if (!('build_uuid' in result) || typeof result.build_uuid !== 'string' || !result.build_uuid) {
      return
    }

    await req.payload.kv.set(publisherKey(result.build_uuid), publisher)
  } catch (error) {
    req.payload.logger.warn({ err: error }, '[cloudflare-build-status] Could not record publisher')
  }
}

export async function formatBuildPublishers(
  req: PayloadRequest,
  builds: CloudflareBuildStatusWorkerBuild[],
): Promise<void> {
  const publishers = builds.flatMap((build) =>
    build.trigger.publisher ? [build.trigger.publisher] : [],
  )
  if (!publishers.length) {
    return
  }

  let names = [...new Set(publishers)]
  try {
    // Only names are needed to disambiguate publishers, including users without a recent build.
    const users = await req.payload.find({
      collection: req.payload.config.admin.user,
      depth: 0,
      limit: 0,
      overrideAccess: true,
      pagination: false,
      select: { name: true },
    })
    names = users.docs.flatMap((user) => (typeof user.name === 'string' ? [user.name] : []))
  } catch (error) {
    req.payload.logger.warn(
      { err: error },
      '[cloudflare-build-status] Could not read publisher names',
    )
  }

  const firstNames = names.map((name) => name.trim().split(/\s+/)[0].toLowerCase())
  for (const build of builds) {
    const name = build.trigger.publisher
    if (!name) {
      continue
    }
    const parts = name.trim().split(/\s+/)
    const firstName = parts[0]
    const hasDuplicates = firstNames.filter((first) => first === firstName.toLowerCase()).length > 1
    build.trigger.publisher =
      hasDuplicates && parts.length > 1
        ? `${firstName}.${parts[parts.length - 1][0].toUpperCase()}`
        : firstName
  }
}
