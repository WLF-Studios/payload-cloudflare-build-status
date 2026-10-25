import { stripVTControlCharacters } from 'node:util'

import { statusMessages } from './statusMessages.js'

interface FailureRule {
  forCanceled?: boolean
  id: string
  pattern: RegExp
  reason: string
}

// Specific terminal failures precede broad build errors and command-exit messages.
// These are fixed sentences: log text must never be returned to the browser or KV.
export const buildFailureRules: FailureRule[] = [
  {
    id: 'superseded',
    forCanceled: true,
    pattern:
      /(?:superseded|replaced|cancel(?:led|ed)).*(?:newer|subsequent|more recent) (?:build|publish)|newer (?:build|publish).*replaced/i,
    reason: 'Replaced by a newer publish.',
  },
  {
    id: 'timeout',
    forCanceled: true,
    pattern:
      /build (?:was )?timed out|build failed to initialize.{0,80}timed out|build exceeded.{0,40}time limit|maximum build (?:time|duration)/i,
    reason: 'Publishing took too long; try again, or ask a developer if it keeps happening.',
  },
  {
    id: 'memory',
    forCanceled: true,
    pattern:
      /heap out of memory|out of memory|allocation failed.{0,40}heap|(?:process|command).{0,30}(?:killed|exit(?:ed)? (?:with )?code 137)/i,
    reason:
      'The site ran out of memory while building; a developer needs to reduce its memory use.',
  },
  {
    id: 'clone',
    pattern:
      /error occurred while fetching repository|failed to clone|could not (?:read|fetch|clone).{0,30}repository|repository not found/i,
    reason:
      'The site code could not be downloaded; try again, or ask a developer to check the repository connection.',
  },
  {
    id: 'lockfile',
    pattern:
      /ERR_PNPM_(?:LOCKFILE_CONFIG_MISMATCH|OUTDATED_LOCKFILE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE)|(?:Cannot proceed|Cannot install).{0,80}frozen|lockfile.{0,60}(?:out of date|not up.to.date|mismatch)/i,
    reason:
      'The site dependencies are out of sync; a developer needs to update them before publishing.',
  },
  {
    id: 'registry',
    pattern:
      /ERR_PNPM_(?:META_FETCH_FAIL|FETCH_\w+)|(?:registry|npmjs).{0,120}(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|failed)/i,
    reason: 'Build tools could not be downloaded; try publishing again shortly.',
  },
  {
    id: 'install',
    pattern:
      /error occurred while installing tools or dependencies|failed to install (?:dependencies|packages)/i,
    reason: 'The build tools could not be installed; a developer needs to check the site setup.',
  },
  {
    id: 'environment',
    pattern:
      /missing (?:required )?(?:environment variables?|env var|secret)|(?:environment variable|secret) .{0,80}(?:is required|is not (?:set|defined)|must be (?:set|provided))|requires? (?:the )?[A-Z][A-Z_]{3,} (?:environment variable|secret)/i,
    reason: 'A required publishing setting is missing; a developer needs to add it.',
  },
  {
    id: 'auth',
    pattern:
      /authentication error.{0,60}(?:10000|10001)|(?:wrangler|Cloudflare API).{0,120}(?:authentication failed|unauthorized|forbidden|invalid (?:API )?token)|API token.{0,60}(?:invalid|expired)|build token.{0,80}(?:invalid|expired|deleted|rolled|no longer valid)/i,
    reason: 'The publishing service could not sign in; a developer needs to restore its access.',
  },
  {
    id: 'size',
    pattern:
      /(?:Worker|script|asset|file).{0,80}(?:exceed(?:s|ed)?.{0,30}(?:size|limit)|too large|size limit)|(?:maximum|exceeded).{0,30}(?:number of assets|asset count)|code: (?:10027|10054)/i,
    reason: 'The site exceeds a publishing size limit; a developer needs to reduce its size.',
  },
  {
    id: 'platform',
    forCanceled: true,
    pattern:
      /A request to the Cloudflare API.{0,300}failed|Malformed response from the API|upstream connect error|Internal error.{0,80}(?:retry|try again)|code: (?:10013|10002|971)|Cloudflare.{0,60}(?:service unavailable|internal server error)/i,
    reason: 'The publishing service had a problem; try publishing again shortly.',
  },
  {
    id: 'cms_auth',
    pattern:
      /Failed to fetch \/api\/site\/[^\n]+:\s*(?:401|403)|valid service token (?:is )?required/i,
    reason: 'The site could not access CMS content; a developer needs to restore its access.',
  },
  {
    id: 'cms',
    pattern:
      /Failed to fetch \/api\/site\/|(?:CMS|content API).{0,80}(?:unreachable|unavailable|ECONNREFUSED|ENOTFOUND|timed out)|fetch failed.{0,80}CMS/i,
    reason: 'The site could not load content from the CMS; try publishing again in a few minutes.',
  },
  {
    id: 'media_missing',
    pattern:
      /(?:File|Media).{0,80}missing current CMS storage metadata|(?:media|image).{0,80}(?:not found|404)/i,
    reason: 'An image or file is missing; check the page media or ask a developer to help.',
  },
  {
    id: 'media',
    pattern:
      /(?:Failed to (?:download|load)|Error:).{0,60}(?:media|remote image|thumbnail)|(?:Media|Thumbnail) \S+ returned \d{3}|(?:Media|Thumbnail).{0,100}(?:failed|HTTP [45]\d\d|returned [45]\d\d)/i,
    reason: 'An image or file could not be loaded; try publishing again in a few minutes.',
  },
  {
    id: 'content',
    pattern:
      /CMS returned (?:no published pages|invalid|no .*home)|(?:invalid|missing).{0,40}(?:CMS|content schema)|(?:CMS|content).{0,40}(?:validation failed|schema error|response is invalid)/i,
    reason:
      'Some page content is missing or invalid; check recent edits or ask a developer to help.',
  },
  {
    id: 'search_content',
    pattern:
      /Duplicate AI Search page item key|AI Search.{0,100}requires exactly one FAQ hub block/i,
    reason:
      'Search content has duplicate or missing entries; a developer needs to check it before publishing.',
  },
  {
    id: 'search',
    pattern:
      /AI Search (?:sync )?(?:request failed|verification failed|deletions failed)|AI Search.{0,60}(?:sync failed|timed out)/i,
    reason:
      'Site search could not be updated; try publishing again, or ask a developer if it keeps happening.',
  },
  {
    id: 'postbuild',
    pattern:
      /verify-detached failed|test:postbuild.{0,120}(?:failed|error)|(?:postbuild|post-build).{0,60}(?:check|test|guard).{0,60}failed|(?:FAIL|AssertionError).{0,100}(?:postbuild|post-build)/i,
    reason:
      'The site did not pass its publishing checks; a developer needs to fix the failing check.',
  },
  {
    id: 'setup',
    pattern:
      /ERR_PNPM_NO_SCRIPT|Missing entry-point to Worker script|Could not find.{0,50}wrangler|(?:Worker name|account ID).{0,80}(?:does not match|mismatch)/i,
    reason: 'The publishing setup is incomplete or incorrect; a developer needs to fix it.',
  },
  {
    id: 'network',
    pattern: /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i,
    reason: 'A connection needed for publishing failed; try publishing again shortly.',
  },
  {
    id: 'code',
    pattern:
      /(?:TypeError|ReferenceError|SyntaxError|ERR_UNKNOWN_FILE_EXTENSION):?|error TS\d+|Build failed in|Failed to (?:pre)?render|is not a function|Cannot read properties of|is not defined|Transform failed|Could not resolve|Failed to resolve import|Cannot find module|ERROR.*Expected .+but found/i,
    reason: 'The site code has an error; a developer needs to fix it before publishing works.',
  },
]

export function matchBuildFailure(
  logText: string,
  { canceled = false } = {},
): FailureRule | undefined {
  // Strip ANSI formatting so the same patterns work with local and Cloudflare logs.
  const text = stripVTControlCharacters(logText)
  return buildFailureRules.find(
    (rule) => (!canceled || rule.forCanceled) && rule.pattern.test(text),
  )
}

export function classifyBuildFailure(
  logText: string,
  options: { canceled?: boolean } = {},
): { reason: string } {
  return {
    reason:
      matchBuildFailure(logText, options)?.reason ??
      (options.canceled ? statusMessages.canceled : statusMessages.failure),
  }
}
