import type { Config, Endpoint, Plugin } from 'payload'

import type { CloudflareBuildStatusPluginConfig } from './types.js'

import { cloudflareBuildStatusHandler } from './endpoints/cloudflareBuildStatusHandler.js'

export type { CloudflareBuildStatusPluginConfig } from './types.js'

export const cloudflareBuildStatusPluginDefaults = {
  componentPath: 'payload-cloudflare-build-status/client#CloudflareBuildStatus',
  endpointPath: '/cloudflare-build-status',
  pollIntervalSeconds: 10,
} as const

const pluginCustomKey = 'cloudflareBuildStatusPlugin'

function normalizeEndpointPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function getEndpoints(config: Config): Endpoint[] {
  return Array.isArray(config.endpoints) ? [...config.endpoints] : []
}

export const cloudflareBuildStatusPlugin =
  (pluginOptions: CloudflareBuildStatusPluginConfig = {}): Plugin =>
  (config: Config): Config => {
    if (pluginOptions.disabled) {
      return config
    }

    const endpointPath = normalizeEndpointPath(
      pluginOptions.endpointPath ?? cloudflareBuildStatusPluginDefaults.endpointPath,
    )
    const componentPath =
      pluginOptions.componentPath ?? cloudflareBuildStatusPluginDefaults.componentPath
    const pollIntervalSeconds =
      pluginOptions.pollIntervalSeconds ?? cloudflareBuildStatusPluginDefaults.pollIntervalSeconds

    return {
      ...config,
      admin: {
        ...(config.admin ?? {}),
        components: {
          ...(config.admin?.components ?? {}),
          actions: [...(config.admin?.components?.actions ?? []), componentPath],
        },
      },
      custom: {
        ...(config.custom ?? {}),
        [pluginCustomKey]: {
          endpointPath,
          pollIntervalSeconds,
        },
      },
      endpoints: [
        ...getEndpoints(config),
        {
          handler: cloudflareBuildStatusHandler,
          method: 'get',
          path: endpointPath,
        },
      ],
    }
  }
