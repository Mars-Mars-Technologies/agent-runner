# agent-runner

Runs **agent tasks** submitted in the HMS web app (Developer Tools → Agent Tasks). Each task runs Claude (Claude Agent SDK)
inside a fresh Docker container against `hms-api` or `hms-fe`, and ends with a GitHub pull request for human review.

```
hms-fe ──create task──▶ hms-api (agent_tasks, source of truth)
                           ▲   │ claim / logs+heartbeat / result        (shared runner token)
                           │   ▼
                        agent-runner (this service, systemd, on the Linux host)
                           │ 1. clone base branch (read-only GitHub App token) into /var/lib/agent-runner/work/task-*
                           │ 2. docker run hms-agent-job ──▶ composer install / npm ci → Claude Agent SDK → git commit
                           │                                → git bundle + final check (base-branch check script)
                           │ 3. inspect bundle in a fresh bare repo, push branch (write token), open PR via GitHub API
                           └ 4. report status / PR / summary / cost to hms-api; delete container + workdir
```

## Security model

- **The agent has no GitHub credentials.** The runner clones before the container starts. Tokens are passed to git as
  `http.extraheader` through environment config, never in URLs, argv or `.git/config`. The runner pushes from a bare repo it
  creates itself and fills from the job's `git bundle`. It never runs git in the agent-modified checkout, which protects the
  host from hostile `core.hooksPath`, `core.fsmonitor` and similar settings.
- **Guardrails come from the base branch.** `.claude/`, `.githooks/` and `scripts/check.(php|mjs)` are copied from the base
  branch and mounted **read-only** over the checkout. The agent's hooks, its Stop gate and the final check therefore always
  run the reviewed versions. If the agent's commits still touch `.claude/`, `.githooks/`, `.github/`, `scripts/check.*`, or
  the `scripts` section of `composer.json`/`package.json`, the PR gets a **"⚠️ Guardrail files changed"** section and the
  label **`touches-guardrails`**.
