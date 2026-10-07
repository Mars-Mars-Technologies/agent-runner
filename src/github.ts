import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

export interface OpenPullRequestArgs {
  githubRepo: string
  title: string
  body: string
  head: string
  base: string
  draft: boolean
  /** Title to use if GitHub rejects draft PRs (plan without draft support for private repos) */
  fallbackTitle: string
}

export interface OpenedPullRequest {
  number: number
  url: string
  draft: boolean
}

export interface GitHubPort {
  /** Short-lived installation token scoped to one repo: read = contents:read; write = contents + pull_requests write */
  token: (githubRepo: string, access: 'read' | 'write') => Promise<string>
  openPullRequest: (args: OpenPullRequestArgs, token: string) => Promise<OpenedPullRequest>
  addLabels: (githubRepo: string, issueNumber: number, labels: string[], token: string) => Promise<void>
}

type OctokitFactory = (token: string) => Pick<Octokit, 'rest'>

const split = (githubRepo: string) => {
  const [owner = '', repo = ''] = githubRepo.split('/')

  return { owner, repo }
}

export class GitHubApp implements GitHubPort {
  private readonly auth: ReturnType<typeof createAppAuth>

  constructor(
    config: { appId: string, installationId: number, privateKey: string },
    private readonly octokit: OctokitFactory = token => new Octokit({ auth: token }),
  ) {
    this.auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey, installationId: config.installationId })
  }

  async token(githubRepo: string, access: 'read' | 'write'): Promise<string> {
    const { token } = await this.auth({
      type: 'installation',
      repositoryNames: [split(githubRepo).repo],
      permissions: access === 'read' ? { contents: 'read' } : { contents: 'write', pull_requests: 'write' },
      refresh: true,
    })

    return token
  }

  async openPullRequest(args: OpenPullRequestArgs, token: string): Promise<OpenedPullRequest> {
    const client = this.octokit(token)
    const create = (title: string, draft: boolean) => client.rest.pulls.create({
      ...split(args.githubRepo),
      title,
      body: args.body,
      head: args.head,
      base: args.base,
      draft,
    })

    try {
      const { data } = await create(args.title, args.draft)

      return { number: data.number, url: data.html_url, draft: args.draft }
    }
    catch (error: any) {
      if (!args.draft || error?.status !== 422 || !/draft/i.test(JSON.stringify(error?.response?.data ?? error?.message)))
        throw error
      const { data } = await create(args.fallbackTitle, false)

      return { number: data.number, url: data.html_url, draft: false }
    }
  }

  async addLabels(githubRepo: string, issueNumber: number, labels: string[], token: string): Promise<void> {
    await this.octokit(token).rest.issues.addLabels({ ...split(githubRepo), issue_number: issueNumber, labels })
  }
}
