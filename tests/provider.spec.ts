import { describe, expect, it } from 'vitest'
import { createProvider } from '../src/index.ts'
import { changeRequestKey } from '../src/provider.ts'
import { BASE, connectionData, FakeAzure, HEAD, ME, OTHER, PR, pullRequest, ref, REPO, signal, TARGET, TOKEN } from './fake.ts'

const env = { DSH_OKF_AZURE_TOKEN: TOKEN }
const ORG = 'https://dev.azure.com/acme/_apis'

function setup(config: Parameters<typeof createProvider>[0] = { organizations: ['acme'] }, environment: NodeJS.ProcessEnv = env) {
  const azure = new FakeAzure()
  return { azure, provider: createProvider(config, azure.fetch, environment) }
}

describe('token', () => {
  it('sends the PAT as Basic credentials and never in the URL', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    await provider.fetch([ref], signal)
    expect(azure.calls.length).toBeGreaterThan(0)
    for (const call of azure.calls) {
      expect(call.authorization).toBe(`Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`)
      expect(call.url).not.toContain(TOKEN)
      expect(call.url).toContain('api-version=7.1')
    }
  })

  it('falls back to DSH_OKF_GIT_TOKEN', async () => {
    const { azure, provider } = setup(undefined, { DSH_OKF_GIT_TOKEN: TOKEN })
    azure.on(PR, pullRequest())
    expect((await provider.fetch([ref], signal)).get(changeRequestKey(ref))).toMatchObject({ title: 'Add checkout' })
  })

  it('reports a missing token without sending a request', async () => {
    const { azure, provider } = setup(undefined, {})
    expect((await provider.fetch([ref], signal)).get(changeRequestKey(ref))).toMatchObject({ code: 'unauthenticated' })
    expect(await provider.readiness('dev.azure.com', signal)).toMatchObject({ state: 'unauthenticated', signIn: null })
    expect(azure.calls).toEqual([])
  })

  it('reads a sign-in redirect as a rejected token', async () => {
    const { provider } = setup(undefined, { DSH_OKF_AZURE_TOKEN: 'expired' })
    expect((await provider.fetch([ref], signal)).get(changeRequestKey(ref))).toMatchObject({ code: 'unauthenticated' })
  })
})

