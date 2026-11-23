import { describe, expect, it } from 'vitest'
import { isCommit, locationOf, parsePullRequestUrl, parseRemoteUrl, pullRequestApi, pullRequestUrl, repositoryOf } from '../src/urls.ts'
import { ref } from './fake.ts'

describe('remote URLs', () => {
  const expected = { organization: 'acme', project: 'Web Shop', repository: 'store' }

  it.each([
    'https://dev.azure.com/acme/Web%20Shop/_git/store',
    'https://acme@dev.azure.com/acme/Web%20Shop/_git/store',
    'https://dev.azure.com/acme/Web%20Shop/_git/store.git',
    'https://acme.visualstudio.com/Web%20Shop/_git/store',
    'https://acme.visualstudio.com/DefaultCollection/Web%20Shop/_git/store',
    'git@ssh.dev.azure.com:v3/acme/Web%20Shop/store',
    'ssh://git@ssh.dev.azure.com/v3/acme/Web%20Shop/store',
    'acme@vs-ssh.visualstudio.com:v3/acme/Web%20Shop/store',
  ])('reads %s', (url) => {
    expect(parseRemoteUrl(url)).toEqual(expected)
  })

  it('reads a repository named after its project', () => {
    expect(parseRemoteUrl('https://dev.azure.com/acme/_git/store')).toEqual({ organization: 'acme', project: 'store', repository: 'store' })
  })

  it.each([
    'https://github.com/acme/store.git',
    'https://dev.azure.com/acme/Web%20Shop',
    'https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7',
    'git@github.com:acme/store.git',
    'https://evil.example/dev.azure.com/acme/p/_git/store',
    'not a url',
  ])('ignores %s', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined()
  })
})

describe('pull request URLs', () => {
  it('reads both host forms', () => {
    const expected = { organization: 'acme', project: 'Web Shop', repository: 'store', number: 7 }
    expect(parsePullRequestUrl('https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7')).toEqual(expected)
    expect(parsePullRequestUrl('https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7?_a=files')).toEqual(expected)
    expect(parsePullRequestUrl('https://acme.visualstudio.com/Web%20Shop/_git/store/pullrequest/7')).toEqual(expected)
  })

  it.each([
    'https://dev.azure.com/acme/Web%20Shop/_git/store',
    'https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/0',
    'https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7/extra',
    'http://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7',
    'https://github.com/acme/store/pull/7',
  ])('ignores %s', (url) => {
    expect(parsePullRequestUrl(url)).toBeUndefined()
  })

  it('round-trips through the forge repository', () => {
    const found = parsePullRequestUrl('https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7')!
    const repository = repositoryOf(found)
    expect(repository).toEqual(ref.repository)
    expect(locationOf(repository)).toEqual({ organization: 'acme', project: 'Web Shop', repository: 'store' })
    expect(pullRequestUrl(ref)).toBe('https://dev.azure.com/acme/Web%20Shop/_git/store/pullrequest/7')
    expect(pullRequestApi(ref)).toBe('https://dev.azure.com/acme/Web%20Shop/_apis/git/repositories/store/pullrequests/7')
  })

  it('rejects an owner that is not organization/project', () => {
    expect(() => locationOf({ owner: 'acme', name: 'store' })).toThrow(/invalid repository/)
    expect(() => locationOf({ owner: 'a/b/c', name: 'store' })).toThrow(/invalid repository/)
  })
})

it('recognizes full commit names', () => {
  expect(isCommit('a'.repeat(40))).toBe(true)
  expect(isCommit('a'.repeat(39))).toBe(false)
  expect(isCommit('A'.repeat(40))).toBe(false)
})
