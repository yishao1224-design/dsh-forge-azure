/** Authenticated, read-only requests to the Azure DevOps REST API. */

import type { ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'

/** REST API version every request names. */
export const API_VERSION = '7.1'

/** Outcome of one read: the parsed JSON body, or why Azure DevOps did not answer with one. */
export type AzureRead =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly failure: ForgeFailure; readonly status: number | null }

/** Looks up the personal access token for each request, so a rotated token applies without a restart. */
export type TokenSource = () => Promise<string | undefined>

/** The `fetch` this client calls; tests replace it. */
export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' }) => Promise<Response>

/** Limits of one request. */
export interface AzureApiConfig {
  /** Deadline in milliseconds for one request, including reading its body. */
  readonly timeoutMs: number
  /** Most bytes of one response body. */
  readonly maxResponseBytes: number
}

function failure(code: ForgeFailure['code'], message: string, status: number | null): AzureRead {
  return { ok: false, failure: { code, message }, status }
}

/** Message Azure DevOps put in an error body, or undefined when the body carries none. */
function serverMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string') return parsed.message
  } catch { /* not JSON */ }
  return undefined
}

/** Sends GET requests with the personal access token as HTTP Basic credentials; never writes. */
export class AzureApi {
  /**
   * @param token - reads the personal access token.
   * @param config - request limits.
   * @param fetcher - HTTP client, the global `fetch` by default.
   */
  constructor(
    private readonly token: TokenSource,
    private readonly config: AzureApiConfig,
    private readonly fetcher: FetchLike = async (url, init) => await fetch(url, init),
  ) {}

  /**
   * Read one JSON resource.
   * @param url - absolute `https://dev.azure.com/...` address without `api-version`.
   * @param signal - cancellation of the read.
   * @param version - API version, for resources that exist only as a preview.
   * @returns the parsed body, or the failure. A missing or rejected token is `unauthenticated`.
   */
  async get(url: string, signal: AbortSignal, version: string = API_VERSION): Promise<AzureRead> {
    if (!url.startsWith('https://dev.azure.com/')) throw new Error(`forge-azure: refusing to request ${JSON.stringify(url)}`)
    const token = (await this.token())?.trim()
    if (token === undefined || token === '') return failure('unauthenticated', 'no Azure DevOps personal access token is configured', null)
    const address = `${url}${url.includes('?') ? '&' : '?'}api-version=${version}`
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([signal, deadline])
    let response: Response
    let text: string
    try {
      response = await this.fetcher(address, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
          Accept: 'application/json',
          'X-TFS-FedAuthRedirect': 'Suppress',
        },
        signal: combined,
        // A sign-in redirect means the token was rejected; following it would fetch an HTML page.
        redirect: 'manual',
      })
      const length = Number(response.headers.get('content-length') ?? '0')
      if (length > this.config.maxResponseBytes) return failure('too-large', 'the Azure DevOps response exceeds maxResponseBytes', response.status)
      text = await response.text()
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (deadline.aborted) return failure('unavailable', `Azure DevOps did not answer within ${this.config.timeoutMs}ms`, null)
      return failure('unavailable', `Azure DevOps could not be reached: ${error instanceof Error ? error.message : String(error)}`, null)
    }
    if (Buffer.byteLength(text) > this.config.maxResponseBytes) return failure('too-large', 'the Azure DevOps response exceeds maxResponseBytes', response.status)
    const status = response.status
    // Azure DevOps answers a rejected token with 401, or with 203 or a redirect that leads to its sign-in page.
    if (status === 401 || status === 203 || (status >= 300 && status < 400)) {
      return failure('unauthenticated', 'Azure DevOps rejected the personal access token', status)
    }
    if (status === 404) return failure('not-found', serverMessage(text) ?? 'Azure DevOps does not expose the resource', status)
    if (status === 429) return failure('rate-limited', serverMessage(text) ?? 'Azure DevOps refused the read under its rate limit', status)
    if (status === 403) return failure('unavailable', serverMessage(text) ?? 'the personal access token may not read the resource', status)
    if (status < 200 || status >= 300) return failure('unavailable', serverMessage(text) ?? `Azure DevOps answered HTTP ${status}`, status)
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      return failure('unavailable', 'Azure DevOps answered with a body that is not JSON', status)
    }
  }
}

/** A JSON object, for reading response fields without trusting their types. */
export type Json = Record<string, unknown>

/** `value` as an object, or an empty object. */
export function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}

/** `value` as an array of objects; other values and elements are dropped. */
export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'object' && item !== null && !Array.isArray(item)) as Json[] : []
}

/** `value` when it is a non-empty string. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** `value` when it is a finite number. */
export function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Run `task` on every item, at most `limit` at a time; settles once every task settled, then rejects with the first rejection. */
export async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const errors: unknown[] = []
  const worker = async (): Promise<void> => {
    while (next < items.length && errors.length === 0) {
      const item = items[next++] as T
      try {
        await task(item)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (errors.length > 0) throw errors[0]
}