describe('status', () => {
  it('builds a read-only snapshot with checks, reviewers and unresolved threads', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    azure.on(`${PR}/statuses`, { value: [
      { id: 1, state: 'failed', context: { name: 'build', genre: 'ci' }, creationDate: '2026-11-01T10:05:00Z' },
      { id: 2, state: 'succeeded', description: 'Build succeeded', context: { name: 'build', genre: 'ci' }, targetUrl: 'https://dev.azure.com/acme/build/2', creationDate: '2026-11-02T08:00:00Z' },
    ] })
    azure.on('https://dev.azure.com/acme/Web%20Shop/_apis/policy/evaluations', (url: URL) => {
      expect(url.searchParams.get('artifactId')).toBe('vstfs:///CodeReview/CodeReviewId/project-id/7')
      return { value: [
        { status: 'running', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'PR validation' } } },
        { status: 'rejected', configuration: { isBlocking: false, type: { displayName: 'Comment requirements' }, settings: {} } },
      ] }
    })
    azure.on(`${PR}/threads`, { value: [
      { id: 1, status: 'active', lastUpdatedDate: '2026-11-03T09:00:00Z', comments: [{ id: 1, commentType: 'text', content: 'Why?' }] },
      { id: 2, status: 'fixed', comments: [{ id: 1, commentType: 'text', content: 'Done' }] },
      { id: 3, comments: [{ id: 1, commentType: 'system', content: 'Dana voted 10' }] },
      { id: 4, status: 'active', isDeleted: true, comments: [{ id: 1, commentType: 'text', content: 'gone' }] },
    ] })
    const snapshot = (await provider.fetch([ref], signal)).get(changeRequestKey(ref))
    expect(snapshot).toMatchObject({
      url: 'https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7',
      title: 'Add checkout', state: 'open', draft: false, author: 'dana@acme.test',
      headBranch: 'feature/checkout', headSha: HEAD, baseBranch: 'main', baseSha: TARGET,
      mergeability: 'mergeable', mergeReady: false, mergeMethods: [], branchUpdates: [],
      reviewDecision: 'review-required', canRequestReviews: false, canRerunChecks: false,
      checksRollup: 'pending', unresolvedThreads: 1, threadsTruncated: false,
      updatedAt: '2026-11-03T09:00:00Z', closedAt: null,
    })
    if (snapshot === undefined || 'code' in snapshot) throw new Error('expected a snapshot')
    expect(snapshot.checks).toEqual([
      expect.objectContaining({ name: 'Build succeeded', state: 'success', workflow: 'ci', url: 'https://dev.azure.com/acme/build/2' }),
      expect.objectContaining({ name: 'PR validation', state: 'pending', workflow: 'Build', completedAt: null }),
      expect.objectContaining({ name: 'Comment requirements', state: 'neutral' }),
    ])
    expect(snapshot.reviewers).toEqual([
      expect.objectContaining({ kind: 'user', login: 'me@acme.test', requested: true, verdict: null }),
      expect.objectContaining({ kind: 'team', requested: false, verdict: 'approved' }),
    ])
  })

  it('still answers when statuses, policies and threads cannot be read', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest({ status: 'completed', closedDate: '2026-11-05T00:00:00Z', reviewers: [{ id: ME, uniqueName: 'me@acme.test', vote: -5 }] }))
    expect((await provider.fetch([ref], signal)).get(changeRequestKey(ref))).toMatchObject({
      state: 'merged', mergeability: 'unknown', reviewDecision: 'changes-requested', checks: [], checksRollup: 'none',
      threadsTruncated: true, closedAt: '2026-11-05T00:00:00Z',
    })
  })

  it('maps a missing pull request and a host it does not serve', async () => {
    const { provider } = setup()
    expect((await provider.fetch([ref], signal)).get(changeRequestKey(ref))).toMatchObject({ code: 'not-found' })
    const elsewhere = { repository: { ...ref.repository, host: 'tfs.acme.test' }, number: 7 }
    expect((await provider.fetch([elsewhere], signal)).get(changeRequestKey(elsewhere))).toMatchObject({ code: 'unavailable' })
  })

  it('refuses every write', async () => {
    const { azure, provider } = setup()
    expect(await provider.markReady()).toMatchObject({ code: 'failed' })
    expect(await provider.merge()).toMatchObject({ code: 'failed' })
    expect(azure.calls).toEqual([])
    expect('writeReview' in provider || 'submitReview' in provider).toBe(false)
  })
})

describe('head lookup', () => {
  it('finds open pull requests of a branch, without forks and the default branch', async () => {
    const { azure, provider } = setup()
    azure.on(REPO, { defaultBranch: 'refs/heads/main' })
    azure.on(`${REPO}/pullrequests`, (url: URL) => {
      expect(url.searchParams.get('searchCriteria.sourceRefName')).toMatch(/^refs\/heads\/(feature\/checkout|main)$/)
      expect(url.searchParams.get('searchCriteria.status')).toBe('active')
      return { value: [{ pullRequestId: 7 }, { pullRequestId: 9, forkSource: { repository: { id: 'fork' } } }] }
    })
    expect(await provider.findByHead(ref.repository, 'feature/checkout', signal)).toEqual([ref])
    expect(await provider.findByHead(ref.repository, 'main', signal)).toEqual([])
  })
})

