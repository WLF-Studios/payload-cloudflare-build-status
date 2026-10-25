export const COMPLETED_BUILD_VISIBLE_MS = 3 * 60_000

export const statusMessages = {
  canceled: 'Publishing was canceled; publish again when you are ready.',
  config: 'Publishing is not configured; a developer needs to finish the setup.',
  connection: 'Build status could not be reached; check your connection and try again shortly.',
  failure: 'The site build failed; a developer needs to check the build log.',
  status: 'Build status is temporarily unavailable; try again shortly.',
} as const
