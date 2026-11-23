/** Azure Repos addresses: Git remotes, pull request pages, and the REST paths of a repository. */

import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'

/** The one host this provider serves; legacy `<org>.visualstudio.com` addresses are read as this host. */
export const AZURE_HOST = 'dev.azure.com'

/** Forge family name stored in every repository this provider returns. */
export const AZURE_FORGE = 'azure'

/** A repository as Azure DevOps addresses it. */
export interface AzureLocation {
  readonly organization: string
  readonly project: string
  readonly repository: string
}

const SEGMENT = /^[^/\\?#]+$/

function decoded(segment: string): string | undefined {
  try {
    const value = decodeURIComponent(segment)
    return SEGMENT.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function location(organization: string | undefined, project: string | undefined, repository: string | undefined): AzureLocation | undefined {
  if (organization === undefined || project === undefined || repository === undefined) return undefined
  const parts = [decoded(organization), decoded(project), decoded(repository.replace(/\.git$/, ''))]
  if (parts.some(part => part === undefined || part === '')) return undefined
  return { organization: parts[0] as string, project: parts[1] as string, repository: parts[2] as string }
}

/**
 * Split the path of an HTTPS address into organization, project, and what follows `_git/<repository>`.
 * `dev.azure.com/<org>/<project>/_git/<repo>` and `<org>.visualstudio.com[/DefaultCollection]/<project>/_git/<repo>`
 * are both accepted; a repository named after its project may omit the project (`<org>/_git/<repo>`).
 */
function parseHttps(url: URL): { location: AzureLocation; rest: string[] } | undefined {
  const host = url.hostname.toLowerCase()
  let segments = url.pathname.split('/').filter(segment => segment !== '')
  let organization: string | undefined
  if (host === AZURE_HOST) {
    organization = segments[0]
    segments = segments.slice(1)
  } else if (host.endsWith('.visualstudio.com') && host !== 'vs-ssh.visualstudio.com') {
    organization = host.slice(0, -'.visualstudio.com'.length)
    if (segments[0]?.toLowerCase() === 'defaultcollection') segments = segments.slice(1)
  } else {
    return undefined
  }
  const git = segments.indexOf('_git')
  if (git < 0 || git > 1) return undefined
  const repository = segments[git + 1]
  const found = location(organization, git === 1 ? segments[0] : repository, repository)
  return found === undefined ? undefined : { location: found, rest: segments.slice(git + 2) }
}

/**
 * Read a Git remote URL as an Azure Repos repository.
 * @param url - HTTPS or SSH remote, such as `https://org@dev.azure.com/org/project/_git/repo` or
 * `git@ssh.dev.azure.com:v3/org/project/repo`.
 * @returns the repository's location, or undefined when the URL is not an Azure Repos remote.
 */
export function parseRemoteUrl(url: string): AzureLocation | undefined {
  const ssh = /^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(url.trim())
  if (ssh !== null) return location(ssh[1], ssh[2], ssh[3])
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const found = parseHttps(parsed)
  return found === undefined || found.rest.length > 0 ? undefined : found.location
}

/**
 * Read a pull request web URL.
 * @param url - page address, such as `https://dev.azure.com/org/project/_git/repo/pullrequest/12`.
 * @returns the repository's location and the pull request number, or undefined for any other URL.
 */
export function parsePullRequestUrl(url: string): (AzureLocation & { readonly number: number }) | undefined {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  const found = parseHttps(parsed)
  if (found === undefined || found.rest.length !== 2 || found.rest[0]?.toLowerCase() !== 'pullrequest') return undefined
  const digits = found.rest[1] ?? ''
  if (!/^[1-9]\d{0,14}$/.test(digits)) return undefined
  return { ...found.location, number: Number(digits) }
}

/** The forge repository of a location: the owner is `<organization>/<project>`. */
export function repositoryOf(found: AzureLocation): ForgeRepository {
  return { forge: AZURE_FORGE, host: AZURE_HOST, owner: `${found.organization}/${found.project}`, name: found.repository }
}

/**
 * The location a forge repository names.
 * @throws when the owner is not `<organization>/<project>`.
 */
export function locationOf(repository: Pick<ForgeRepository, 'owner' | 'name'>): AzureLocation {
  const slash = repository.owner.indexOf('/')
  if (slash <= 0 || slash === repository.owner.length - 1 || repository.owner.includes('/', slash + 1) || repository.name === '') {
    throw new Error(`forge-azure: invalid repository ${JSON.stringify(`${repository.owner}/${repository.name}`)}`)
  }
  return { organization: repository.owner.slice(0, slash), project: repository.owner.slice(slash + 1), repository: repository.name }
}

const encode = encodeURIComponent

/** Web page of a repository. */
export function repositoryUrl(found: AzureLocation): string {
  return `https://${AZURE_HOST}/${encode(found.organization)}/${encode(found.project)}/_git/${encode(found.repository)}`
}

/** Canonical web page of a pull request. */
export function pullRequestUrl(ref: ChangeRequestRef): string {
  return `${repositoryUrl(locationOf(ref.repository))}/pullrequest/${ref.number}`
}

/** REST base of an organization: `https://dev.azure.com/<org>/_apis`. */
export function organizationApi(organization: string): string {
  return `https://${AZURE_HOST}/${encode(organization)}/_apis`
}

/** REST base of a project: `https://dev.azure.com/<org>/<project>/_apis`. */
export function projectApi(found: AzureLocation): string {
  return `https://${AZURE_HOST}/${encode(found.organization)}/${encode(found.project)}/_apis`
}

/** REST base of a repository's Git resources. */
export function repositoryApi(found: AzureLocation): string {
  return `${projectApi(found)}/git/repositories/${encode(found.repository)}`
}

/** REST base of one pull request. */
export function pullRequestApi(ref: ChangeRequestRef): string {
  return `${repositoryApi(locationOf(ref.repository))}/pullrequests/${ref.number}`
}

/** Whether `value` is a full SHA-1 object name. */
export function isCommit(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}

/** Strip `refs/heads/` from a branch ref name. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}
