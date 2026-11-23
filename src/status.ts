/** Maps an Azure DevOps pull request, its statuses, policy evaluations and threads to a forge snapshot. */

import type {
  ChangeRequestCheck, ChangeRequestRef, ChangeRequestReviewer, ChangeRequestSnapshot, ChangeRequestState, CheckState, ChecksRollup,
  Mergeability, ReviewDecision, ReviewVerdict,
} from '@deepseek-ai/dsh-experimental-forge'
import { numeric, object, objects, text } from './api.ts'
import type { Json } from './api.ts'
import { branchName, pullRequestUrl } from './urls.ts'

/** Lifecycle state from the pull request's `status`. */
export function stateOf(pullRequest: Json): ChangeRequestState {
  const status = text(pullRequest.status)
  return status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : 'open'
}

/** Conflict status from `mergeStatus`; anything but a finished merge check is unknown. */
export function mergeabilityOf(pullRequest: Json): Mergeability {
  const status = text(pullRequest.mergeStatus)
  return status === 'succeeded' ? 'mergeable' : status === 'conflicts' ? 'conflicting' : 'unknown'
}

/** How readers know an identity: its sign-in name, else its display name. */
export function loginOf(identity: unknown): string | null {
  const value = object(identity)
  return text(value.uniqueName) ?? text(value.displayName) ?? null
}

/**
 * A reviewer's verdict from their vote: 10 approves, 5 approves with suggestions, -5 waits for the author, -10 rejects.
 * Both negative votes read as changes requested; no vote is null.
 */
export function verdictOf(vote: unknown): ReviewVerdict | null {
  const value = numeric(vote) ?? 0
  return value > 0 ? 'approved' : value < 0 ? 'changes-requested' : null
}

/** The reviewers of a pull request without its author. */
export function reviewersOf(pullRequest: Json): ChangeRequestReviewer[] {
  const author = text(object(pullRequest.createdBy).id)
  const reviewers: ChangeRequestReviewer[] = []
  for (const reviewer of objects(pullRequest.reviewers)) {
    const login = loginOf(reviewer)
    if (login === null || (author !== undefined && text(reviewer.id) === author)) continue
    const verdict = verdictOf(reviewer.vote)
    reviewers.push({
      kind: reviewer.isContainer === true ? 'team' : 'user',
      login,
      // Azure DevOps avatar addresses need the user's session, so a browser cannot load them.
      avatarUrl: null,
      requested: verdict === null,
      codeOwner: false,
      verdict,
      reviewedSha: null,
    })
  }
  return reviewers
}

/**
 * Aggregate review outcome: changes requested once any reviewer waits or rejects; else review required while a required
 * reviewer has not voted; else approved once anyone approved.
 */
export function reviewDecisionOf(pullRequest: Json): ReviewDecision {
  const reviewers = objects(pullRequest.reviewers)
  const votes = reviewers.map(reviewer => numeric(reviewer.vote) ?? 0)
  if (votes.some(vote => vote < 0)) return 'changes-requested'
  if (reviewers.some(reviewer => reviewer.isRequired === true && (numeric(reviewer.vote) ?? 0) === 0)) return 'review-required'
  return votes.some(vote => vote > 0) ? 'approved' : 'none'
}

const STATUS_STATES: Readonly<Record<string, CheckState>> = {
  succeeded: 'success', failed: 'failure', error: 'failure', pending: 'pending', notApplicable: 'skipped', notSet: 'pending',
}

const POLICY_STATES: Readonly<Record<string, CheckState>> = {
  approved: 'success', rejected: 'failure', broken: 'failure', running: 'pending', queued: 'pending', notApplicable: 'skipped',
}

/**
 * Checks from pull request statuses, the newest of each context, then from policy evaluations (build validation,
 * required reviewers and the other branch policies).
 * @param statuses - `pullrequests/{id}/statuses` values.
 * @param evaluations - `policy/evaluations` values.
 */
export function checksOf(statuses: readonly Json[], evaluations: readonly Json[]): ChangeRequestCheck[] {
  const newest = new Map<string, Json>()
  for (const status of statuses) {
    const context = object(status.context)
    const name = text(context.name)
    if (name === undefined) continue
    const key = `${text(context.genre) ?? ''}/${name}`
    const kept = newest.get(key)
    if (kept === undefined || (numeric(status.id) ?? 0) >= (numeric(kept.id) ?? 0)) newest.set(key, status)
  }
  const checks: ChangeRequestCheck[] = []
  for (const status of newest.values()) {
    const context = object(status.context)
    const state = STATUS_STATES[text(status.state) ?? ''] ?? 'neutral'
    const at = text(status.updatedDate) ?? text(status.creationDate) ?? null
    checks.push({
      name: text(status.description) ?? (text(context.name) as string),
      state,
      url: text(status.targetUrl) ?? null,
      workflow: text(context.genre) ?? null,
      startedAt: text(status.creationDate) ?? null,
      completedAt: state === 'pending' ? null : at,
      rerun: null,
    })
  }
  for (const evaluation of evaluations) {
    const configuration = object(evaluation.configuration)
    if (configuration.isEnabled === false || configuration.isDeleted === true) continue
    const type = text(object(configuration.type).displayName)
    const name = text(object(configuration.settings).displayName) ?? type
    if (name === undefined) continue
    const state = POLICY_STATES[text(evaluation.status) ?? ''] ?? 'neutral'
    checks.push({
      name,
      // An optional policy that fails does not block the merge, so it reads as neutral.
      state: state === 'failure' && configuration.isBlocking === false ? 'neutral' : state,
      url: null,
      workflow: type ?? null,
      startedAt: text(evaluation.startedDate) ?? null,
      completedAt: state === 'pending' ? null : text(evaluation.completedDate) ?? null,
      rerun: null,
    })
  }
  return checks
}