describe('diff', () => {
  const item = (content: string | undefined, extra: Record<string, unknown> = {}) => ({ content, size: content?.length ?? 0, ...extra })

  function withFiles(azure: FakeAzure, files: Record<string, unknown>): void {
    azure.on(`${REPO}/items`, (url: URL) => {
      const key = `${url.searchParams.get('versionDescriptor.version')}:${url.searchParams.get('path')}`
      return key in files ? files[key] : Response.json({ message: 'missing' }, { status: 404 })
    })
  }

  it('builds a unified patch from the merge base to the head', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    azure.on(`${REPO}/diffs/commits`, (url: URL) => {
      expect(url.searchParams.get('baseVersion')).toBe(TARGET)
      expect(url.searchParams.get('targetVersion')).toBe(HEAD)
      expect(url.searchParams.get('diffCommonCommit')).toBe('true')
      return { commonCommit: BASE, allChangesIncluded: true, changes: [
        { item: { path: '/src', isFolder: true, gitObjectType: 'tree' }, changeType: 'edit' },
        { item: { path: '/src/cart.ts', gitObjectType: 'blob' }, changeType: 'edit' },
        { item: { path: '/src/new.ts', gitObjectType: 'blob' }, changeType: 'add' },
        { item: { path: '/src/old.ts', gitObjectType: 'blob' }, changeType: 'delete' },
        { item: { path: '/docs/guide.md', gitObjectType: 'blob' }, changeType: 'edit, rename', sourceServerItem: '/docs/intro.md' },
        { item: { path: '/logo.png', gitObjectType: 'blob' }, changeType: 'edit' },
      ] }
    })
    withFiles(azure, {
      [`${BASE}:/src/cart.ts`]: item('one\ntwo\nthree\n'),
      [`${HEAD}:/src/cart.ts`]: item('one\n2\nthree\n'),
      [`${HEAD}:/src/new.ts`]: item('hello\n'),
      [`${BASE}:/src/old.ts`]: item('bye\n'),
      [`${BASE}:/docs/intro.md`]: item('# Intro\n'),
      [`${HEAD}:/docs/guide.md`]: item('# Guide\n'),
      [`${BASE}:/logo.png`]: item(undefined, { size: 10, contentMetadata: { isBinary: true } }),
      [`${HEAD}:/logo.png`]: item(undefined, { size: 12, contentMetadata: { isBinary: true } }),
    })
    expect(await provider.diff(ref, HEAD, signal)).toBe([
      'diff --git a/docs/intro.md b/docs/guide.md', 'rename from docs/intro.md', 'rename to docs/guide.md',
      '--- a/docs/intro.md', '+++ b/docs/guide.md', '@@ -1,1 +1,1 @@', '-# Intro', '+# Guide',
      'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/src/cart.ts b/src/cart.ts', '--- a/src/cart.ts', '+++ b/src/cart.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+2', ' three',
      'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,1 @@', '+hello',
      'diff --git a/src/old.ts b/src/old.ts', 'deleted file mode 100644', '--- a/src/old.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye',
      '',
    ].join('\n'))
    expect(await provider.mergeBase(ref, TARGET, HEAD, signal)).toBe(BASE)
  })

  it('answers stale once the head moved, and too-large over the file limit', async () => {
    const { azure, provider } = setup({ maxDiffFiles: 1 })
    azure.on(PR, pullRequest())
    expect(await provider.diff(ref, 'd'.repeat(40), signal)).toMatchObject({ code: 'stale' })
    azure.on(`${REPO}/diffs/commits`, { commonCommit: BASE, changes: [
      { item: { path: '/a', gitObjectType: 'blob' }, changeType: 'add' }, { item: { path: '/b', gitObjectType: 'blob' }, changeType: 'add' },
    ] })
    expect(await provider.diff(ref, HEAD, signal)).toMatchObject({ code: 'too-large' })
  })

  it('pages through the changed files', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    azure.on(`${REPO}/diffs/commits`, (url: URL) => url.searchParams.get('$skip') === '0'
      ? { commonCommit: BASE, allChangesIncluded: false, changes: [{ item: { path: '/a.txt', gitObjectType: 'blob' }, changeType: 'add' }] }
      : { commonCommit: BASE, allChangesIncluded: true, changes: [{ item: { path: '/b.txt', gitObjectType: 'blob' }, changeType: 'add' }] })
    withFiles(azure, { [`${HEAD}:/a.txt`]: item('a\n'), [`${HEAD}:/b.txt`]: item('b\n') })
    const patch = await provider.diff(ref, HEAD, signal)
    expect(patch).toContain('+++ b/a.txt')
    expect(patch).toContain('+++ b/b.txt')
  })

  it('reads file text and links to the file page', async () => {
    const { azure, provider } = setup()
    withFiles(azure, { [`${HEAD}:/src/cart.ts`]: item('one\n'), [`${HEAD}:/empty`]: item(undefined) })
    expect(await provider.fileText(ref, HEAD, 'src/cart.ts', signal)).toBe('one\n')
    expect(await provider.fileText(ref, HEAD, 'empty', signal)).toBe('')
    expect(await provider.fileText(ref, HEAD, 'nope', signal)).toMatchObject({ code: 'not-found' })
    expect(provider.fileUrl(ref, HEAD, 'src/cart.ts')).toBe(`https://dev.azure.com/acme/Web%20Shop/_git/store?path=%2Fsrc%2Fcart.ts&version=GC${HEAD}`)
  })
})

