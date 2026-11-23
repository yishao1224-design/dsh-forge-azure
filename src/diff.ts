/**
 * Builds unified patches for Azure Repos, which has no patch endpoint: the changed paths between two commits come from
 * `diffs/commits`, and each file's two versions from `items`.
 */

import type { ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { structuredPatch } from 'diff'
import { numeric, object, objects, pool, text } from './api.ts'
import type { AzureApi } from './api.ts'
import { isCommit, locationOf, repositoryApi } from './urls.ts'

/** Changed paths one `diffs/commits` page asks for. */
const PAGE = 100

/** Bounds of one patch. */
export interface DiffLimits {
  /** Most changed files one patch describes. */
  readonly maxDiffFiles: number
  /** Most bytes of file text read for one patch, and of the patch itself. */
  readonly maxDiffBytes: number
  /** Most file reads in flight at once. */
  readonly maxConcurrentRequests: number
}

/** One changed file between two commits. */
export interface ChangedFile {
  /** Path on the new side; the old path for a deleted file. */
  readonly path: string
  /** Path on the old side; differs from `path` for a renamed file. */
  readonly oldPath: string
  readonly kind: 'add' | 'delete' | 'edit' | 'rename'
}

/** The changed files between two commits, and the commit the old side is read at. */
export interface ChangeList {
  /** Full object name of the commit the old side of every file is read at. */
  readonly base: string
  readonly files: readonly ChangedFile[]
}

const relative = (path: string): string => path.replace(/^\/+/, '')

/**
 * List the files that differ between two commits.
 * @param api - Azure DevOps reads.
 * @param ref - pull request whose repository holds both commits.
 * @param base - full object name of the old commit.
 * @param head - full object name of the new commit.
 * @param common - true to compare `head` with its merge base with `base`, as a pull request does.
 * @param limit - most files to list; more is a `too-large` failure.
 * @param signal - cancellation of the read.
 * @returns the files in path order and the old side's commit, or why Azure DevOps did not list them.
 */
export async function changedFiles(
  api: AzureApi, ref: ChangeRequestRef, base: string, head: string, common: boolean, limit: number, signal: AbortSignal,
): Promise<ChangeList | ForgeFailure> {
  const files = new Map<string, ChangedFile>()
  let oldCommit = base
  for (let skip = 0; ; skip += PAGE) {
    const read = await api.get(`${repositoryApi(locationOf(ref.repository))}/diffs/commits?baseVersion=${base}&baseVersionType=commit`
      + `&targetVersion=${head}&targetVersionType=commit&diffCommonCommit=${common}&$top=${PAGE}&$skip=${skip}`, signal)
    if (!read.ok) return read.failure
    const body = object(read.body)
    if (common) {
      const merged = text(body.commonCommit)
      if (merged === undefined || !isCommit(merged)) return { code: 'unavailable', message: 'Azure DevOps named no merge base commit' }
      oldCommit = merged
    }
    const changes = objects(body.changes)
    for (const change of changes) {
      const item = object(change.item)
      // Folders and submodule links carry no text.
      if (item.isFolder === true || (text(item.gitObjectType) ?? 'blob') !== 'blob') continue
      const path = text(item.path)
      if (path === undefined) continue
      const type = (text(change.changeType) ?? 'edit').toLowerCase()
      const original = text(change.sourceServerItem) ?? text(change.originalPath)
      const kind = type.includes('delete') ? 'delete' : type.includes('add') ? 'add' : type.includes('rename') ? 'rename' : 'edit'
      files.set(path, { path: relative(path), oldPath: relative(kind === 'rename' && original !== undefined ? original : path), kind })
      if (files.size > limit) return { code: 'too-large', message: `the change touches more than ${limit} files` }
    }
    if (body.allChangesIncluded !== false || changes.length === 0) break
  }
  const sorted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { base: oldCommit, files: sorted }
}

/** A file's text at a commit; `binary` when Azure DevOps reports binary content. */
export type FileRead = { readonly text: string } | { readonly binary: true } | ForgeFailure

/**
 * Read one file at a commit.
 * @param api - Azure DevOps reads.
 * @param ref - pull request whose repository holds the file.
 * @param commit - full object name of the commit.
 * @param path - repository-relative path.
 * @param signal - cancellation of the read.
 * @returns the text, a binary marker, or why Azure DevOps did not return the file.
 */
export async function readFile(api: AzureApi, ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<FileRead> {
  const read = await api.get(`${repositoryApi(locationOf(ref.repository))}/items?path=${encodeURIComponent(`/${relative(path)}`)}`
    + `&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json`, signal)
  if (!read.ok) return read.failure
  const body = object(read.body)
  if (object(body.contentMetadata).isBinary === true) return { binary: true }
  if (typeof body.content !== 'string') {
    // An empty file answers without content.
    return (numeric(body.size) ?? 0) === 0 ? { text: '' } : { code: 'unavailable', message: `Azure DevOps returned no content for ${path}` }
  }
  return body.content.includes('\0') ? { binary: true } : { text: body.content }
}

/**
 * Hunks of a text change in unified format with three lines of context.
 * @param oldName - old side's name, such as `a/<path>` or `/dev/null`.
 * @param newName - new side's name.
 * @param before - old text.
 * @param after - new text.
 * @returns the `---`/`+++` header and hunks, ending with a newline; empty when the texts are equal.
 */
export function textPatch(oldName: string, newName: string, before: string, after: string): string {
  const patch = structuredPatch(oldName, newName, before, after, '', '', { context: 3 })
  if (patch.hunks.length === 0) return ''
  // Git numbers an empty side from the line before it, so an added or deleted file's empty side starts at 0.
  const start = (line: number, count: number): number => count === 0 ? line - 1 : line
  const hunks = patch.hunks.map(hunk =>
    `@@ -${start(hunk.oldStart, hunk.oldLines)},${hunk.oldLines} +${start(hunk.newStart, hunk.newLines)},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`)
  return `--- ${oldName}\n+++ ${newName}\n${hunks.join('')}`
}

/** One file's section of a Git patch. */
export function filePatch(file: ChangedFile, before: FileRead | null, after: FileRead | null): string {
  const header = [`diff --git a/${file.oldPath} b/${file.path}`]
  if (file.kind === 'add') header.push('new file mode 100644')
  else if (file.kind === 'delete') header.push('deleted file mode 100644')
  else if (file.kind === 'rename') header.push(`rename from ${file.oldPath}`, `rename to ${file.path}`)
  const oldName = file.kind === 'add' ? '/dev/null' : `a/${file.oldPath}`
  const newName = file.kind === 'delete' ? '/dev/null' : `b/${file.path}`
  const binary = (before !== null && 'binary' in before) || (after !== null && 'binary' in after)
  if (binary) return `${header.join('\n')}\nBinary files ${oldName} and ${newName} differ\n`
  const beforeText = before !== null && 'text' in before ? before.text : ''
  const afterText = after !== null && 'text' in after ? after.text : ''
  return `${header.join('\n')}\n${textPatch(oldName, newName, beforeText, afterText)}`
}

/**
 * Build the patch between two commits as one unified patch with `a/` and `b/` prefixes.
 * @param api - Azure DevOps reads.
 * @param ref - pull request whose repository holds both commits.
 * @param base - full object name of the old commit.
 * @param head - full object name of the new commit.
 * @param common - true to compare `head` with its merge base with `base`.
 * @param limits - bounds of the patch.
 * @param signal - cancellation of the read.
 * @returns the patch, empty when nothing differs, or why it could not be built.
 */
export async function buildPatch(
  api: AzureApi, ref: ChangeRequestRef, base: string, head: string, common: boolean, limits: DiffLimits, signal: AbortSignal,
): Promise<string | ForgeFailure> {
  const listed = await changedFiles(api, ref, base, head, common, limits.maxDiffFiles, signal)
  if ('code' in listed) return listed
  const sections = new Map<ChangedFile, string>()
  let bytes = 0
  let failed: ForgeFailure | undefined
  const local = new AbortController()
  const combined = AbortSignal.any([signal, local.signal])
  const fail = (failure: ForgeFailure): void => {
    failed ??= failure
    local.abort()
  }
  try {
    await pool(listed.files, limits.maxConcurrentRequests, async (file) => {
      if (failed !== undefined) return
      const [before, after] = await Promise.all([
        file.kind === 'add' ? null : readFile(api, ref, listed.base, file.oldPath, combined),
        file.kind === 'delete' ? null : readFile(api, ref, head, file.path, combined),
      ])
      for (const side of [before, after]) {
        if (side === null) continue
        if ('code' in side) return fail(side.code === 'not-found' ? { code: 'unavailable', message: side.message } : side)
        if ('text' in side) bytes += Buffer.byteLength(side.text)
      }
      if (bytes > limits.maxDiffBytes) return fail({ code: 'too-large', message: 'the changed files exceed maxDiffBytes' })
      sections.set(file, filePatch(file, before, after))
    })
  } catch (error) {
    if (failed === undefined) throw error
  }
  if (signal.aborted) throw signal.reason
  if (failed !== undefined) return failed
  const patch = listed.files.map(file => sections.get(file) ?? '').join('')
  return Buffer.byteLength(patch) > limits.maxDiffBytes ? { code: 'too-large', message: 'the patch exceeds maxDiffBytes' } : patch
}
