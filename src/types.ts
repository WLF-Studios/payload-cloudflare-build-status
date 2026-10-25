export interface CloudflareBuildStatusPluginConfig {
  /**
   * Override the admin component import-map path.
   *
   * @default 'payload-cloudflare-build-status/client#CloudflareBuildStatus'
   */
  componentPath?: string
  /**
   * Disable the plugin without changing the rest of the Payload config.
   */
  disabled?: boolean
  /**
   * Override the Payload API endpoint used by the admin badge.
   *
   * @default '/cloudflare-build-status'
   */
  endpointPath?: string
  /**
   * Polling interval, in seconds, while a Worker build is queued or running.
   *
   * @default 10
   */
  pollIntervalSeconds?: number
}

export type CloudflareBuildStatusStageStatus =
  | 'active'
  | 'canceled'
  | 'failure'
  | 'idle'
  | 'success'

export interface CloudflareBuildStatusStage {
  ended_on: null | string
  name: string
  started_on: null | string
  status: CloudflareBuildStatusStageStatus
}

export interface CloudflareBuildStatusWorkerBuild {
  createdOn: string
  id: string
  isActive: boolean
  isQueued: boolean
  latestStage: CloudflareBuildStatusStage
  shortId: string
  stages: CloudflareBuildStatusStage[]
  trigger: {
    branch?: string
    publisher?: string
  }
  url?: string
}

export interface CloudflareBuildStatusResponse {
  build: CloudflareBuildStatusWorkerBuild | null
  builds: CloudflareBuildStatusWorkerBuild[]
  error?: string
  queuedBuilds: CloudflareBuildStatusWorkerBuild[]
  siteUrl?: string
  status: 'error' | 'not_configured' | 'ok'
}
