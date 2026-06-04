# Known issues

`pi-ez-chat-git` uses the same runtime `VM.create` wrapping strategy as
`pi-ez-chat-mount` because upstream `pi-chat` does not expose an extension
API for VM options.

The full description of upstream changes we want — including the exact
ask and source-code receipts — lives in a single rollup:

**[pi-ez-lib/wishlist.md](../../pi-ez-lib/wishlist.md)**

Items relevant to this package:

- §1 — extension API to restart the current conversation sandbox (so
  `/chat-git enable`/`disable` do not have to ask the user to type
  `@bot /new`).
- §2 — extension contributions to `VM.create` options (so this package's
  `VM.create` wrapper can be deleted in favor of structured pi-chat
  config).

## Package-local implications of the current workaround

- The extension must load in the same process as `pi-chat` before the VM
  starts.
- Changes apply only on the next VM creation; restart the chat sandbox
  (via `/new`) after `/chat-git enable` or `/chat-git disable`.
- Wrapper composition with other `VM.create` wrappers is order-sensitive
  in theory, but this extension only mutates `opts.vfs`, `opts.env`,
  `opts.ssh`, and `opts.dns`, then forwards.
- v1 supports SSH-agent based git auth. HTTPS token credential helpers are
  intentionally deferred to a future integration with
  `pi-ez-secret-broker`.