describe('review threads', () => {
  it('places threads on the head, marks outdated ones, and skips what has no file', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    azure.on(`${PR}/iterations`, { value: [{ id: 1, sourceRefCommit: { commitId: BASE } }, { id: 2, sourceRefCommit: { commitId: HEAD } }] })
    const comment = { id: 1, commentType: 'text', content: 'Rename this', publishedDate: '2026-11-02T00:00:00Z', author: { uniqueName: 'dana@acme.test' } }
    azure.on(`${PR}/threads`, { value: [
      { id: 10, status: 'active', comments: [comment, { id: 2, commentType: 'text', isDeleted: true }],
        threadContext: { filePath: '/src/cart.ts', rightFileStart: { line: 4, offset: 1 }, rightFileEnd: { line: 6, offset: 3 } },
        pullRequestThreadContext: { iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 } } },
      { id: 11, status: 'fixed', comments: [comment],
        threadContext: { filePath: '/src/cart.ts', leftFileStart: { line: 2, offset: 1 }, leftFileEnd: { line: 2, offset: 9 } },
        pullRequestThreadContext: { iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 } } },
      { id: 12, status: 'active', comments: [comment],
        threadContext: { filePath: '/src/cart.ts', rightFileStart: { line: 9, offset: 1 }, rightFileEnd: { line: 9, offset: 2 } },
        pullRequestThreadContext: {
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
          trackingCriteria: { firstComparingIteration: 1, secondComparingIteration: 2, origRightFileStart: { line: 7, offset: 1 }, origRightFileEnd: { line: 7, offset: 2 } },
        } },
      { id: 13, status: 'active', comments: [comment], threadContext: { filePath: '/README.md' } },
      { id: 14, status: 'active', comments: [comment] },
      { id: 15, comments: [{ id: 1, commentType: 'system', content: 'pushed' }] },
    ] })
    const review = await provider.readReview(ref, HEAD, signal)
    if ('code' in review) throw new Error(review.message)
    expect(review).toMatchObject({ headSha: HEAD, truncated: false, pendingReview: null, viewerCanReview: false, reviewEvents: [] })
    expect(review.threads.map(thread => [thread.id, thread.side, thread.subject, thread.resolved, thread.current, thread.original])).toEqual([
      ['10', 'R', 'line', false, { commit: HEAD, startLine: 4, endLine: 6 }, { commit: HEAD, startLine: 4, endLine: 6 }],
      ['11', 'L', 'line', true, null, { commit: BASE, startLine: 2, endLine: 2 }],
      ['12', 'R', 'line', false, { commit: HEAD, startLine: 9, endLine: 9 }, { commit: BASE, startLine: 7, endLine: 7 }],
      ['13', 'R', 'file', false, null, null],
    ])
    expect(review.threads[0]).toMatchObject({ path: 'src/cart.ts', viewerCanReply: false, viewerCanResolve: false })
    expect(review.threads[0]?.comments).toEqual([expect.objectContaining({
      id: '10:1', body: 'Rename this', author: { login: 'dana@acme.test', avatarUrl: null, bot: false },
      url: 'https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7?discussionId=10', viewerCanEdit: false, viewerCanDelete: false,
    })])
    expect(await provider.readReview(ref, 'd'.repeat(40), signal)).toMatchObject({ code: 'stale' })
  })
})

describe('description', () => {
  it('reads the description and active labels', async () => {
    const { azure, provider } = setup()
    azure.on(PR, pullRequest())
    azure.on(`${PR}/labels`, { value: [{ name: 'ui', active: true }, { name: 'old', active: false }] })
    expect(await provider.readDescription(ref, signal)).toEqual({
      body: 'Adds the **checkout** page.', labels: [{ name: 'ui', color: null }], labelsTruncated: false,
      images: {}, imagesExpireAt: null, createdAt: '2026-11-01T10:00:00Z',
    })
  })
})

