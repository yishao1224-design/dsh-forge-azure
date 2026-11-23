/** Read-only Azure DevOps implementation of the forge provider contract, over the REST API with a personal access token. */

import type {
  ChangeRequestDescription, ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ForgeActionFailure, ForgeFailure,
  ForgeProvider, ForgeReadiness, ForgeRepository, ForgeReviewData, ForgeViewerCapability, ForgeViewerFilter, ForgeViewerList,
  ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import { object, objects, pool, text } from './api.ts'
import type { AzureApi, Json } from './api.ts'
import { buildPatch, changedFiles, readFile } from './diff.ts'
import type { DiffLimits } from './diff.ts'
import { reviewDataOf } from './review.ts'
import { snapshotOf } from './status.ts'
import {
  AZURE_FORGE, AZURE_HOST, branchName, isCommit, locationOf, parsePullRequestUrl, parseRemoteUrl, projectApi, pullRequestApi,
  pullRequestUrl, repositoryApi, repositoryOf, repositoryUrl,
} from './urls.ts'
import { readViewer, readViewerList, VIEWER_FILTERS, viewerPage } from './viewer.ts'

/** Open pull requests a head lookup returns. */
const HEAD_LOOKUP = 20

/** Labels one description lists. */
const LABELS = 50

/** Bounds of the provider's reads. */
export interface AzureLimits extends DiffLimits {
  /** Most review threads one review read returns. */
  readonly maxReviewThreads: number
  /** Most pull requests one viewer list read returns per organization. */
  readonly maxViewerItems: number
}

const READ_ONLY = 'forge-azure is read-only: do this on the pull request page in Azure DevOps'

/**
 * Canonical identity of a change request, spelled as the forge registry's `changeRequestKey` spells it; this package
 * imports nothing from the registry at run time.
 */
export function changeRequestKey(ref: ChangeRequestRef): ChangeRequestKey {
  const { forge, host, owner, name } = ref.repository
  return `${forge}:${host}/${owner}/${name}#${ref.number}`.toLowerCase() as ChangeRequestKey
}

/** Reads Azure Repos pull requests on dev.azure.com; every write is refused. */
export class AzureProvider implements ForgeProvider {
  readonly forge = AZURE_FORGE
  readonly hosts: readonly string[] = [AZURE_HOST]
  readonly label = 'Azure DevOps'
  readonly changeRequestNoun = 'pull-request'
  readonly viewer: ForgeViewerCapability

  /**
   * @param api - Azure DevOps reads.
   * @param organizations - organizations whose pull requests the viewer lists read.
   * @param limits - read bounds.
   */
  constructor(private readonly api: AzureApi, private readonly organizations: readonly string[], private readonly limits: AzureLimits) {
    this.viewer = { hosts: this.hosts, filters: VIEWER_FILTERS, maxItems: limits.maxViewerItems }
  }

  repositoryFromRemote(url: string): ForgeRepository | undefined {
    const found = parseRemoteUrl(url)
    return found === undefined ? undefined : repositoryOf(found)
  }

  changeRequestFromUrl(url: string): ChangeRequestRef | undefined {
    const found = parsePullRequestUrl(url)
    return found === undefined ? undefined : { repository: repositoryOf(found), number: found.number }
  }

  changeRequestUrl(ref: ChangeRequestRef): string {
    return pullRequestUrl(ref)
  }

  async fetch(
    refs: readonly ChangeRequestRef[], signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>> {
    const results = new Map<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>()
    await pool(refs, this.limits.maxConcurrentRequests, async (ref) => {
      results.set(changeRequestKey(ref), await this.snapshot(ref, signal))
    })
    return results
  }

  async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]> {
    const refused = this.hostFailure(repository.host)
    if (refused !== undefined) throw new Error(refused.message)
    const base = repositoryApi(locationOf(repository))
    const [settings, listing] = await Promise.all([
      this.api.get(base, signal),
      this.api.get(`${base}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}`
        + `&$top=${HEAD_LOOKUP}`, signal),
    ])
    if (!settings.ok) throw new Error(`forge-azure: head branch lookup failed: ${settings.failure.message}`)
    if (!listing.ok) throw new Error(`forge-azure: head branch lookup failed: ${listing.failure.message}`)
    if (branchName(text(object(settings.body).defaultBranch) ?? '') === branch) return []
    const found: ChangeRequestRef[] = []
    for (const pullRequest of objects(object(listing.body).value)) {
      const number = pullRequest.pullRequestId
      // A pull request from a fork names the fork as its source.
      if (typeof number === 'number' && pullRequest.forkSource == null) found.push({ repository, number })
    }
    return found
  }

  async readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness> {
    const refused = this.hostFailure(host)
    if (refused !== undefined) return { state: 'unavailable', message: refused.message, signIn: null }
    const organization = this.organizations[0]
    // Without an organization to ask, a probe that needs no organization still tells a missing token apart.
    const read = organization === undefined
      ? await this.api.get(`https://${AZURE_HOST}/_apis/resourceAreas`, signal, '7.1-preview.1')
      : await readViewer(this.api, organization, signal)
    const failure = 'ok' in read ? (read.ok ? undefined : read.failure) : 'code' in read ? read : undefined
    if (failure === undefined) return { state: 'ready', message: null, signIn: null }
    return { state: failure.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable', message: failure.message, signIn: null }
  }

  async markReady(): Promise<ForgeActionFailure | undefined> {
    return { code: 'failed', message: READ_ONLY }
  }

  async merge(): Promise<ForgeActionFailure | undefined> {
    return { code: 'failed', message: READ_ONLY }
  }

  /**
   * Build the patch from the merge base of the target branch's commit and `headSha` to `headSha`, the comparison a
   * pull request page shows. `base` is not needed: the pull request names its own target commit.
   */
  async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    if (!isCommit(headSha)) throw new Error(`forge-azure: invalid head commit ${JSON.stringify(headSha)}`)
    const at = await this.pullRequestAt(ref, headSha, signal)
    if ('failure' in at) return at.failure
    const target = text(object(at.pullRequest.lastMergeTargetCommit).commitId)
    if (target === undefined || !isCommit(target)) return { code: 'unavailable', message: 'Azure DevOps named no target commit for the pull request' }
    return await buildPatch(this.api, ref, target, headSha, true, this.limits, signal)
  }

  async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-azure: invalid commits ${JSON.stringify(`${base}..${head}`)}`)
    return await buildPatch(this.api, ref, base, head, false, this.limits, signal)
  }

  async mergeBase(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    if (!isCommit(base) || !isCommit(head)) throw new Error(`forge-azure: invalid commits ${JSON.stringify(`${base}..${head}`)}`)
    const listed = await changedFiles(this.api, ref, base, head, true, Number.MAX_SAFE_INTEGER, signal)
    return 'code' in listed ? listed : listed.base
  }

  async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    if (!isCommit(commit)) throw new Error(`forge-azure: invalid commit ${JSON.stringify(commit)}`)
    const read = await readFile(this.api, ref, commit, path, signal)
    if ('code' in read) return read
    return 'text' in read ? read.text : { code: 'unavailable', message: `${path} is a binary file` }
  }

  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string {
    return `${repositoryUrl(locationOf(ref.repository))}?path=${encodeURIComponent(`/${path.replace(/^\/+/, '')}`)}&version=GC${commit}`
  }

  async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    const [pullRequest, labels] = await Promise.all([
      this.api.get(pullRequestApi(ref), signal),
      this.api.get(`${pullRequestApi(ref)}/labels`, signal),
    ])
    if (!pullRequest.ok) return pullRequest.failure
    const body = object(pullRequest.body)
    const names = labels.ok ? objects(object(labels.body).value).filter(label => label.active !== false).map(label => text(label.name)) : []
    const listed = names.filter((name): name is string => name !== undefined)
    return {
      body: typeof body.description === 'string' ? body.description : '',
      labels: listed.slice(0, LABELS).map(name => ({ name, color: null })),
      labelsTruncated: listed.length > LABELS || !labels.ok,
      images: {},
      imagesExpireAt: null,
      createdAt: text(body.creationDate) ?? new Date(0).toISOString(),
    }
  }

  async readReview(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    if (!isCommit(headSha)) throw new Error(`forge-azure: invalid head commit ${JSON.stringify(headSha)}`)
    const at = await this.pullRequestAt(ref, headSha, signal)
    if ('failure' in at) return at.failure
    const [threads, iterations] = await Promise.all([
      this.api.get(`${pullRequestApi(ref)}/threads`, signal),
      this.api.get(`${pullRequestApi(ref)}/iterations`, signal),
    ])
    if (!threads.ok) return threads.failure
    if (!iterations.ok) return iterations.failure
    return reviewDataOf(ref, objects(object(threads.body).value), objects(object(iterations.body).value), headSha, null, this.limits.maxReviewThreads)
  }

  async listForViewer(query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure> {
    const refused = this.viewerFailure(query.host, query.repository !== null)
    if (refused !== undefined) return refused
    if (!VIEWER_FILTERS.has(query.filter)) return { code: 'unsupported', message: `forge-azure reads no ${query.filter} list` }
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > this.limits.maxViewerItems) {
      throw new Error(`forge-azure: viewer list limit must be a positive integer no greater than ${this.limits.maxViewerItems}`)
    }
    const scope = { organizations: this.organizations, repository: query.repository }
    return await viewerPage(this.api, scope, query.filter, query.limit, this.limits.maxViewerItems, signal)
  }

  async countForViewer(host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> {
    const refused = this.viewerFailure(host, false)
    if (refused !== undefined) return refused
    const counts = new Map<ForgeViewerFilter, number>()
    for (const filter of VIEWER_FILTERS) {
      const read = await readViewerList(this.api, { organizations: this.organizations, repository: null }, filter, this.limits.maxViewerItems, signal)
      if ('code' in read) return read
      counts.set(filter, read.items.length)
    }
    return counts
  }

  /** Read one pull request with its statuses, policy evaluations and threads; only the pull request itself must be readable. */
  private async snapshot(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const refused = this.hostFailure(ref.repository.host)
    if (refused !== undefined) return refused
    const read = await this.api.get(pullRequestApi(ref), signal)
    if (!read.ok) return read.failure
    const pullRequest = object(read.body)
    const project = text(object(object(pullRequest.repository).project).id)
    const artifact = project === undefined ? undefined : encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${project}/${ref.number}`)
    const [statuses, threads, evaluations] = await Promise.all([
      this.api.get(`${pullRequestApi(ref)}/statuses`, signal),
      this.api.get(`${pullRequestApi(ref)}/threads`, signal),
      artifact === undefined ? undefined
        : this.api.get(`${projectApi(locationOf(ref.repository))}/policy/evaluations?artifactId=${artifact}`, signal, '7.1-preview.1'),
    ])
    const values = (result: typeof statuses | undefined): Json[] => result?.ok === true ? objects(object(result.body).value) : []
    return snapshotOf({
      ref, pullRequest, statuses: values(statuses), evaluations: values(evaluations), threads: threads.ok ? values(threads) : null,
    })
  }

  /** Read the pull request once its head is `headSha`; a different head is a `stale` failure. */
  private async pullRequestAt(
    ref: ChangeRequestRef, headSha: string, signal: AbortSignal,
  ): Promise<{ readonly pullRequest: Json } | { readonly failure: ForgeFailure }> {
    const read = await this.api.get(pullRequestApi(ref), signal)
    if (!read.ok) return { failure: read.failure }
    const pullRequest = object(read.body)
    const head = text(object(pullRequest.lastMergeSourceCommit).commitId)
    if (head !== headSha) return { failure: { code: 'stale', message: `the head of pull request ${ref.number} is no longer ${headSha}` } }
    return { pullRequest }
  }

  private viewerFailure(host: string, oneRepository: boolean): ForgeFailure | undefined {
    const refused = this.hostFailure(host)
    if (refused !== undefined) return { code: 'unsupported', message: refused.message }
    if (!oneRepository && this.organizations.length === 0) {
      return { code: 'unsupported', message: 'forge-azure lists pull requests only for the organizations named in its `organizations` setting' }
    }
    return undefined
  }

  private hostFailure(host: string): ForgeFailure | undefined {
    return host.toLowerCase() === AZURE_HOST ? undefined : { code: 'unavailable', message: `forge-azure serves only ${AZURE_HOST}, not ${host}` }
  }
}
