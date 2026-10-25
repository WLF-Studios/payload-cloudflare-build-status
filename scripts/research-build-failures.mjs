import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// One-off research only. Raw responses and logs must never enter git or the package.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const output = path.join(root, '.local/build-failure-research')
execFileSync('git', ['check-ignore', '.local/build-failure-research/manifest.json'], {
  cwd: root,
  stdio: 'pipe',
})
async function downloadHistory() {
  const envFile =
    process.argv.find((arg) => arg.startsWith('--env='))?.slice(6) ??
    'D:/dev/massresort-website/payload/.env'
  const env = { ...process.env, ...parseEnv(await readFile(envFile, 'utf8')) }
  const account = env.CLOUDFLARE_ACCOUNT_ID
  const token = env.CLOUDFLARE_API_TOKEN
  if (!account || !token)
    throw new Error('Configure the Cloudflare account and token in the payload env file.')
  await mkdir(output, { recursive: true })
  let requests = 0
  async function request(endpoint) {
    for (let attempt = 0; ; attempt++) {
      requests++
      const response = await fetch('https://api.cloudflare.com/client/v4' + endpoint, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(60000),
      })
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await delay(
          Math.min(30000, Number(response.headers.get('retry-after') || 2 ** (attempt + 1)) * 1000),
        )
        continue
      }
      if (!response.ok) throw new Error('Cloudflare HTTP ' + response.status)
      const body = await response.json()
      if (body.success === false) throw new Error('Cloudflare rejected the request')
      return body
    }
  }
  let tag = env.CLOUDFLARE_WORKER_TAG
  if (!tag) {
    const workers = await request('/accounts/' + account + '/workers/scripts')
    tag = workers.result.find((worker) => worker.id === env.CLOUDFLARE_WORKER_NAME)?.tag
  }
  if (!tag) throw new Error('Worker tag could not be resolved')
  const builds = new Map()
  let lastInfo
  for (let page = 1; ; page++) {
    const body = await request(
      '/accounts/' +
        account +
        '/builds/workers/' +
        encodeURIComponent(tag) +
        '/builds?per_page=100&page=' +
        page,
    )
    await writeFile(path.join(output, 'builds-page-' + page + '.json'), JSON.stringify(body))
    if (!Array.isArray(body.result)) throw new Error('Unexpected builds response shape')
    for (const build of body.result) builds.set(build.build_uuid, build)
    lastInfo = body.result_info
    if (
      lastInfo?.next_page === false ||
      (lastInfo?.total_pages && page >= lastInfo.total_pages) ||
      !body.result.length
    )
      break
  }
  const failed = [...builds.values()].filter(
    (build) => build.status === 'stopped' && build.build_outcome !== 'success',
  )
  console.log(
    JSON.stringify({
      builds: builds.size,
      failed: failed.length,
      outcomes: failed.reduce((out, build) => {
        out[build.build_outcome] = (out[build.build_outcome] ?? 0) + 1
        return out
      }, {}),
    }),
  )
  const failures = []
  let processed = 0
  async function download(build) {
    const file = path.join(output, build.build_uuid + '.json')
    try {
      const existing = JSON.parse(await readFile(file, 'utf8'))
      if (existing.complete) {
        processed++
        return
      }
    } catch {}
    const pages = []
    const cursors = new Set()
    let cursor
    try {
      for (;;) {
        const body = await request(
          '/accounts/' +
            account +
            '/builds/builds/' +
            encodeURIComponent(build.build_uuid) +
            '/logs' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        )
        pages.push(body)
        const logs = body.result ?? body
        if (!Array.isArray(logs.lines)) throw new Error('Unexpected logs response shape')
        if (!logs.truncated) break
        if (!logs.cursor || cursors.has(logs.cursor)) throw new Error('Incomplete log pagination')
        cursor = logs.cursor
        cursors.add(cursor)
      }
      await writeFile(file, JSON.stringify({ build, pages, complete: true }))
    } catch (error) {
      await writeFile(file, JSON.stringify({ build, pages, complete: false, error: error.message }))
      failures.push({ id: build.build_uuid, error: error.message })
    }
    processed++
    if (processed % 20 === 0)
      console.log('Downloaded ' + processed + '/' + failed.length + ' failed or canceled builds')
  }
  let index = 0
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (index < failed.length) await download(failed[index++])
    }),
  )
  const summary = {
    downloadedAt: new Date().toISOString(),
    builds: builds.size,
    failedBuilds: failed.length,
    requests,
    failures,
    totalReported: lastInfo?.total_count,
    earliest: [...builds.values()].at(-1)?.created_on,
    latest: [...builds.values()][0]?.created_on,
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (failures.length) process.exitCode = 1
}

