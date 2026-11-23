/** Lists the open pull requests that involve the token's user, one organization at a time. */

import type {
  ChangeRequestSummary, ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery,
} from '@deepseek-ai/dsh-experimental-forge'
import { numeric, object, objects, text } from './api.ts'
import type { AzureApi, Json } from './api.ts'
import { loginOf, reviewDecisionOf, verdictOf } from './status.ts'
import { AZURE_FORGE, AZURE_HOST, locationOf, organizationApi, pullRequestUrl, repositoryApi } from './urls.ts'

/** The lists this provider reads, which never share a pull request. */
export const VIEWER_FILTERS: ReadonlySet<ForgeViewerFilter> = new Set(['review-requested', 'authored', 'involved'])

/** The token's user in one organization. */
export interface Viewer {
  /** Identity id, which pull request searches name. */
  readonly id: string
  /** Account name, usually the email. */
  readonly login: string
}

/**
 * Read who the token belongs to in an organization.
 * @param api - Azure DevOps reads.
 * @param organization - organization name.
 * @param signal - cancellation of the read.
 */
export async function readViewer(api: AzureApi, organization: string, signal: AbortSignal): Promise<Viewer | ForgeFailure> {
  const read = await api.get(`${organizationApi(organization)}/connectionData`, signal, '7.1-preview.1')
  if (!read.ok) return read.failure
  const user = object(object(read.body).authenticatedUser)
  const id = text(user.id)
  const login = text(object(object(user.properties).Account).$value) ?? text(user.providerDisplayName)
  // Azure DevOps answers an anonymous caller with an all-zero identity instead of refusing.
  if (id === undefined || login === undefined || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) {
    return { code: 'unauthenticated', message: `Azure DevOps did not say who the token belongs to in ${organization}` }
  }
  return { id, login }
}

/** One pull request of a list with the fields the three lists are told apart by. */
interface Listed {
  readonly summary: ChangeRequestSummary
  readonly created: number
}

/**
 * Map one pull request of a search to a summary. Azure DevOps reports no update time and no checks in a search, so
 * the summary's update time is the creation time and its checks read as none.
 */
export function summaryOf(pullRequest: Json, viewer: Viewer): Listed | undefined {
  const repository = object(pullRequest.repository)
  const project = text(object(repository.project).name)
  const name = text(repository.name)
  const number = numeric(pullRequest.pullRequestId)
  const organization = /^https:\/\/dev\.azure\.com\/([^/]+)\//.exec(text(repository.url) ?? text(pullRequest.url) ?? '')?.[1]
  if (project === undefined || name === undefined || number === undefined || organization === undefined) return undefined
  const ref = {
    repository: { forge: AZURE_FORGE, host: AZURE_HOST, owner: `${decodeURIComponent(organization)}/${project}`, name },
    number,
  }
  const mine = objects(pullRequest.reviewers).find(reviewer => text(reviewer.id) === viewer.id)
  const verdict = mine === undefined ? null : verdictOf(mine.vote)
  const author = loginOf(pullRequest.createdBy)
  const createdAt = text(pullRequest.creationDate) ?? new Date(0).toISOString()
  return {
    created: Date.parse(createdAt) || 0,
    summary: {
      ref,
      url: pullRequestUrl(ref),
      title: text(pullRequest.title) ?? `Pull request ${number}`,
      draft: pullRequest.isDraft === true,
      author: author === null ? null : { login: author, avatarUrl: null, bot: false },
      headSha: text(object(pullRequest.lastMergeSourceCommit).commitId) ?? '',
      checksRollup: 'none',
      reviewDecision: reviewDecisionOf(pullRequest),
      viewerReview: verdict === null ? null : { verdict, reviewedSha: null },
      viewerRequest: mine !== undefined && verdict === null ? { team: null } : null,
      closingIssues: [],
      closingIssuesTruncated: false,
      updatedAt: createdAt,
    },
  }
}

/** Where one list is read: every repository of some organizations, or one repository. */
export interface ViewerScope {
  readonly organizations: readonly string[]
  readonly repository: ForgeViewerQuery['repository']
}

/**
 * Read one list across the scope, newest first.
 *
 * `authored` searches by creator. `review-requested` and `involved` both search by reviewer, without the user's own
 * pull requests: the first keeps those the user has not voted on, the second those the user voted on. Reviews asked of
 * a team the user belongs to are not listed, because the search matches only the user's own identity.
 * @param api - Azure DevOps reads.
 * @param scope - organizations or the one repository to search.
 * @param filter - the list.
 * @param max - most pull requests one search returns.
 * @param signal - cancellation of the read.
 * @returns every match up to `max` per organization, and the login read as; or the first failure.
 */
export async function readViewerList(
  api: AzureApi, scope: ViewerScope, filter: ForgeViewerFilter, max: number, signal: AbortSignal,
): Promise<{ viewer: string; items: ChangeRequestSummary[] } | ForgeFailure> {
  const organizations = scope.repository === null ? scope.organizations : [locationOf(scope.repository).organization]
  const listed: Listed[] = []
  let login = ''
  for (const organization of organizations) {
    const viewer = await readViewer(api, organization, signal)
    if ('code' in viewer) return viewer
    login ||= viewer.login
    const base = scope.repository === null
      ? `${organizationApi(organization)}/git/pullrequests`
      : `${repositoryApi(locationOf(scope.repository))}/pullrequests`
    const who = filter === 'authored' ? `searchCriteria.creatorId=${viewer.id}` : `searchCriteria.reviewerId=${viewer.id}`
    const read = await api.get(`${base}?searchCriteria.status=active&${who}&$top=${max}`, signal)
    if (!read.ok) return read.failure
    for (const pullRequest of objects(object(read.body).value)) {
      const authored = text(object(pullRequest.createdBy).id) === viewer.id
      if (filter !== 'authored' && authored) continue
      const item = summaryOf(pullRequest, viewer)
      if (item === undefined) continue
      if (filter === 'review-requested' && item.summary.viewerRequest === null) continue
      if (filter === 'involved' && item.summary.viewerRequest !== null) continue
      listed.push(item)
    }
  }
  listed.sort((a, b) => b.created - a.created)
  return { viewer: login, items: listed.map(item => item.summary) }
}

/** Read one list as a page of at most `limit` pull requests. */
export async function viewerPage(
  api: AzureApi, scope: ViewerScope, filter: ForgeViewerFilter, limit: number, max: number, signal: AbortSignal,
): Promise<ForgeViewerList | ForgeFailure> {
  const read = await readViewerList(api, scope, filter, max, signal)
  if ('code' in read) return read
  return { viewer: read.viewer, items: read.items.slice(0, limit), total: read.items.length }
}
