# pi-ez-chat-git

`pi-ez-chat-git` wires git identity and SSH-agent GitHub auth into `pi-chat` Gondolin VMs.

It keeps secrets on the host:

- git identity comes from host `~/.gitconfig` or a per-conversation override
- GitHub push auth uses host `SSH_AUTH_SOCK` through Gondolin's SSH egress proxy
- private keys are never copied into the VM

## Install

```sh
pi install /absolute/path/to/pi-ez-chat-git
```

For local testing:

```sh
pi -e /absolute/path/to/pi-ez-chat-git
```

Load this extension in the same pi process as `pi-chat`, before the first chat VM starts.

## Commands

- `/chat-git enable [--identity "Name <email>"] [--no-ssh] [--ssh-agent SOCK] [--allow-host HOST] [--tcp guest-host[:port]=upstream-host:port] [--image IMAGE] [--env KEY=VALUE]`
- `/chat-git disable`
- `/chat-git identity "Name <email>"`
- `/chat-git status`

These commands also work from pi-chat itself, including mention-only channels, for example `@bot /chat-git status`, `/chat-git status @bot`, or `@bot /chat-git enable`. Transcript-shaped forwarded lines such as `- [time] [uid:...] user: <@bot> /chat-git` are also recognized.

After changing config, restart the pi-chat sandbox by sending `@bot /new` in the chat channel so the next `VM.create` picks it up. pi-chat currently handles `/new` before extension input hooks run, so this extension returns a reload hint rather than force-restarting the VM from inside the VM.

## Guest behavior

When enabled, the VM gets a generated git config mounted at `/gondolin-git/gitconfig`, with:

- `GIT_CONFIG_SYSTEM=/gondolin-git/gitconfig`
- `GIT_TERMINAL_PROMPT=0`
- `user.name` / `user.email`
- `url."ssh://git@github.com/".insteadOf = https://github.com/` when SSH-agent auth is available
- `safe.directory = *`

Gondolin SSH egress is configured for `github.com` with host `SSH_AUTH_SOCK` by default. Git commands also get a `GIT_SSH_COMMAND` using `StrictHostKeyChecking=accept-new` and an ephemeral guest known-hosts file, which keeps public GitHub clones and private SSH pushes usable in disposable VMs. Add more SSH hostnames with `--allow-host`; prefer hostnames over IP literals because Gondolin's synthetic DNS needs a hostname to associate the outbound SSH flow with an allowed upstream host.

For non-HTTP/TLS TCP services such as a Proxmox API on `:8006`, add explicit TCP egress mappings with `--tcp`, for example:

```text
/chat-git enable --allow-host brain-7049-pve-sffpc --tcp pve-sffpc:8006=100.112.146.24:8006
```

Then use `https://pve-sffpc:8006/` inside the VM.

For per-conversation custom runtime defaults, set `--image` and non-secret `--env` values, for example:

```text
/chat-git enable --image pi-ez-chat:latest --env SELFHOST_PROXMOX_ENDPOINT=https://pve-sffpc:8006/
```

## Notes

This package assumes the guest image has `git` and `ssh` clients installed. The `pi-ez-chat:latest` Gondolin image in `~/dev/infra/selfhost/images/pi-ez-chat-image` provides those tools.