- **Container:** non-root (`--user` = the runner's uid), `--cap-drop ALL`, `no-new-privileges`, and memory, CPU and pid limits.
  The only mount is the task's temp workdir. Each task gets a fresh container. The container and workdir are always
  deleted afterwards, also on errors, timeout, cancellation and runner restart.
- **The agent runs in `bypassPermissions` mode inside the container.** The project's deny rules and hooks
  (`.claude/settings.json`) still apply. WebFetch and WebSearch are disabled. Limits: `MAX_TURNS`, `MAX_BUDGET_USD` and
  `TASK_TIMEOUT_MIN`.
- **Logs** sent to hms-api are truncated and redacted: configured secrets, `sk-ant-…`, `gh*_…`, `github_pat_…`, private
  keys, auth headers, and `*KEY|TOKEN|SECRET|PASSWORD=` values.

> ⚠️ **Membership in the `docker` group is root-equivalent.** Anyone (or anything) running as `agent-runner` can start a
> privileged container and own the host. Use a dedicated server or VM for the runner, give `agent-runner` no other access,
> and keep its env file readable only by root and that user.

> ⚠️ **The GitHub App must not be on any branch-protection or ruleset bypass list** (for `main` or anything else). Its PRs
> must go through the same required reviews and checks as everyone else's. The App never needs to push to `main`.

**MVP limitations (accepted for now):**
- The container has normal outbound network access. It needs package registries and the Claude API.
- `ANTHROPIC_API_KEY` is visible inside the container. Use a **dedicated key in its own Anthropic workspace with a spend
  limit**. Possible phase-2 hardening: an egress allowlist proxy, and a credential-injecting proxy via `ANTHROPIC_BASE_URL`.
- CI on the PR is the real gate. The in-container check is a fast first signal.

## 1. GitHub App

Create the App at *GitHub → Organization settings → Developer settings → GitHub Apps → New GitHub App*:

- **Webhook:** off (uncheck *Active*).
- **Repository permissions:** **Contents: Read and write**, **Pull requests: Read and write**. Leave everything else at *No
  access*. *Metadata: Read* is added automatically and is mandatory. Do **not** grant *Workflows*: without it, GitHub rejects
  any push that changes `.github/workflows/`, so the agent can't alter CI.
- **Install** the App on `hms-api` and `hms-fe` only ("Only select repositories").
- Note the **App ID** (the App's settings page) and the **Installation ID** (the number at the end of the installation's
  settings URL). Generate a **private key** (.pem).
- Make sure the App is **not** a bypass actor in any branch protection rule or ruleset.

Recommended branch protection on `main` in both repos: require a PR, require 1 approval, block force pushes, and require
these checks: `lint (pint + php -l, changed files)` and `test (phpunit)` for hms-api; `lint (eslint, changed files)` and
`build (vite)` for hms-fe.

## 2. hms-api

```bash
php artisan migrate
php artisan db:seed --class=RolePermissionSeeder   # adds agent_tasks.* permissions (jarvis gets them)
# .env
AGENT_RUNNER_TOKEN=<long random string, e.g. php -r "echo bin2hex(random_bytes(32));">
```

Jarvis users who are already logged in must log out and back in to see **Developer Tools**.

The task's **base branch must contain the agent setup** (`CLAUDE.md`, `.claude/`, `scripts/check.*`). Until the
`chore/claude-agent-setup` branches are merged into `main`, a task based on `main` runs without project hooks, and its
final check is reported as "not run", so the PR is opened as a draft.

## 3. Server setup

These steps are for the target server: **Ubuntu, 1 GB RAM + 4 GB swap, Docker, Node 22 and git already installed, an
existing non-root user `agent-runner` in the `docker` group, and ufw enabled with no published ports.** Run them as an
admin with sudo. Only the `docker build` and `npm` steps run as `agent-runner`.

```bash
# 0. Check prerequisites
node -v                                          # v22.x
id agent-runner                                  # groups must include docker (root-equivalent, see warning above)
docker info --format '{{.CgroupVersion}}'        # 2
docker info 2>&1 | grep -i 'swap limit'          # must print NOTHING; otherwise --memory-swap is ignored
swapon --show                                    # the 4 GB swap is active
sudo ufw status verbose                          # active. No rule needed: the runner only makes outbound
                                                 # HTTPS connections, and the job containers publish no ports.

# 1. Directories
sudo install -d -o agent-runner -g agent-runner -m 750 /opt/agent-runner
sudo install -d -o agent-runner -g agent-runner -m 700 /var/lib/agent-runner /var/lib/agent-runner/work
sudo install -d -o root -g agent-runner -m 750 /etc/agent-runner

# 2. Code and build (as agent-runner)
sudo -u agent-runner git clone <agent-runner remote> /opt/agent-runner
cd /opt/agent-runner
sudo -u agent-runner npm ci
sudo -u agent-runner npm run build
sudo -u agent-runner npm prune --omit=dev

# 3. Job image, built with agent-runner's uid/gid so the mounted workdir is writable inside the container.
#    Takes several minutes on 1 CPU (it compiles the gd extension); the image is about 1.5 GB.
sudo -u agent-runner docker build -t hms-agent-job:latest \
  --build-arg AGENT_UID="$(id -u agent-runner)" --build-arg AGENT_GID="$(id -g agent-runner)" job

# 4. Configuration and GitHub App key: readable by root and agent-runner only
sudo install -o root -g agent-runner -m 640 .env.example /etc/agent-runner/agent-runner.env
sudo install -o root -g agent-runner -m 640 /path/to/github-app.pem /etc/agent-runner/github-app.pem
sudo nano /etc/agent-runner/agent-runner.env     # fill in the required values (section 4)

# 5. Optional smoke test in the foreground (Ctrl+C stops it cleanly)
sudo -u agent-runner node --env-file=/etc/agent-runner/agent-runner.env dist/index.js

# 6. systemd service
sudo cp deploy/agent-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-runner
journalctl -u agent-runner -f
```

**ufw and Docker:** Docker manages its own iptables rules. Published container ports would bypass ufw, but this setup
publishes none. If ufw's *outgoing* policy is `deny` (the default is `allow`), allow outbound 443, 80 and 53. Containers
need them for GitHub, Packagist, npm and the Claude API.

**Sizing for 1 GB RAM:** keep `MAX_CONCURRENT=1`. Each job container gets `CONTAINER_MEMORY=900m` of RAM and
`CONTAINER_MEMORY_SWAP=3g` RAM + swap in total. `composer install`, the PHPUnit suite and especially the hms-fe Vite build
will page into swap, so tasks are slow but complete. If hms-fe tasks hit the 30-minute timeout, raise `TASK_TIMEOUT_MIN`.
On a bigger host, raise the memory limits instead.

## 4. Configuration (`/etc/agent-runner/agent-runner.env`)

| Variable | Default | Meaning |
|---|---|---|
| `HMS_API_URL` | required | API base URL **including `/api`** |
| `RUNNER_TOKEN` | required | Same value as `AGENT_RUNNER_TOKEN` in hms-api |
| `RUNNER_ID` | `runner-1` | Unique per runner; used to recover its own orphaned tasks |
| `HMS_FE_URL` | required | Frontend URL for the "view task" link in PR bodies |
| `ANTHROPIC_API_KEY` | required | Dedicated key with a spend limit |
| `AGENT_MODEL` | SDK default | Optional model override |
| `MAX_CONCURRENT` | `1` | Tasks (containers) in parallel; keep 1 on a 1 GB server |
| `MAX_TURNS` | `60` | Agent turn limit per task |
| `MAX_BUDGET_USD` | `3` | Claude spend limit per task |
| `TASK_TIMEOUT_MIN` | `30` | Wall-clock limit per task (install + agent + final check) |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | required | GitHub App |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `HMS Agent` / `marsandmarstechnologies@gmail.com` | Author **and** committer of every agent commit |
| `CONTAINER_MEMORY` | `900m` | Job container RAM (`docker --memory`) |
| `CONTAINER_MEMORY_SWAP` | `3g` | Job container RAM + swap total (`docker --memory-swap`) |
| `CONTAINER_CPUS` | `1` | Job container CPUs (`docker --cpus`) |
| `POLL_INTERVAL_SEC` | `10` | Queue polling interval |
| `WORK_DIR` | `/var/lib/agent-runner/work` | Temp workdirs (`task-*`, deleted after each task) |
| `JOB_IMAGE` | `hms-agent-job:latest` | Image built from `job/` |

Every job container also gets `--pids-limit 2048`, `--cap-drop ALL`, `--security-opt no-new-privileges` and
`--user <agent-runner uid>`. These are fixed in `src/docker.ts`, not configurable.


## 5. Operating

```bash
journalctl -u agent-runner -f                                   # runner log (claims, outcomes, errors)
docker ps --filter label=agent-runner                           # running job containers
docker logs -f <container>                                      # raw JSON-lines output of a running job
systemctl restart agent-runner                                  # running tasks are reported failed and cleaned up
```

The per-task log (agent messages, tool calls, results) is on the task's page in the web app.

- **Cancel:** the Cancel button in the web app. The runner sees it within ~2–5 s (log heartbeat), kills the container,
  and pushes nothing.
- **Restart or crash:** on startup the runner removes its leftover containers and workdirs, and marks its `running` tasks
  `failed` via `/runner/agent-tasks/recover`.
- **Claude API errors:** `rate_limit` and `overloaded` fail the task with a "resubmit later" message.
  `authentication_failed` and `billing_error` fail it **and pause claiming for 15 minutes**.
- **Upgrading the SDK:** bump `@anthropic-ai/claude-agent-sdk` in `job/package.json`, run
  `cd job && npm install --package-lock-only`, rebuild the image, then restart.

## 6. First end-to-end dry run

1. Complete sections 1–4. Make sure the base branch has the agent setup (merge or use `chore/claude-agent-setup`).
2. Start the runner and watch `journalctl -u agent-runner -f`. You should see `recovered 0 orphaned running task(s)` and
   `started: …`.
3. In the web app: **Developer Tools → New Agent Task**. Choose repo `hms-api`, base branch `chore/claude-agent-setup`,
   title `Dry run: README comment`, description *"Add an HTML comment `<!-- agent dry run -->` as the first line of
   README.md. Do not change anything else."*
4. Expected on the task page within a few minutes:
   - Status goes Queued → Running.
   - The log shows clone, `composer install`, `Session started: … skills: add-api-module, …`, tool calls, `git commit`,
     and `Final check passed`.
   - It ends with **PR opened** and a link.
5. On GitHub, the PR should come from `claude/task-<id>-dry-run-readme-comment`, authored by
   `HMS Agent <marsandmarstechnologies@gmail.com>`, with the task, summary and checks in the body and no guardrail label.
   CI runs on it. **Close the PR and delete the branch** afterwards.
6. Also try **Cancel** on a second task while it is running. The status becomes Cancelled, `docker ps` no longer shows the
   container, and no branch is pushed.

## Development

```bash
npm ci
npm test            # vitest: redaction, formatting, guardrails, PR body, API client, runTask orchestration, real-git tests
npm run typecheck
npm run build
```

Layout: `src/index.ts` (loop, recovery, shutdown) · `src/runTask.ts` (one task end to end) · `src/git.ts` (host-side git) ·
`src/docker.ts` · `src/github.ts` (App tokens, PRs, labels) · `src/api.ts` (hms-api client) · `src/logs.ts`,
`src/format.ts`, `src/redact.ts` · `job/` (image + in-container `run-job.mjs`).
