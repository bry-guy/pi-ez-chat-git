# pi-ez-chat-git

## What it does

Wires per-conversation git identity and SSH-agent based git auth into the pi-chat Gondolin VM.

## Why it exists

Agents in a chat should commit and push as the right author, and reach git hosts without copying keys into the sandbox.

## How to use it

New to pi-ez-chat? Start with the [user guide](https://github.com/bry-guy/pi-ez-chat-workspace/blob/main/docs/user-guide.md).

Install:

```text
pi install git:github.com/bry-guy/pi-ez-chat-git
```

Connect a pi-chat conversation first with `/chat-connect`, then use these commands.

- `/chat-git enable` turns on git identity, SSH-agent auth, and the generated gitconfig for the connected conversation. Pass `--identity` to override the host identity for this conversation.

  ```text
  /chat-git enable
  /chat-git enable --identity "Ada Lovelace <ada@example.com>"
  ```

- `/chat-git identity` sets only the identity without changing other settings.

  ```text
  /chat-git identity "Ada Lovelace <ada@example.com>"
  ```

- `/chat-git status` shows the stored config and the last apply for the connected conversation.

  ```text
  /chat-git status
  ```

After changing config, restart the chat sandbox with `/new` so the next VM picks it up.

## Notes

- Identity defaults to your host `~/.gitconfig` unless you override it.
- GitHub push auth uses your host `SSH_AUTH_SOCK` through the Gondolin SSH proxy. Private keys stay on the host.
- Additional SSH hosts and TCP egress can be added with `--allow-host` and `--tcp` on `enable`. See `/chat-git enable --help` style usage in the source for the full flag set.
- This package assumes the guest image has `git` and `ssh` clients installed.
