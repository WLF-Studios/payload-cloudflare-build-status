# Build failure research for 1.3.0

Downloaded 2026-10-25T21:08:31.052Z: **974 available builds**, from 2026-06-09T09:35:49.946Z through 2026-10-25T20:09:39.520Z.

All **161 unsuccessful stopped builds** have complete cursor-paginated logs (147 fail, 2 terminated, 12 cancelled). The initial download used 264 requests. This describes the history Cloudflare currently exposes, not a guarantee of indefinite retention.

Raw API responses and logs remain only in `.local/build-failure-research/`, which is git-ignored and excluded from the published package. They may contain secrets. This report contains only curated signatures, counts, fixed editor sentences, and example build IDs.

Counts below are mutually exclusive first-rule matches over complete logs. Specific service and content failures precede generic command failures. Normal install commands, cache warnings, and successful lockfile checks do not count as failures.

| Rule | Sanitized signature | Editor sentence | Historical count | Example build ID |
| --- | --- | --- | ---: | --- |
| superseded | superseded by a newer build | Replaced by a newer publish. | 0 | Not observed |
| timeout | build failed to initialize; timed out | Publishing took too long; try again, or ask a developer if it keeps happening. | 1 | 038cebec-fb60-4dbb-b88f-77f7388e854b |
| memory | JavaScript heap out of memory | The site ran out of memory while building; a developer needs to reduce its memory use. | 0 | Not observed |
| clone | error occurred while fetching repository | The site code could not be downloaded; try again, or ask a developer to check the repository connection. | 2 | 7ba490f4-d742-416b-a3cd-f98f5ea7fa70 |
| lockfile | ERR_PNPM_LOCKFILE_CONFIG_MISMATCH | The site dependencies are out of sync; a developer needs to update them before publishing. | 1 | f4a046ee-77c3-4932-8a6b-3246bb28eafc |
| registry | ERR_PNPM_META_FETCH_FAIL | Build tools could not be downloaded; try publishing again shortly. | 0 | Not observed |
| install | error occurred while installing tools or dependencies | The build tools could not be installed; a developer needs to check the site setup. | 0 | Not observed |
| environment | Missing required environment variable | A required publishing setting is missing; a developer needs to add it. | 0 | Not observed |
| auth | Authentication error [code: 10000] | The publishing service could not sign in; a developer needs to restore its access. | 0 | Not observed |
| size | Worker exceeded the size limit | The site exceeds a publishing size limit; a developer needs to reduce its size. | 0 | Not observed |
| platform | Cloudflare API request failed; codes 10013, 10002, 971; internal error | The publishing service had a problem; try publishing again shortly. | 6 | 4b76add2-a891-4344-a198-7f899961ee1c |
| cms_auth | Failed to fetch /api/site/public/globals: 401 Unauthorized | The site could not access CMS content; a developer needs to restore its access. | 4 | 8635770a-55cf-4164-be04-bdca96b99487 |
| cms | Failed to fetch /api/site/public/pages: 502 Bad Gateway | The site could not load content from the CMS; try publishing again in a few minutes. | 26 | 0073d0bf-3a5f-429c-9c86-0443b077036c |
| media_missing | File is missing current CMS storage metadata; media 404 | An image or file is missing; check the page media or ask a developer to help. | 3 | 14524c4f-5e14-4d40-ab73-e2cbbf93c024 |
| media | Failed to download media; Media returned 502 | An image or file could not be loaded; try publishing again in a few minutes. | 17 | 08805dc1-c935-4fd4-bcbf-d62e6e0948e4 |
| content | CMS returned no published pages; CMS redirects response is invalid | Some page content is missing or invalid; check recent edits or ask a developer to help. | 11 | 04220662-0fdc-4bb7-b6a8-28f6f960c3e2 |
| search_content | Duplicate AI Search page item key; requires exactly one FAQ hub block | Search content has duplicate or missing entries; a developer needs to check it before publishing. | 17 | 052c7299-b923-4745-879b-57bd5f44af33 |
| search | Cloudflare AI Search request failed; AI Search verification failed | Site search could not be updated; try publishing again, or ask a developer if it keeps happening. | 8 | 0c2d4bf2-6f49-496d-bc29-1e8ce4e013c2 |
| postbuild | verify-detached failed | The site did not pass its publishing checks; a developer needs to fix the failing check. | 28 | 02abf681-5232-42fb-9ff5-15a3e9aaef9c |
| setup | ERR_PNPM_NO_SCRIPT Missing script | The publishing setup is incomplete or incorrect; a developer needs to fix it. | 2 | 21db6485-f351-4026-8d51-67853ed140f4 |
| network | UND_ERR_SOCKET | A connection needed for publishing failed; try publishing again shortly. | 1 | 15594b10-c303-418c-940e-20ee497715ca |
| code | Build failed in; Failed to prerender; TypeError | The site code has an error; a developer needs to fix it before publishing works. | 22 | 06e7022c-60ee-4662-9032-9fcb719fc707 |
| canceled | canceled outcome without explicit replacement evidence | Publishing was canceled; publish again when you are ready. | 12 | 2d78e818-23c7-4f9a-8b28-99455e961cd9 |
| fallback | no recognized signature | The site build failed; a developer needs to check the build log. | 0 | Not observed |

General failure fallback: **0**. Generic cancellations: **12**. The cancellation logs do not identify a newer publish, so the plugin does not guess that they were superseded. Terminated builds with explicit initialization timeout or internal service errors receive those specific reasons.

Zero-count rules are prospective coverage. Cloudflare documents clone, dependency installation, configuration, authentication, and timeout failures in [Workers Builds troubleshooting](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/). Resource-related rules also cover [build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/). The rules avoid numeric limits that could change.

## Reproduce locally

Use a recent Node.js version with `node:util.parseEnv`. Run `node scripts/research-build-failures.mjs --env=<payload-env-file>` to download all available build pages and resume completed per-build log downloads. It verifies that the output directory is ignored before writing. Then compile the plugin and run `node scripts/research-build-failures.mjs --analyze` to regenerate this sanitized report from the compiled classifier without API requests or reading credentials.

The deployed plugin still requests ten recent build records. It downloads complete logs only for visible failed or canceled builds, once per build when KV is available. Successful builds and older failures require no failure-log requests. Log-download errors do not poison the cache and can be retried by a later status request.
