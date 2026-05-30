import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitconfigIdentity, parseIdentity, resolveHostGitIdentity } from "./src/git-identity.js";
import { renderGitconfig } from "./src/gitconfig.js";
import { resolveSshAuth } from "./src/ssh.js";
import { applyGitConfig, installVmCreateWrapper } from "./src/wrapper.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import type { GitStore, VmCreateOptionsLike } from "./src/types.js";

test("matches slash commands after leading bot mentions", () => {
  assert.equal(stripLeadingMention("  @bot /chat-git status"), "/chat-git status");
  assert.deepEqual(matchSlashCommand("<@123> /chat-git enable", ["chat-git"]), { name: "chat-git", args: "enable" });
  assert.deepEqual(matchSlashCommand("/chat-git status <@123>", ["chat-git"]), { name: "chat-git", args: "status" });
  assert.deepEqual(matchSlashCommand("- [2026-05-27T15:01:05.371Z] [uid:235246238382030849] prettybry: <@1496161074997624843> /chat-git", ["chat-git"]), { name: "chat-git", args: "" });
  assert.deepEqual(matchSlashCommand("- [2026-05-27T15:01:05.371Z] [uid:235246238382030849] prettybry: /chat-git status <@1496161074997624843>", ["chat-git"]), { name: "chat-git", args: "status" });
  assert.equal(normalizeRemoteCommandText("- [2026-05-27T15:01:05.371Z] [uid:235246238382030849] prettybry: hello"), "hello");
  assert.equal(matchSlashCommand("@bot hello", ["chat-git"]), undefined);
});

test("parses identity strings", () => {
  assert.deepEqual(parseIdentity("Ada Lovelace <ada@example.com>"), { name: "Ada Lovelace", email: "ada@example.com" });
  assert.throws(() => parseIdentity("Ada"), /identity must look like/);
});

test("parses host gitconfig identity", () => {
  const parsed = parseGitconfigIdentity(`
[user]
  name = Ada Lovelace
  email = ada@example.com
`);
  assert.deepEqual(parsed, { name: "Ada Lovelace", email: "ada@example.com" });
});

test("resolves host git identity through git includes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-git-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  await writeFile(join(dir, ".gitconfig"), "[include]\n\tpath = ~/.gitconfig.identity.local\n", "utf8");
  await writeFile(join(dir, ".gitconfig.identity.local"), "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n", "utf8");
  try {
    const identity = await resolveHostGitIdentity(join(dir, ".gitconfig"));
    assert.deepEqual(identity, { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders generated gitconfig", () => {
  const content = renderGitconfig({ identity: { name: "Ada", email: "ada@example.com" }, enableGithubSshRewrite: true, safeDirectory: "*" });
  assert.match(content, /\[user\]/);
  assert.match(content, /name = Ada/);
  assert.match(content, /\[url "ssh:\/\/git@github.com\/"\]/);
  assert.match(content, /insteadOf = https:\/\/github.com\//);
  assert.match(content, /directory = \*/);
});

test("resolves ssh auth only when agent is available", () => {
  const old = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  assert.equal(resolveSshAuth({}).applied, false);
  process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
  const resolved = resolveSshAuth({ allowedHosts: ["github.com", "github.com"] });
  assert.equal(resolved.applied, true);
  assert.equal(resolved.agent, "/tmp/agent.sock");
  assert.deepEqual(resolved.allowedHosts, ["github.com"]);
  if (old === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = old;
});

test("applyGitConfig mutates VM options for enabled conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-git-"));
  const workspace = join(process.env.HOME!, ".pi/agent/chat/accounts/acct/channels/chan/workspace");
  const opts: VmCreateOptionsLike = { vfs: { mounts: { "/workspace": { rootPath: workspace } } } };
  const store: GitStore = {
    "acct/chan": {
      enabled: true,
      identity: { name: "Ada", email: "ada@example.com" },
      ssh: { agent: "/tmp/agent.sock", allowedHosts: ["github.com"] },
      tcp: { hosts: { "pve:8006": "100.64.0.1:8006" } },
    },
  };
  let last: unknown;
  await applyGitConfig(
    opts,
    (hostPath, readonly) => ({ hostPath, readonly }),
    {
      loadStore: async () => store,
      writeLast: async (state) => {
        last = state;
      },
      writeGitconfig: async (_conversationId, content) => {
        await writeFile(join(dir, "gitconfig"), content);
        return dir;
      },
      debug: async () => undefined,
    },
  );
  assert.deepEqual(opts.vfs?.mounts?.["/gondolin-git"], { hostPath: dir, readonly: true });
  assert.deepEqual(opts.env, { GIT_CONFIG_SYSTEM: "/gondolin-git/gitconfig", GIT_TERMINAL_PROMPT: "0" });
  assert.equal(opts.ssh?.agent, "/tmp/agent.sock");
  assert.deepEqual(opts.ssh?.allowedHosts, ["github.com"]);
  assert.equal(opts.dns?.mode, "synthetic");
  assert.equal(opts.dns?.syntheticHostMapping, "per-host");
  assert.deepEqual(opts.tcp?.hosts, { "pve:8006": "100.64.0.1:8006" });
  assert.match(await readFile(join(dir, "gitconfig"), "utf8"), /insteadOf = https:\/\/github.com\//);
  assert.equal((last as { sshApplied: boolean }).sshApplied, true);
  assert.deepEqual((last as { tcpHosts: Record<string, string> }).tcpHosts, { "pve:8006": "100.64.0.1:8006" });
  await rm(dir, { recursive: true, force: true });
});

test("VM.create wrapper is idempotent and forwards", async () => {
  let called = 0;
  const module: { VM: { create: (options?: VmCreateOptionsLike) => Promise<unknown> }; RealFSProvider: new (rootPath: string) => unknown; ReadonlyProvider: new (inner: unknown) => unknown } = {
    VM: {
      create: async (_options?: VmCreateOptionsLike) => {
        called++;
        return { ok: true };
      },
    },
    RealFSProvider: class {
      rootPath: string;
      constructor(rootPath: string) {
        this.rootPath = rootPath;
      }
    },
    ReadonlyProvider: class {
      inner: unknown;
      constructor(inner: unknown) {
        this.inner = inner;
      }
    },
  };
  assert.equal(installVmCreateWrapper(module), true);
  assert.equal(installVmCreateWrapper(module), false);
  await module.VM.create({});
  assert.equal(called, 1);
});
