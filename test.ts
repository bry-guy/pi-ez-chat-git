import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitconfigIdentity, parseIdentity, resolveHostGitIdentity } from "./src/git-identity.js";
import { renderGitconfig } from "./src/gitconfig.js";
import { GITHUB_APP_HELPER_PATH, extractRepoFromCredentialInput } from "./src/github-app-helper.js";
import { createGitContributor } from "./src/contributor.js";
import { resolveSshAuth } from "./src/ssh.js";
import { matchSlashCommand, normalizeRemoteCommandText, stripLeadingMention } from "./src/match.js";
import type { GitStore } from "./src/types.js";

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


test("renders GitHub App HTTPS gitconfig", () => {
  const content = renderGitconfig({
    identity: { name: "Ada", email: "ada@example.com" },
    enableGithubSshRewrite: false,
    enableGithubHttpsRewrite: true,
    credentialHelper: GITHUB_APP_HELPER_PATH,
    safeDirectory: "*",
  });
  assert.match(content, /insteadOf = ssh:\/\/git@github.com\//);
  assert.match(content, /insteadOf = git@github.com:/);
  assert.match(content, /useHttpPath = true/);
  assert.match(content, /helper = \/gondolin-git\/github-app-helper/);
});

test("GitHub App helper extracts repo from git credential input", () => {
  assert.equal(extractRepoFromCredentialInput("protocol=https\nhost=github.com\npath=bry-guy/pi-ez-chat-workspace.git\n"), "bry-guy/pi-ez-chat-workspace");
  assert.equal(extractRepoFromCredentialInput("protocol=https\nhost=example.com\npath=bry-guy/pi-ez-chat-workspace.git\n"), undefined);
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

test("git contributor returns VM fragment for enabled conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-git-"));
  const store: GitStore = {
    "acct/chan": {
      enabled: true,
      identity: { name: "Ada", email: "ada@example.com" },
      image: "pi-ez-chat:latest",
      env: { SELFHOST_PROXMOX_ENDPOINT: "https://pve:8006/" },
      ssh: { agent: "/tmp/agent.sock", allowedHosts: ["github.com"] },
      tcp: { hosts: { "pve:8006": "100.64.0.1:8006" } },
    },
  };
  let last: unknown;
  class RealFSProvider {
    constructor(public hostPath: string) {}
  }
  class ReadonlyProvider {
    constructor(public provider: unknown) {}
  }
  const contributor = createGitContributor({
    loadStore: async () => store,
    writeLast: async (state) => {
      last = state;
    },
    writeGitAssets: async (_conversationId: string, assets) => {
      await writeFile(join(dir, "gitconfig"), assets.gitconfig);
      if (assets.helperShell) await writeFile(join(dir, "github-app-helper"), assets.helperShell);
      if (assets.helperJs) await writeFile(join(dir, "github-app-helper.js"), assets.helperJs);
      return dir;
    },
    debug: async () => undefined,
  });
  const fragment = (await contributor.contribute({ conversationId: "acct/chan", gondolin: { RealFSProvider, ReadonlyProvider } })) as any;
  assert.deepEqual(fragment?.vfs?.mounts?.["/gondolin-git"], new ReadonlyProvider(new RealFSProvider(dir)));
  assert.equal(fragment?.ssh?.agent, "/tmp/agent.sock");
  assert.deepEqual(fragment?.ssh?.allowedHosts, ["github.com"]);
  assert.equal(fragment?.sandbox?.imagePath, "pi-ez-chat:latest");
  assert.equal(fragment?.dns?.mode, "synthetic");
  assert.equal(fragment?.dns?.syntheticHostMapping, "per-host");
  assert.deepEqual(fragment?.tcp?.hosts, { "pve:8006": "100.64.0.1:8006" });
  assert.deepEqual(fragment?.env, {
    SELFHOST_PROXMOX_ENDPOINT: "https://pve:8006/",
    GIT_CONFIG_SYSTEM: "/gondolin-git/gitconfig",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/pi-ez-chat-known_hosts",
  });
  assert.match(await readFile(join(dir, "gitconfig"), "utf8"), /insteadOf = https:\/\/github.com\//);
  assert.equal((last as { sshApplied: boolean }).sshApplied, true);
  assert.equal((last as { image: string }).image, "pi-ez-chat:latest");
  assert.deepEqual((last as { tcpHosts: Record<string, string> }).tcpHosts, { "pve:8006": "100.64.0.1:8006" });
  await rm(dir, { recursive: true, force: true });
});


test("git contributor configures GitHub App auth without SSH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-git-app-"));
  const store: GitStore = {
    "acct/chan": {
      enabled: true,
      identity: { name: "Ada", email: "ada@example.com" },
      auth: { type: "github-app", repos: ["bry-guy/pi-ez-chat-workspace"] },
    },
  };
  class RealFSProvider { constructor(public hostPath: string) {} }
  class ReadonlyProvider { constructor(public provider: unknown) {} }
  const contributor = createGitContributor({
    loadStore: async () => store,
    writeLast: async () => undefined,
    writeGitAssets: async (_conversationId: string, assets) => {
      await writeFile(join(dir, "gitconfig"), assets.gitconfig);
      if (assets.helperShell) await writeFile(join(dir, "github-app-helper"), assets.helperShell);
      if (assets.helperJs) await writeFile(join(dir, "github-app-helper.js"), assets.helperJs);
      return dir;
    },
    debug: async () => undefined,
  });
  const fragment = (await contributor.contribute({ conversationId: "acct/chan", gondolin: { RealFSProvider, ReadonlyProvider } })) as any;
  assert.equal(fragment?.ssh, undefined);
  assert.equal(fragment?.env?.GIT_SSH_COMMAND, undefined);
  assert.match(await readFile(join(dir, "gitconfig"), "utf8"), /helper = \/gondolin-git\/github-app-helper/);
  assert.match(await readFile(join(dir, "github-app-helper.js"), "utf8"), /github-app-token/);
  await rm(dir, { recursive: true, force: true });
});
