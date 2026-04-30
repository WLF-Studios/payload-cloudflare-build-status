# Payload Cloudflare Build Status

Payload admin plugin that shows the latest Cloudflare Workers Build status as a compact admin badge.

<p align="center">
  <img alt="Cloudflare build status demo" src="assets/cf-build-status.gif" width="100%" />
</p>

Built for headless Payload setups, especially Payload plus an Astro SSG frontend deployed through Cloudflare Workers Builds. It is display-only: it does not trigger deploys, add schema, or expose Cloudflare secrets to the browser.

Tested with Payload `3.84` and Next.js `16.2`.

## Install

```bash
pnpm add payload-cloudflare-build-status
```

## Quick Setup

Add `cloudflareBuildStatusPlugin()` to your Payload config file `src/payload.config.ts`:

```ts
// src/payload.config.ts
import { buildConfig } from 'payload'
import { cloudflareBuildStatusPlugin } from 'payload-cloudflare-build-status'

export default buildConfig({
  plugins: [
    cloudflareBuildStatusPlugin(),
  ],
})
```

Add the Cloudflare credentials to your server environment file, usually `.env`:

```env
CF_ACCOUNT_ID=your-account-id
CF_API_TOKEN=your-api-token
CF_WORKER_TAG=your-worker-tag
```

If you prefer selecting the Worker by name instead of tag, use `CF_WORKER_NAME` instead of `CF_WORKER_TAG`.

If needed, refresh the generated Payload admin import map file, usually `app/(payload)/admin/importMap.js`:

```bash
pnpm payload generate:importmap
```

## Environment

Required server-side env vars:

- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`

Worker selector:

- `CF_WORKER_TAG` is preferred
- `CF_WORKER_NAME` can be used instead; the plugin resolves it to the immutable Worker tag on the server

Optional live-site link:

- `PUBLIC_SITE_URL`

The Cloudflare token needs Workers Builds Configuration edit access. If using `CF_WORKER_NAME` or fetching the tag manually, it also needs Workers Scripts read access.

## Get the Worker Tag

Cloudflare's Builds API calls this value `external_script_id`. The Workers Scripts API returns it as `tag`.

Use a token with Workers Scripts read access, then list your Workers.

PowerShell:

```powershell
$accountId = "your-account-id"
$token = "your-api-token"

$response = Invoke-RestMethod `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/scripts" `
  -Headers @{ Authorization = "Bearer $token" }

$response.result | ForEach-Object {
  [pscustomobject]@{
    name = $_.id
    tag = $_.tag
  }
}
```

Bash:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts" \
  --header "Authorization: Bearer $CF_API_TOKEN" \
  | jq '.result[] | {name: .id, tag: .tag}'
```

Copy the `tag` for your Worker into `.env`:

```env
CF_WORKER_TAG=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

After `CF_WORKER_TAG` is set, the plugin does not need Workers Scripts read access for the Worker-name lookup.

## What It Adds

- a Payload admin action badge
- `GET /api/cloudflare-build-status`
- status labels for loading, building, queued, live, failed, canceled, ready, config missing, and error
- one initial status fetch when the admin loads
- polling every 10 seconds only while a Worker build is queued or running
- short post-save watching: every 2 seconds for up to 30 seconds after a Payload save

## Configuration

```ts
// src/payload.config.ts
cloudflareBuildStatusPlugin({
  endpointPath: '/cloudflare-build-status',
  componentPath: 'payload-cloudflare-build-status/client#CloudflareBuildStatus',
  pollIntervalSeconds: 10,
  disabled: false,
})
```

Options:

- `endpointPath`: Payload API endpoint path registered by the plugin.
- `componentPath`: Payload admin import-map path for the badge component.
- `pollIntervalSeconds`: polling interval, in seconds, while a Cloudflare build is queued or running.
- `disabled`: disables the plugin without changing the rest of your Payload config.

## Development

For local plugin development, use the internal `dev/` app:

```bash
pnpm install
pnpm dev
pnpm generate:types
pnpm generate:importmap
```

Plugin source is in `src/`. The internal test app is in `dev/`, with its Payload config at `dev/payload.config.ts`.
The dev app maps `payload-cloudflare-build-status/*` package imports back to `../src/*` in `dev/tsconfig.json`, so the generated admin import map works before the package has been built to `dist/`.

For checks:

```bash
pnpm test:int
pnpm lint
```

## Test in Another Project

For release validation, test the packed artifact instead of a live source-folder dependency:

```bash
pnpm build
pnpm pack
```

Then in the external consumer app:

```bash
pnpm add /path/payload-cloudflare-build-status-*.tgz
```
