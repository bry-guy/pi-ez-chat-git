# pi-ez-chat-git — initial plan

## Decision: separate package, not part of `pi-ez-chat-mount`

`pi-ez-chat-mount` exposes host directories inside the Gondolin VM. That is a filesystem concern.

Git identity and GitHub push auth are a separate concern:

- They are useful even without any extra mounts (e.g., the agent clones a repo into `/workspace`).
- They wire host identity and host-side SSH auth into the VM, not user-selected paths.
- They evolve along a different axis than mounts (more credential helpers, optional `gh`, signing, etc.).

These align with the existing `pi-ez-*` single-purpose pattern (`pi-ez-chat-mount`, `pi-ez-chat-threads`, `pi-ez-chat-handoff`, `pi-ez-secret-broker`, `pi-ez-delegate`, `pi-ez-worktree`, `pi-ez-entire`).

So: **new repo `pi-ez-chat-git`**. `pi-ez-chat-mount` stays minimal and orthogonal.

Loose coupling rule: `pi-ez-chat-git` does not depend on `pi-ez-chat-mount` at the code level. It can read the chat-mount config to be smarter about `safe.directory`, but it must work standalone.

## Scope

`pi-ez-chat-git` is a pi extension that gives the connected pi-chat Gondolin VM a workable git environment:

1. A non-secret git identity (`user.name`, `user.email`).
2. SSH-based GitHub auth that uses the host's `ssh-agent` — the private key never enters the VM.
3. URL rewrite so existing `https://github.com/...` remotes still push.
4. `safe.directory` handling for host-bound repo mounts.
5. Optional `known_hosts` plumbing for upstream verification.

Non-goals for v1:

- HTTPS git credential helper backed by tokens. Possible later via `pi-ez-secret-broker`, but not v1.
- GPG/SSH commit signing.
- Authenticating non-GitHub remotes (GitLab/Bitbucket can be added later by the same mechanism).
- Per-repo identity overrides.
- Cloning on the agent's behalf. The user can `git clone` from inside the VM once auth is wired.

## What `pi-chat` + `pi-ez-chat-git` look like together

After `/chat-git enable` and a sandbox restart, the VM has:

```text
/etc/gitconfig                   # generated, host-bind read-only
  user.name = ...                # from host ~/.gitconfig or override
  user.email = ...
  url."ssh://git@github.com/".insteadOf = https://github.com/
  safe.directory = *
```

Gondolin `VM.create` options also gain:

```ts
ssh: {
  allowedHosts: ["github.com"],
  agent: process.env.SSH_AUTH_SOCK,
  knownHostsFile: [
    "~/.ssh/known_hosts",
    "/etc/ssh/ssh_known_hosts",
  ],
}
dns: {
  mode: "synthetic",
  syntheticHostMapping: "per-host",
}
```

The guest sees standard SSH egress to `github.com`; Gondolin terminates SSH on the host side and proxies it using the host `ssh-agent`. The agent never sees the private key.

Result: `git push origin main` inside the VM works.

## Interface

Commands:

- `/chat-git enable [--identity "Name <email>"] [--no-ssh] [--ssh-agent SOCK] [--allow-host HOST]`
  - opt the current conversation in
  - identity defaults to host `~/.gitconfig` `user.name` / `user.email`
  - `--no-ssh` disables SSH egress wiring (use only identity + `insteadOf` will then be skipped)
  - `--ssh-agent SOCK` overrides `process.env.SSH_AUTH_SOCK`
  - `--allow-host` adds extra SSH-allowed hosts (default: `github.com`)
- `/chat-git disable`
  - opt the current conversation out
- `/chat-git status`
  - show effective per-conversation config, resolved identity, whether `SSH_AUTH_SOCK` is present, last `VM.create` apply summary
- `/chat-git identity "Name <email>"`
  - record per-conversation identity override

All write to `~/.pi/agent/chat-git/conversations.json` and require a VM restart to apply (same UX rule as `pi-ez-chat-mount`).

## On-disk layout

```text
~/.pi/agent/chat-git/
├── conversations.json              # per-conversation enable + overrides
├── debug.log                       # structured wrapper-debug log
├── last-apply.json                 # last VM.create apply state
└── generated/
    └── <conversationId>/
        └── gitconfig               # generated git config, host-bind ro into VM
```

`conversations.json` shape:

```json
{
  "discord-bry-guy/onlyclankers": {
    "enabled": true,
    "identity": { "name": "Bryan Buchanan", "email": "..." },
    "ssh": { "enabled": true, "allowedHosts": ["github.com"] }
  }
}
```

Everything in `conversations.json` is non-secret. Secrets stay on the host:

