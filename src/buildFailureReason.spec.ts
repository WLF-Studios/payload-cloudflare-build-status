import { describe, expect, it } from 'vitest'

import { buildFailureRules, classifyBuildFailure } from './buildFailureReason.js'

const fixtures: Record<string, string> = {
  auth: 'Authentication error [code: 10000]',
  clone: 'Failed: error occurred while fetching repository',
  cms: 'Error: Failed to fetch /api/site/public/pages?locale=base: 502 Bad Gateway',
  cms_auth: 'Error: Failed to fetch /api/site/public/globals: 401 Unauthorized',
  code: 'TypeError: content.map is not a function',
  content: 'Error: CMS returned no published pages for locale "base"',
  environment: 'Error: Missing required environment variable SITE_TOKEN',
  install: 'Failed: error occurred while installing tools or dependencies',
  lockfile: '[ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] Cannot proceed with the frozen installation.',
  media: 'Error: Failed to download media: 500',
  media_missing: 'File is missing current CMS storage metadata.',
  memory: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  network: 'TypeError: terminated\ncode: UND_ERR_SOCKET',
  platform: 'A request to the Cloudflare API failed.\nAn unknown error has occurred. [code: 10013]',
  postbuild: 'verify-detached failed:',
  registry: 'ERR_PNPM_META_FETCH_FAIL GET https://registry.example.test/package: ECONNRESET',
  search: 'Error: AI Search verification failed for 4 items; obsolete items were retained.',
  search_content: 'Duplicate AI Search page item key',
  setup: 'ERR_PNPM_NO_SCRIPT Missing script: deploy:public',
  size: 'Your Worker exceeded the size limit',
  superseded: 'Build canceled because it was superseded by a newer build.',
  timeout: 'Failed: build failed to initialize. Timed out.',
}

describe('classifyBuildFailure', () => {
  it.each(Object.entries(fixtures))('recognizes a sanitized %s failure', (id, text) => {
    const rule = buildFailureRules.find((candidate) => candidate.id === id)
    expect(rule).toBeDefined()
    expect(classifyBuildFailure(text)).toEqual({ reason: rule!.reason })
  })

  it('ignores normal installation commands and successful lockfile output', () => {
    expect(
      classifyBuildFailure(
        'pnpm install --frozen-lockfile\nLockfile is up to date\nUnknown failure',
      ),
    ).toEqual({
      reason: 'The site build failed; a developer needs to check the build log.',
    })
  })

  it.each([
    [
      'auth',
      'Failed: The build token selected for this build has been deleted or rolled and cannot be used for this build.',
    ],
    ['content', 'Error: CMS redirects response is invalid.'],
    ['search', 'Error: Cloudflare AI Search request failed (524): null'],
    [
      'code',
      'Failed to prerender https://example.test/page/ Unable to render Icon because it is undefined!',
    ],
    ['code', 'Failed to prerender https://example.test/page/ block.media.map is not a function'],
  ])('recognizes another historical %s signature', (id, text) => {
    expect(classifyBuildFailure(text).reason).toBe(
      buildFailureRules.find((rule) => rule.id === id)!.reason,
    )
  })

  it('covers every rule with a fixture', () => {
    expect(Object.keys(fixtures).sort()).toEqual(buildFailureRules.map((rule) => rule.id).sort())
  })

  it('prioritizes the final deployment error over a recovered search retry', () => {
    expect(
      classifyBuildFailure(
        'AI Search sync request failed: 503; retrying\nA request to the Cloudflare API failed.\nAn unknown error has occurred. [code: 10002]',
      ),
    ).toEqual({
      reason: 'The publishing service had a problem; try publishing again shortly.',
    })
  })

  it('does not turn a cancellation or cache warning into a code failure', () => {
    expect(
      classifyBuildFailure('Failed to restore build output from build cache. Skipping.', {
        canceled: true,
      }),
    ).toEqual({
      reason: 'Publishing was canceled; publish again when you are ready.',
    })
    expect(
      classifyBuildFailure('Build canceled because a newer build replaced it.', { canceled: true }),
    ).toEqual({ reason: 'Replaced by a newer publish.' })
  })

  it('recognizes a platform timeout on a terminated build', () => {
    expect(classifyBuildFailure('Build was timed out', { canceled: true })).toEqual({
      reason: 'Publishing took too long; try again, or ask a developer if it keeps happening.',
    })
  })

  it('never includes unknown log text or secrets in the fallback', () => {
    expect(classifyBuildFailure('SECRET=value\nunknown failure')).toEqual({
      reason: 'The site build failed; a developer needs to check the build log.',
    })
  })
})