async function analyzeHistory() {
  const { buildFailureRules, matchBuildFailure } = await import('../dist/buildFailureReason.js')
  const { statusMessages } = await import('../dist/statusMessages.js')
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
  const groups = new Map()
  const outcomes = {}
  for (const file of await readdir(output)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
    const data = JSON.parse(await readFile(path.join(output, file), 'utf8'))
    if (!data.complete) throw new Error('Finish downloading all logs before analyzing')
    const logText = data.pages
      .flatMap((page) => (page.result ?? page).lines)
      .map((line) => line[1])
      .join('\n')
    const canceled = ['cancelled', 'terminated'].includes(data.build.build_outcome)
    const rule = matchBuildFailure(logText, { canceled })
    const id = rule?.id ?? (canceled ? 'canceled' : 'fallback')
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(data.build.build_uuid)
    outcomes[data.build.build_outcome] = (outcomes[data.build.build_outcome] ?? 0) + 1
  }
  const count = [...groups.values()].reduce((sum, ids) => sum + ids.length, 0)
  if (count !== manifest.failedBuilds || manifest.failures.length)
    throw new Error('Incomplete research data')
  // Curated signatures only. Never copy raw lines or environment values into this report.
  const signatures = {
    superseded: 'superseded by a newer build',
    timeout: 'build failed to initialize; timed out',
    memory: 'JavaScript heap out of memory',
    clone: 'error occurred while fetching repository',
    lockfile: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH',
    registry: 'ERR_PNPM_META_FETCH_FAIL',
    install: 'error occurred while installing tools or dependencies',
    environment: 'Missing required environment variable',
    auth: 'Authentication error [code: 10000]',
    size: 'Worker exceeded the size limit',
    platform: 'Cloudflare API request failed; codes 10013, 10002, 971; internal error',
    cms_auth: 'Failed to fetch /api/site/public/globals: 401 Unauthorized',
    cms: 'Failed to fetch /api/site/public/pages: 502 Bad Gateway',
    media_missing: 'File is missing current CMS storage metadata; media 404',
    media: 'Failed to download media; Media returned 502',
    content: 'CMS returned no published pages; CMS redirects response is invalid',
    search_content: 'Duplicate AI Search page item key; requires exactly one FAQ hub block',
    search: 'Cloudflare AI Search request failed; AI Search verification failed',
    postbuild: 'verify-detached failed',
    setup: 'ERR_PNPM_NO_SCRIPT Missing script',
    network: 'UND_ERR_SOCKET',
    code: 'Build failed in; Failed to prerender; TypeError',
    canceled: 'canceled outcome without explicit replacement evidence',
    fallback: 'no recognized signature',
  }
  const rules = [
    ...buildFailureRules,
    { id: 'canceled', reason: statusMessages.canceled },
    { id: 'fallback', reason: statusMessages.failure },
  ]
  const rows = rules.map((rule) => {
    const ids = groups.get(rule.id) ?? []
    return `| ${rule.id} | ${signatures[rule.id]} | ${rule.reason} | ${ids.length} | ${ids[0] ?? 'Not observed'} |`
  })
  const report = [
    '# Build failure research for 1.3.0',
    '',
    `Downloaded ${manifest.downloadedAt}: **${manifest.builds} available builds**, from ${manifest.earliest} through ${manifest.latest}.`,
    '',
    `All **${count} unsuccessful stopped builds** have complete cursor-paginated logs (${Object.entries(
      outcomes,
    )
      .map(([key, value]) => `${value} ${key}`)
      .join(
        ', ',
      )}). The initial download used ${manifest.requests} requests. This describes the history Cloudflare currently exposes, not a guarantee of indefinite retention.`,
    '',
    'Raw API responses and logs remain only in `.local/build-failure-research/`, which is git-ignored and excluded from the published package. They may contain secrets. This report contains only curated signatures, counts, fixed editor sentences, and example build IDs.',
    '',
    'Counts below are mutually exclusive first-rule matches over complete logs. Specific service and content failures precede generic command failures. Normal install commands, cache warnings, and successful lockfile checks do not count as failures.',
    '',
    '| Rule | Sanitized signature | Editor sentence | Historical count | Example build ID |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    `General failure fallback: **${groups.get('fallback')?.length ?? 0}**. Generic cancellations: **${groups.get('canceled')?.length ?? 0}**. The cancellation logs do not identify a newer publish, so the plugin does not guess that they were superseded. Terminated builds with explicit initialization timeout or internal service errors receive those specific reasons.`,
    '',
    'Zero-count rules are prospective coverage. Cloudflare documents clone, dependency installation, configuration, authentication, and timeout failures in [Workers Builds troubleshooting](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/). Resource-related rules also cover [build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/). The rules avoid numeric limits that could change.',
    '',
    '## Reproduce locally',
    '',
    'Use a recent Node.js version with `node:util.parseEnv`. Run `node scripts/research-build-failures.mjs --env=<payload-env-file>` to download all available build pages and resume completed per-build log downloads. It verifies that the output directory is ignored before writing. Then compile the plugin and run `node scripts/research-build-failures.mjs --analyze` to regenerate this sanitized report from the compiled classifier without API requests or reading credentials.',
    '',
    'The deployed plugin still requests ten recent build records. It downloads complete logs only for visible failed or canceled builds, once per build when KV is available. Successful builds and older failures require no failure-log requests. Log-download errors do not poison the cache and can be retried by a later status request.',
    '',
  ].join('\n')
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'docs/build-failure-research.md'), report)
  await writeFile(
    path.join(output, 'groups.json'),
    JSON.stringify(Object.fromEntries(groups), null, 2),
  )
  console.log(
    JSON.stringify(
      {
        builds: manifest.builds,
        analyzed: count,
        groups: Object.fromEntries([...groups].map(([id, ids]) => [id, ids.length])),
      },
      null,
      2,
    ),
  )
}

if (process.argv.includes('--analyze')) await analyzeHistory()
else await downloadHistory()