describe('viewer lists', () => {
  const mineToReview = pullRequest()
  const reviewed = pullRequest({ pullRequestId: 8, title: 'Reviewed', creationDate: '2026-11-04T00:00:00Z', reviewers: [{ id: ME, uniqueName: 'me@acme.test', vote: 10 }] })
  const authored = pullRequest({ pullRequestId: 9, title: 'Mine', createdBy: { id: ME, uniqueName: 'me@acme.test' }, reviewers: [{ id: ME, uniqueName: 'me@acme.test', vote: 0 }] })

  function lists(azure: FakeAzure): void {
    azure.on(`${ORG}/connectionData`, connectionData)
    azure.on(`${ORG}/git/pullrequests`, (url: URL) => {
      expect(url.searchParams.get('searchCriteria.status')).toBe('active')
      if (url.searchParams.get('searchCriteria.creatorId') === ME) return { value: [authored] }
      expect(url.searchParams.get('searchCriteria.reviewerId')).toBe(ME)
      return { value: [mineToReview, reviewed, authored] }
    })
  }

  it('splits the three lists without overlap', async () => {
    const { azure, provider } = setup()
    lists(azure)
    const query = { host: 'dev.azure.com', repository: null, limit: 50 } as const
    const requested = await provider.listForViewer({ ...query, filter: 'review-requested' }, signal)
    const involved = await provider.listForViewer({ ...query, filter: 'involved' }, signal)
    const own = await provider.listForViewer({ ...query, filter: 'authored' }, signal)
    if ('code' in requested || 'code' in involved || 'code' in own) throw new Error('expected lists')
    expect(requested).toMatchObject({ viewer: 'me@acme.test', total: 1 })
    expect(requested.items[0]).toMatchObject({
      ref, title: 'Add checkout', headSha: HEAD, author: { login: 'dana@acme.test' }, reviewDecision: 'review-required',
      viewerRequest: { team: null }, viewerReview: null, checksRollup: 'none',
    })
    expect(involved.items.map(item => item.title)).toEqual(['Reviewed'])
    expect(involved.items[0]).toMatchObject({ viewerRequest: null, viewerReview: { verdict: 'approved' } })
    expect(own.items.map(item => item.title)).toEqual(['Mine'])
    expect(await provider.countForViewer('dev.azure.com', signal)).toEqual(new Map([['review-requested', 1], ['authored', 1], ['involved', 1]]))
  })

  it('reads one repository through its own endpoint and cuts the page at the limit', async () => {
    const { azure, provider } = setup({ organizations: [] })
    azure.on(`${ORG}/connectionData`, connectionData)
    azure.on(`${REPO}/pullrequests`, { value: [mineToReview, pullRequest({ pullRequestId: 12, creationDate: '2026-11-09T00:00:00Z' })] })
    const page = await provider.listForViewer({
      host: 'dev.azure.com', filter: 'review-requested', repository: { owner: 'acme/Web Shop', name: 'store' }, limit: 1,
    }, signal)
    if ('code' in page) throw new Error(page.message)
    expect(page.total).toBe(2)
    expect(page.items.map(item => item.ref.number)).toEqual([12])
  })

  it('is unsupported without organizations, and unauthenticated for an anonymous identity', async () => {
    const none = setup({ organizations: [] })
    expect(await none.provider.listForViewer({ host: 'dev.azure.com', filter: 'authored', repository: null, limit: 10 }, signal)).toMatchObject({ code: 'unsupported' })
    expect(await none.provider.countForViewer('dev.azure.com', signal)).toMatchObject({ code: 'unsupported' })
    const { azure, provider } = setup()
    azure.on(`${ORG}/connectionData`, { authenticatedUser: { id: '00000000-0000-0000-0000-000000000000', providerDisplayName: 'Anonymous' } })
    expect(await provider.listForViewer({ host: 'dev.azure.com', filter: 'authored', repository: null, limit: 10 }, signal)).toMatchObject({ code: 'unauthenticated' })
    expect(await provider.readiness('dev.azure.com', signal)).toMatchObject({ state: 'unauthenticated' })
    expect(OTHER).not.toBe(ME)
  })
})

describe('settings', () => {
  it('rejects invalid values', () => {
    expect(() => createProvider({ organizations: ['bad/name'] })).toThrow(/organizations/)
    expect(() => createProvider({ tokenEnv: [] })).toThrow(/tokenEnv/)
    expect(() => createProvider({ timeoutMs: 0 })).toThrow(/timeoutMs/)
  })
})
