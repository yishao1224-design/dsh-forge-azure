/** A stand-in Azure DevOps REST API written from Microsoft's REST reference; it answers only what a test registers. */

import type { FetchLike } from '../src/api.ts'

export const HEAD = 'a'.repeat(40)
export const TARGET = 'b'.repeat(40)
export const BASE = 'c'.repeat(40)
export const ME = '11111111-1111-1111-1111-111111111111'
export const OTHER = '22222222-2222-2222-2222-222222222222'
export const TOKEN = 'test-pat'

export const REPO = 'https://dev.azure.com/acme/Web%20Shop/_apis/git/repositories/store'
export const PR = `${REPO}/pullrequests/7`

export const ref = { repository: { forge: 'azure', host: 'dev.azure.com', owner: 'acme/Web Shop', name: 'store' }, number: 7 }

export interface Call {
  readonly url: string
  readonly authorization: string | undefined
}

type Answer = unknown | ((url: URL) => unknown) | Response

/** Routes by URL without its query, or by a predicate on the whole URL. */
export class FakeAzure {
  readonly calls: Call[] = []
  private readonly routes: { match: (url: URL) => boolean; answer: Answer }[] = []

  on(path: string | ((url: URL) => boolean), answer: Answer): this {
    const match = typeof path === 'string' ? (url: URL) => `${url.origin}${url.pathname}` === path : path
    this.routes.unshift({ match, answer })
    return this
  }

  readonly fetch: FetchLike = async (address, init) => {
    this.calls.push({ url: address, authorization: init.headers.Authorization })
    init.signal.throwIfAborted()
    if (init.headers.Authorization !== `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`) {
      return new Response('', { status: 302, headers: { location: 'https://spsprodeus.vssps.visualstudio.com/_signin' } })
    }
    const url = new URL(address)
    const route = this.routes.find(candidate => candidate.match(url))
    if (route === undefined) return Response.json({ message: `no route for ${url.pathname}` }, { status: 404 })
    const answer = typeof route.answer === 'function' ? (route.answer as (url: URL) => unknown)(url) : route.answer
    return answer instanceof Response ? answer : Response.json(answer)
  }
}

export function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 7,
    title: 'Add checkout',
    description: 'Adds the **checkout** page.',
    status: 'active',
    isDraft: false,
    mergeStatus: 'succeeded',
    creationDate: '2026-11-01T10:00:00Z',
    sourceRefName: 'refs/heads/feature/checkout',
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: HEAD },
    lastMergeTargetCommit: { commitId: TARGET },
    createdBy: { id: OTHER, displayName: 'Dana', uniqueName: 'dana@acme.test' },
    reviewers: [
      { id: ME, displayName: 'Me', uniqueName: 'me@acme.test', vote: 0, isRequired: true },
      { id: '33333333-3333-3333-3333-333333333333', displayName: '[Web Shop]\\Leads', uniqueName: 'vstfs:///Classification/TeamProject/x\\Leads', vote: 10, isContainer: true },
    ],
    repository: {
      id: 'repo-id', name: 'store', url: REPO, project: { id: 'project-id', name: 'Web Shop' },
    },
    url: `${REPO}/pullRequests/7`,
    ...overrides,
  }
}

export const connectionData = {
  authenticatedUser: { id: ME, providerDisplayName: 'Me', properties: { Account: { $type: 'System.String', $value: 'me@acme.test' } } },
}

export const signal = new AbortController().signal