- `~/.gitconfig` (identity defaults)
- `SSH_AUTH_SOCK` (auth)
- `~/.ssh/known_hosts` (host key verification)

## Implementation: same `VM.create` wrapper pattern as `pi-ez-chat-mount`

Same constraints as documented in `pi-ez-chat-mount/docs/known-issues.md`:

- `pi-chat` does not expose an extension API for `VM.create` options.
- Extensions don't see the `VM` instance.
- Mounts/env/ssh are bound at `VM.create` time.

So `pi-ez-chat-git` installs a runtime wrapper on `@earendil-works/gondolin`'s `VM.create`, identical in shape to the existing `installVmCreateWrapper` in `pi-ez-chat-mount`:

1. Identify conversation id from `opts.sessionLabel` / `opts.vfs.mounts['/workspace']`.
2. Read `conversations.json[conversationId]`.
3. If enabled:
   - Resolve identity (override > host `~/.gitconfig` > error if missing).
   - Generate `generated/<conversationId>/gitconfig`.
   - Add a host-bind read-only mount at `/etc/gitconfig`. (No conflict with `pi-ez-chat-mount`, which uses sibling mounts only.)
   - If SSH enabled and `SSH_AUTH_SOCK` is set:
     - Merge into `opts.ssh.allowedHosts` (dedup, default `github.com`).
     - Set `opts.ssh.agent` to the resolved socket path.
     - Set `opts.ssh.knownHostsFile` to the resolved known_hosts list.
     - Ensure `opts.dns.mode = "synthetic"` and `opts.dns.syntheticHostMapping = "per-host"`, since Gondolin SSH egress requires it (matches Gondolin docs).
   - If SSH is disabled or agent is missing: skip the `insteadOf` rewrite and emit a notice on next `/chat-git status`.
4. Record applied/skipped state in `last-apply.json` and `debug.log`.

The wrapper is idempotent via a `Symbol.for("pi-ez-chat-git.vm-create-wrapped")` marker. It composes with `pi-ez-chat-mount`'s wrapper because each wrapper only mutates `opts` and forwards to the previous function; final order is "outermost wrapper runs first".

## Interaction with `pi-ez-chat-mount`

- `pi-ez-chat-mount` does not touch `/etc/gitconfig`, `opts.ssh`, `opts.dns`, or `opts.env`. No collisions.
- For `safe.directory`, `pi-ez-chat-git` defaults to `safe.directory = *`. Inside an isolated micro-VM this is acceptable, and it removes the cross-package coupling.
- A future enhancement may read `pi-ez-chat-mount`'s config to emit explicit `safe.directory = /infra` entries, but it is not required and is gated behind an opt-in flag.

## Interaction with `pi-ez-secret-broker`

- v1 does not use the broker. SSH-agent forwarding via Gondolin SSH egress already keeps the private key out of the VM.
- A future "HTTPS push via brokered credential helper" mode can plug in by registering a `secret_broker_request_credential` flow and writing a `git credential.helper` shim. That belongs in `pi-ez-chat-git` (the git surface) but reuses the broker for the actual secret. Not in v1.

## Interaction with the Gondolin image (`pi-ez-chat-image`)

- The custom image already bakes in `git`, `mise`, `fnox`, `openssh-client` deps. `pi-ez-chat-git` assumes `git` and `ssh` clients exist in the guest. Document this dependency.
- The image must not bake any personal identity or keys. `pi-ez-chat-git` provides them at VM start per-conversation.

## Behavior when host preconditions are missing

| Condition                             | Behavior                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Conversation not enabled              | No-op.                                                                   |
| No identity available                 | Generate gitconfig with only `safe.directory`. Surface notice.            |
| `SSH_AUTH_SOCK` unset                 | Skip SSH wiring and `insteadOf`. Surface notice.                          |
| `~/.ssh/known_hosts` unreadable       | Drop it from `knownHostsFile`; fall back to `/etc/ssh/ssh_known_hosts`.   |
| Gondolin not importable               | Skip wrapper install; record install error; commands still answer status. |

Never block VM start because of git config issues. Mirrors `pi-ez-chat-mount`'s policy.

## Package layout

Mirror `pi-ez-chat-mount`:

