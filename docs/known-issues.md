# Known issues

`pi-ez-chat-git` uses the same runtime `VM.create` wrapping strategy as `pi-ez-chat-mount` because upstream `pi-chat` does not expose an extension API for VM options.

Implications:

- The extension must load in the same process as `pi-chat` before the VM starts.
- Changes apply only on the next VM creation; restart the chat sandbox after `/chat-git enable` or `/chat-git disable`.
- Wrapper composition with other `VM.create` wrappers is order-sensitive in theory, but this extension only mutates `opts.vfs`, `opts.env`, `opts.ssh`, and `opts.dns`, then forwards.
- v1 supports SSH-agent based git auth. HTTPS token credential helpers are intentionally deferred to a future integration with `pi-ez-secret-broker`.
