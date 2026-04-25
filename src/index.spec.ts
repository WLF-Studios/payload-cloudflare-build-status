import type { Config, Endpoint } from 'payload'

import { describe, expect, it } from 'vitest'

import {
  cloudflareBuildStatusPlugin,
  cloudflareBuildStatusPluginDefaults,
} from './index.js'

function getEndpoint(config: Config, path: string): Endpoint | undefined {
  return Array.isArray(config.endpoints)
    ? config.endpoints.find((endpoint) => endpoint.path === path)
    : undefined
}

describe('cloudflareBuildStatusPlugin', () => {
  it('registers the admin action, endpoint, and client config', () => {
    const config = cloudflareBuildStatusPlugin()({} as Config) as Config

    expect(config.admin?.components?.actions).toContain(
      cloudflareBuildStatusPluginDefaults.componentPath,
    )
    expect(getEndpoint(config, cloudflareBuildStatusPluginDefaults.endpointPath)?.method).toBe(
      'get',
    )
    expect(config.custom?.cloudflareBuildStatusPlugin).toMatchObject({
      endpointPath: cloudflareBuildStatusPluginDefaults.endpointPath,
      pollIntervalSeconds: cloudflareBuildStatusPluginDefaults.pollIntervalSeconds,
    })
  })

  it('preserves existing admin actions and endpoints', () => {
    const existingEndpoint: Endpoint = {
      handler: (() => Response.json({ ok: true })) as never,
      method: 'get',
      path: '/existing',
    }
    const config = cloudflareBuildStatusPlugin()({
      admin: {
        components: {
          actions: ['existing-package/client#ExistingAction'],
        },
      },
      endpoints: [existingEndpoint],
    } as Config) as Config

    expect(config.admin?.components?.actions).toEqual([
      'existing-package/client#ExistingAction',
      cloudflareBuildStatusPluginDefaults.componentPath,
    ])
    expect(getEndpoint(config, '/existing')).toBe(existingEndpoint)
    expect(getEndpoint(config, cloudflareBuildStatusPluginDefaults.endpointPath)).toBeDefined()
  })

  it('returns the original config when disabled', () => {
    const config = {
      collections: [],
    } as unknown as Config

    expect(cloudflareBuildStatusPlugin({ disabled: true })(config)).toBe(config)
  })

  it('honors custom endpoint, component, and poll interval options', () => {
    const config = cloudflareBuildStatusPlugin({
      componentPath: 'custom-package/client#BuildStatus',
      endpointPath: 'custom-cloudflare-status',
      pollIntervalSeconds: 5,
    })({} as Config) as Config

    expect(config.admin?.components?.actions).toContain('custom-package/client#BuildStatus')
    expect(getEndpoint(config, '/custom-cloudflare-status')?.method).toBe('get')
    expect(config.custom?.cloudflareBuildStatusPlugin).toMatchObject({
      endpointPath: '/custom-cloudflare-status',
      pollIntervalSeconds: 5,
    })
  })
})