/** Combined outcome of the checks. */
export function rollupOf(checks: readonly ChangeRequestCheck[]): ChecksRollup {
  if (checks.some(check => check.state === 'failure')) return 'failure'
  if (checks.some(check => check.state === 'pending')) return 'pending'
  return checks.some(check => check.state === 'success') ? 'success' : 'none'
}

/** Whether a thread is a discussion people wrote, not a deleted thread or a system message such as a vote or a push. */
export function isDiscussion(thread: Json): boolean {
  if (thread.isDeleted === true) return false
  return objects(thread.comments).some(comment => comment.isDeleted !== true && (text(comment.commentType) ?? 'text') === 'text')
}

const RESOLVED = new Set(['fixed', 'wontFix', 'closed', 'byDesign'])

/** Whether a discussion thread is resolved; a thread without a status, as a plain comment, counts as resolved. */
export function isResolved(thread: Json): boolean {
  const status = text(thread.status)
  return status === undefined || RESOLVED.has(status)
}

/** Parts of one snapshot. */
export interface SnapshotParts {
  readonly ref: ChangeRequestRef
  /** `pullrequests/{id}` body. */
  readonly pullRequest: Json
  /** `pullrequests/{id}/statuses` values. */
  readonly statuses: readonly Json[]
  /** `policy/evaluations` values; empty when they could not be read. */
  readonly evaluations: readonly Json[]
  /** `pullrequests/{id}/threads` values, or null when they could not be read. */
  readonly threads: readonly Json[] | null
}

/**
 * Build the snapshot of a pull request. This provider is read-only, so the snapshot offers no merge, branch update,
 * review request or rerun. Azure DevOps reports neither changed line counts nor an update time: the counts are 0, and
 * the update time is the newest of the creation time, the close time, and the times of threads and statuses.
 */
export function snapshotOf(parts: SnapshotParts): ChangeRequestSnapshot {
  const { ref, pullRequest } = parts
  const state = stateOf(pullRequest)
  const checks = checksOf(parts.statuses, parts.evaluations)
  const discussions = (parts.threads ?? []).filter(isDiscussion)
  const times = [
    text(pullRequest.creationDate), text(pullRequest.closedDate),
    ...(parts.threads ?? []).map(thread => text(thread.lastUpdatedDate)),
    ...parts.statuses.map(status => text(status.updatedDate) ?? text(status.creationDate)),
  ].filter((time): time is string => time !== undefined && !Number.isNaN(Date.parse(time)))
  const updatedAt = times.reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest, times[0] ?? new Date(0).toISOString())
  const baseSha = text(object(pullRequest.lastMergeTargetCommit).commitId)
  return {
    ref,
    url: pullRequestUrl(ref),
    title: text(pullRequest.title) ?? `Pull request ${ref.number}`,
    state,
    draft: pullRequest.isDraft === true,
    author: loginOf(pullRequest.createdBy),
    headBranch: branchName(text(pullRequest.sourceRefName) ?? ''),
    headSha: text(object(pullRequest.lastMergeSourceCommit).commitId) ?? '',
    baseBranch: branchName(text(pullRequest.targetRefName) ?? ''),
    ...baseSha === undefined ? {} : { baseSha },
    additions: 0,
    deletions: 0,
    mergeability: state === 'open' ? mergeabilityOf(pullRequest) : 'unknown',
    mergeReady: false,
    mergeMethods: [],
    branchUpdates: [],
    reviewDecision: reviewDecisionOf(pullRequest),
    reviewers: reviewersOf(pullRequest),
    reviewersTruncated: false,
    canRequestReviews: false,
    checks,
    checksRollup: rollupOf(checks),
    checksTruncated: false,
    canRerunChecks: false,
    unresolvedThreads: discussions.filter(thread => !isResolved(thread)).length,
    threadsTruncated: parts.threads === null,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt,
    closedAt: state === 'open' ? null : text(pullRequest.closedDate) ?? null,
  }
}