```text
pi-ez-chat-git/
├── LICENSE
├── README.md
├── docs/
│   ├── plan-init.md
│   └── known-issues.md
├── index.ts                  # registers /chat-git commands + tryInstallRuntimeWrapper
├── mise.toml
├── package.json
├── package-lock.json
├── release-please-config.json
├── src/
│   ├── conversation.ts       # cloned/extracted to avoid hard-coupling pi-ez-chat-mount
│   ├── git-identity.ts       # resolve identity from override + host ~/.gitconfig
│   ├── gitconfig.ts          # render gitconfig to disk
│   ├── paths.ts
│   ├── pi-types.ts
│   ├── ssh.ts                # resolve SSH agent + known_hosts
│   ├── storage.ts            # conversations.json, last-apply.json, debug.log
│   ├── types.ts
│   ├── validate.ts
│   └── wrapper.ts            # VM.create wrapper
├── test.ts
└── tsconfig.json
```

`src/conversation.ts` and `src/wrapper.ts` are structurally similar to `pi-ez-chat-mount`'s. Do not import from `pi-ez-chat-mount` at the code level; copy the small helpers. Loose coupling > DRY for these tiny pieces.

If the duplication ever becomes painful, factor a shared `pi-ez-chat-extension-runtime` helper package. Not required for v1.

## Build steps

1. Scaffold the package (mirror `pi-ez-chat-mount` structure, including `mise.toml`, `release-please-config.json`, `LICENSE`, `tsconfig.json`, `index.ts`, `test.ts`).
2. Implement `loadConversationsStore`, `saveConversationsStore`, `writeLastApply`, `appendDebugLine` in `src/storage.ts`.
3. Implement `identifyConversation` in `src/conversation.ts` (same logic as `pi-ez-chat-mount`).
4. Implement `resolveIdentity` in `src/git-identity.ts`:
   - Per-conversation override > parse host `~/.gitconfig` `[user]` section > undefined.
5. Implement `resolveSshAuth` in `src/ssh.ts`:
   - `agent` from override or `process.env.SSH_AUTH_SOCK`
   - `knownHostsFile` from filtered list of host paths
   - `allowedHosts` defaults to `["github.com"]`
6. Implement `renderGitconfig` in `src/gitconfig.ts`:
   - Emit `[user]`, `[url ...]`, `[safe]` sections.
   - Returns the file content; storage layer writes to `generated/<conversationId>/gitconfig`.
7. Implement `installVmCreateWrapper` in `src/wrapper.ts`:
   - Identify conversation id.
   - If enabled, mutate `opts.vfs.mounts['/etc/gitconfig']`, `opts.ssh`, `opts.dns`.
   - Record `last-apply.json`.
8. Implement `/chat-git enable | disable | status | identity` in `index.ts`.
9. Tests for:
   - identity resolution (override + host fallback + missing host config),
   - SSH wiring (with and without `SSH_AUTH_SOCK`),
   - wrapper composition with a stub `VM.create` (proving idempotency and no-op when conversation is disabled),
   - gitconfig rendering golden tests.
10. README + `known-issues.md` mirroring `pi-ez-chat-mount`'s docs and explicitly calling out the `VM.create` wrapping contract.

## Restart UX

Same rule as `pi-ez-chat-mount`: identity/SSH wiring applies only on the next `VM.create`. `/chat-git enable` and `/chat-git disable` print a "restart the pi-chat sandbox (e.g., `/chat-new` or reconnect) for it to apply" notice.

## Verification path

1. `pi install /path/to/pi-ez-chat-git`.
2. `pi -e /path/to/pi-ez-chat-git` (worker) or rely on `pi install` for normal use.
3. `pi-chat` connected to a channel.
4. `/chat-git enable`.
5. `/chat-new` to restart the sandbox.
6. In chat: `git clone https://github.com/<you>/<repo> /workspace/test`, edit, commit, `git push`.
7. Push succeeds via SSH-agent forwarding; private key never appears in the VM.
8. `/chat-git status` shows the last apply: identity + ssh allowed hosts + agent path resolved.

## Future, not in v1

- HTTPS push via `pi-ez-secret-broker` (token-in-credential-helper, host-mediated).
- GPG/SSH commit signing using `ssh-agent` for SSH signing.
- Per-repo identity overrides (e.g., work vs personal email).
- Multi-host SSH (GitLab, Bitbucket).
- A pi-chat-side surface so `/chat-status` reports `pi-ez-chat-git` apply state without us writing into pi-chat-managed files.
- A shared `pi-ez-chat-extension-runtime` helper package if duplication with `pi-ez-chat-mount` becomes meaningful.

## Open questions

- Should `/chat-git enable` opt every new conversation in by default, or stay strictly opt-in per conversation? v1: strictly opt-in.
- Should we generate a per-conversation gitconfig at all, or write a single global `~/.pi/agent/chat-git/gitconfig` and bind it for every enabled conversation? v1: per-conversation, because identity overrides exist and are per-conversation.
- Do we want a `--global-default` mode that pre-enables all conversations? Defer.
