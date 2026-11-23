/** Maps Azure DevOps pull request threads to forge review threads, read-only. */

import type {
  ChangeRequestRef, ForgeAnchor, ForgeCommentId, ForgeReviewComment, ForgeReviewData, ForgeReviewThread, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge'
import { numeric, object, objects, text } from './api.ts'
import type { Json } from './api.ts'
import { isDiscussion, isResolved, loginOf } from './status.ts'
import { isCommit, pullRequestUrl } from './urls.ts'

/** Source commit of each iteration (push) of a pull request, by iteration id. */
export type IterationCommits = ReadonlyMap<number, string>

/** Read `pullrequests/{id}/iterations` values as iteration id to source commit. */
export function iterationCommits(iterations: readonly Json[]): IterationCommits {
  const commits = new Map<number, string>()
  for (const iteration of iterations) {
    const id = numeric(iteration.id)
    const commit = text(object(iteration.sourceRefCommit).commitId)
    if (id !== undefined && commit !== undefined && isCommit(commit)) commits.set(id, commit)
  }
  return commits
}

function lines(start: unknown, end: unknown): { startLine: number; endLine: number } | undefined {
  const first = numeric(object(start).line)
  const last = numeric(object(end).line) ?? first
  if (first === undefined || last === undefined || first < 1 || last < first) return undefined
  return { startLine: first, endLine: last }
}

/** The side and lines of a thread position, or undefined for a position on the whole file. */
function position(context: Json, prefix: '' | 'orig'): { side: 'L' | 'R'; startLine: number; endLine: number } | undefined {
  const key = (name: string): string => prefix === '' ? name : `${prefix}${name[0]?.toUpperCase()}${name.slice(1)}`
  const right = lines(context[key('rightFileStart')], context[key('rightFileEnd')])
  if (right !== undefined) return { side: 'R', ...right }
  const left = lines(context[key('leftFileStart')], context[key('leftFileEnd')])
  return left === undefined ? undefined : { side: 'L', ...left }
}

/**
 * Map one discussion thread on a file. A thread written on the newest iteration, or one Azure DevOps tracked to it, is
 * placed on the head commit; any other is outdated and keeps only the position it was written at.
 * @param ref - pull request the thread belongs to.
 * @param thread - one `threads` value that {@link isDiscussion} accepts.
 * @param headSha - head commit of the read.
 * @param iterations - source commit of each iteration.
 * @returns the thread, or undefined for a discussion on the pull request as a whole, which has no file to show it on.
 */
export function threadOf(ref: ChangeRequestRef, thread: Json, headSha: string, iterations: IterationCommits): ForgeReviewThread | undefined {
  const id = numeric(thread.id)
  const context = object(thread.threadContext)
  const path = text(context.filePath)?.replace(/^\/+/, '')
  if (id === undefined || path === undefined) return undefined
  const latest = Math.max(0, ...iterations.keys())
  const pullRequestContext = object(thread.pullRequestThreadContext)
  const written = numeric(object(pullRequestContext.iterationContext).secondComparingIteration)
  const tracking = object(pullRequestContext.trackingCriteria)
  const tracked = numeric(tracking.secondComparingIteration)
  const now = position(context, '')
  const then = position(tracking, 'orig') ?? now
  const writtenCommit = written === undefined ? undefined : iterations.get(written)
  const onHead = written === undefined || written === latest || tracked === latest
  const anchor = (commit: string | undefined, at: typeof now): ForgeAnchor | null =>
    commit === undefined || at === undefined ? null : { commit, startLine: at.startLine, endLine: at.endLine }
  const url = `${pullRequestUrl(ref)}?discussionId=${id}`
  const comments: ForgeReviewComment[] = []
  for (const comment of objects(thread.comments)) {
    if (comment.isDeleted === true || (text(comment.commentType) ?? 'text') !== 'text') continue
    const login = loginOf(comment.author)
    comments.push({
      id: `${id}:${numeric(comment.id) ?? comments.length + 1}` as ForgeCommentId,
      author: login === null ? null : { login, avatarUrl: null, bot: false },
      body: typeof comment.content === 'string' ? comment.content : '',
      createdAt: text(comment.publishedDate) ?? text(comment.lastUpdatedDate) ?? new Date(0).toISOString(),
      pending: false,
      url,
      viewerCanEdit: false,
      viewerCanDelete: false,
    })
  }
  if (comments.length === 0) return undefined
  return {
    id: String(id) as ForgeThreadId,
    path,
    side: (onHead ? now : then)?.side ?? 'R',
    subject: now === undefined && then === undefined ? 'file' : 'line',
    current: onHead ? anchor(headSha, now) : null,
    original: anchor(writtenCommit ?? (onHead ? headSha : undefined), then),
    diffHunk: null,
    resolved: isResolved(thread),
    viewerCanReply: false,
    viewerCanResolve: false,
    comments,
  }
}

/**
 * Map the threads of a pull request read at one head commit. The provider is read-only, so no thread or comment can be
 * written and there is no pending review.
 * @param ref - pull request.
 * @param threads - `threads` values.
 * @param iterations - `iterations` values.
 * @param headSha - head commit of the read.
 * @param viewer - login the provider read as, or null.
 * @param limit - most threads returned.
 */
export function reviewDataOf(
  ref: ChangeRequestRef, threads: readonly Json[], iterations: readonly Json[], headSha: string, viewer: string | null, limit: number,
): ForgeReviewData {
  const commits = iterationCommits(iterations)
  const mapped: ForgeReviewThread[] = []
  for (const thread of threads) {
    if (!isDiscussion(thread)) continue
    const found = threadOf(ref, thread, headSha, commits)
    if (found !== undefined) mapped.push(found)
  }
  return {
    headSha,
    viewer,
    threads: mapped.slice(0, limit),
    truncated: mapped.length > limit,
    pendingReview: null,
    viewerCanReview: false,
    reviewEvents: [],
  }
}
