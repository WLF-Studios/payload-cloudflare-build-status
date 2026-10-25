import type { CloudflareBuildStatusWorkerBuild } from './types.js'

import { COMPLETED_BUILD_VISIBLE_MS } from './statusMessages.js'

export function getBuildExpiresAt(build: CloudflareBuildStatusWorkerBuild): number {
  return Date.parse(build.latestStage.ended_on ?? '') + COMPLETED_BUILD_VISIBLE_MS
}

export function getVisibleBuilds(
  builds: CloudflareBuildStatusWorkerBuild[],
  now: number,
): CloudflareBuildStatusWorkerBuild[] {
  let latestSuccessfulPublish = -Infinity
  for (const build of builds) {
    if (!build.isActive && !build.isQueued && build.latestStage.status === 'success') {
      const createdAt = Date.parse(build.createdOn)
      if (
        Number.isFinite(Date.parse(build.latestStage.ended_on ?? '')) &&
        createdAt > latestSuccessfulPublish
      ) {
        latestSuccessfulPublish = createdAt
      }
    }
  }

  return builds.filter((build) => {
    if (build.isActive || build.isQueued) {
      return true
    }
    // Every successful publish replaces the full site, even when another page triggered it.
    const clearedError =
      ['canceled', 'failure'].includes(build.latestStage.status) &&
      Date.parse(build.createdOn) < latestSuccessfulPublish
    return !clearedError && getBuildExpiresAt(build) > now
  })
}
