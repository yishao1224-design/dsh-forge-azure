/**
 * Registers a read-only Azure DevOps provider with `ctx.forge`, so the Code review page and the session panel show
 * Azure Repos pull requests. The token is the personal access token dsh-okf uses, read from the environment.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import { AzureApi } from './api.ts'
import type { FetchLike, TokenSource } from './api.ts'
import { AzureProvider } from './provider.ts'

export const name = 'forge-azure'
export const inject = ['forge']

/** Organizations to list, the token's variables, and read limits. */
export interface Config {
  /** Azure DevOps organizations whose pull requests the Code review page lists; without any, the page lists none. */
  organizations?: string[]
  /** Environment variables that may hold the personal access token (Code: Read), the first set one wins. */
  tokenEnv?: string[]
  /** Deadline in milliseconds for one request. */
  timeoutMs?: number
  /** Most bytes of one response body. */
  maxResponseBytes?: number
  /** Most requests in flight for one status fetch or one diff. */
  maxConcurrentRequests?: number
  /** Most changed files one diff describes. */
  maxDiffFiles?: number
  /** Most bytes of file text read for one diff, and of the patch. */
  maxDiffBytes?: number
  /** Most review threads one review read returns. */
  maxReviewThreads?: number
  /** Most pull requests one list read returns per organization. */
  maxViewerItems?: number
}

/** Defaults of every setting. */
export const DEFAULTS: Required<Config> = {
  organizations: [],
  tokenEnv: ['DSH_OKF_AZURE_TOKEN', 'DSH_OKF_GIT_TOKEN'],
  timeoutMs: 30_000,
  maxResponseBytes: 16_777_216,
  maxConcurrentRequests: 6,
  maxDiffFiles: 300,
  maxDiffBytes: 4_194_304,
  maxReviewThreads: 500,
  maxViewerItems: 100,
}

const ORGANIZATION = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/i
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Apply defaults and reject settings the provider cannot run with.
 * @throws with the setting's name when a value is invalid.
 */
export function resolveConfig(config: Config | undefined): Required<Config> {
  const resolved = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== null)) } as Required<Config>
  if (!Array.isArray(resolved.organizations) || resolved.organizations.some(item => typeof item !== 'string' || !ORGANIZATION.test(item))) {
    throw new Error('forge-azure: organizations must list Azure DevOps organization names')
  }
  if (!Array.isArray(resolved.tokenEnv) || resolved.tokenEnv.length === 0 || resolved.tokenEnv.some(item => typeof item !== 'string' || !VARIABLE.test(item))) {
    throw new Error('forge-azure: tokenEnv must list at least one environment variable name')
  }
  for (const key of ['timeoutMs', 'maxResponseBytes', 'maxConcurrentRequests', 'maxDiffFiles', 'maxDiffBytes', 'maxReviewThreads', 'maxViewerItems'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-azure: ${key} must be a positive safe integer`)
  }
  if (resolved.timeoutMs > 2_147_483_647) throw new Error('forge-azure: timeoutMs is too large')
  return resolved
}

/**
 * Build the token lookup: the first named variable that holds a value, read at each request so a rotated token applies
 * to the next one. The token is never logged, stored, or put in a URL.
 */
export function tokenFrom(names: readonly string[], env: NodeJS.ProcessEnv = process.env): TokenSource {
  return async () => {
    for (const variable of names) {
      const value = env[variable]?.trim()
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }
}

/**
 * Build the provider from settings.
 * @param config - settings before defaults.
 * @param fetcher - HTTP client for tests; the global `fetch` otherwise.
 * @param env - environment the token is read from.
 */
export function createProvider(config?: Config, fetcher?: FetchLike, env?: NodeJS.ProcessEnv): AzureProvider {
  const resolved = resolveConfig(config)
  return new AzureProvider(new AzureApi(tokenFrom(resolved.tokenEnv, env), resolved, fetcher), resolved.organizations, resolved)
}

export function apply(ctx: Context, config: Config): void {
  ctx.forge.register(createProvider(config))
}
