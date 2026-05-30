import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { formatIdentity, parseIdentity, resolveHostGitIdentity } from "./src/git-identity.js";
import { CONVERSATIONS_JSON_PATH } from "./src/paths.js";
import { loadGitStore, readLastApply, saveGitStore } from "./src/storage.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import { matchSlashCommand } from "./src/match.js";
import type { ConversationGitConfig, GitIdentity } from "./src/types.js";

type CommandResult = { message: string; level?: NotifyLevel; changed?: boolean };

function notice(ctx: { ui: { notify(message: string, level?: NotifyLevel): void } }, message: string, level: NotifyLevel = "info") {
  ctx.ui.notify(message, level);
}

function requireConversationId(ctx: Pick<CommandContext, "sessionManager">): string {
  const id = getPersistedConversationId(ctx);
  if (!id) throw new Error("No pi-chat conversation is connected in this session. Run /chat-connect first.");
  return id;
}

function shellTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("unterminated quote in command arguments");
  if (current) tokens.push(current);
  return tokens;
}

function parseEnableArgs(args: string): { identity?: GitIdentity; noSsh: boolean; sshAgent?: string; allowedHosts: string[]; tcpHosts: Record<string, string> } {
  const tokens = shellTokens(args);
  let identity: GitIdentity | undefined;
  let noSsh = false;
  let sshAgent: string | undefined;
  const allowedHosts: string[] = [];
  const tcpHosts: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case "--identity": {
        const value = tokens[++i];
        if (!value) throw new Error('Usage: /chat-git enable [--identity "Name <email>"] [--no-ssh] [--ssh-agent SOCK] [--allow-host HOST]');
        identity = parseIdentity(value);
        break;
      }
      case "--no-ssh":
        noSsh = true;
        break;
      case "--ssh-agent": {
        const value = tokens[++i];
        if (!value) throw new Error("--ssh-agent requires a socket path");
        sshAgent = value;
        break;
      }
      case "--allow-host": {
        const value = tokens[++i];
        if (!value) throw new Error("--allow-host requires a host");
        allowedHosts.push(value);
        break;
      }
      case "--tcp": {
        const value = tokens[++i];
        if (!value || !value.includes("=")) throw new Error("--tcp requires guest-host[:port]=upstream-host:port");
        const [guest, upstream] = value.split("=", 2);
        if (!guest.trim() || !upstream.trim()) throw new Error("--tcp requires guest-host[:port]=upstream-host:port");
        tcpHosts[guest.trim()] = upstream.trim();
        break;
      }
      default:
        throw new Error(`unknown /chat-git enable argument: ${token}`);
    }
  }
  return { identity, noSsh, sshAgent, allowedHosts, tcpHosts };
}

function splitSubcommand(args: string): { subcommand: string; rest: string } {
  const trimmed = args.trim();
  if (!trimmed) return { subcommand: "status", rest: "" };
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { subcommand: match?.[1] ?? "status", rest: match?.[2] ?? "" };
}

async function defaultIdentityLines(config?: ConversationGitConfig): Promise<string[]> {
  if (config?.identity) return [`identity: ${formatIdentity(config.identity)} (conversation override)`];
  const host = await resolveHostGitIdentity().catch(() => undefined);
  return host ? [`identity: ${formatIdentity(host)} (host ~/.gitconfig)`] : ["identity: not configured"];
}

function reloadHint(changed: boolean): string {
  if (!changed) return "";
  return "\n\nReload required: send @bot /new in the chat channel to recreate the pi-chat sandbox with the updated git config.";
}

async function runChatGit(args: string, ctx: CommandContext, wrapper: Awaited<ReturnType<typeof tryInstallRuntimeWrapper>>): Promise<CommandResult> {
  const { subcommand, rest } = splitSubcommand(args);
  if (subcommand === "enable") {
    const conversationId = requireConversationId(ctx);
    const parsed = parseEnableArgs(rest);
    const store = await loadGitStore();
    const previous = store[conversationId] ?? { enabled: false };
    store[conversationId] = {
      ...previous,
      enabled: true,
      ...(parsed.identity ? { identity: parsed.identity } : {}),
      ssh: {
        ...(previous.ssh ?? {}),
        enabled: !parsed.noSsh,
        ...(parsed.sshAgent ? { agent: parsed.sshAgent } : {}),
        ...(parsed.allowedHosts.length ? { allowedHosts: parsed.allowedHosts } : previous.ssh?.allowedHosts ? { allowedHosts: previous.ssh.allowedHosts } : {}),
      },
      ...(Object.keys(parsed.tcpHosts).length ? { tcp: { hosts: { ...(previous.tcp?.hosts ?? {}), ...parsed.tcpHosts } } } : previous.tcp ? { tcp: previous.tcp } : {}),
    };
    await saveGitStore(store);
    return { changed: true, message: `Enabled pi-ez-chat-git for ${conversationId}.` };
  }

  if (subcommand === "disable") {
    const conversationId = requireConversationId(ctx);
    const store = await loadGitStore();
    store[conversationId] = { ...(store[conversationId] ?? { enabled: false }), enabled: false };
    await saveGitStore(store);
    return { changed: true, message: `Disabled pi-ez-chat-git for ${conversationId}.` };
  }

  if (subcommand === "identity") {
    const conversationId = requireConversationId(ctx);
    const identity = parseIdentity(shellTokens(rest).join(" ") || rest);
    const store = await loadGitStore();
    store[conversationId] = { ...(store[conversationId] ?? { enabled: true }), enabled: true, identity };
    await saveGitStore(store);
    return { changed: true, message: `Set git identity for ${conversationId}: ${formatIdentity(identity)}.` };
  }

  if (subcommand !== "status") throw new Error("Usage: /chat-git [enable|disable|identity|status]");

  const conversationId = getPersistedConversationId(ctx);
  const store = await loadGitStore();
  const ids = conversationId ? [conversationId] : Object.keys(store).sort();
  const lines: string[] = [];
  lines.push(`storage: ${CONVERSATIONS_JSON_PATH}`);
  lines.push(`VM.create wrapper: ${wrapper.error ? `not installed (${wrapper.error})` : wrapper.installed ? "installed" : "already installed"}`);
  if (ids.length === 0) lines.push("no connected pi-chat conversation and no stored chat-git configs");
  for (const id of ids) {
    const config = store[id];
    lines.push(`\n${id}:`);
    if (!config) {
      lines.push("  not configured");
      continue;
    }
    lines.push(`  enabled: ${config.enabled ? "yes" : "no"}`);
    for (const line of await defaultIdentityLines(config)) lines.push(`  ${line}`);
    lines.push(`  ssh: ${config.ssh?.enabled === false ? "disabled" : "enabled"}`);
    lines.push(`  allowed hosts: ${(config.ssh?.allowedHosts ?? ["github.com"]).join(", ")}`);
    lines.push(`  ssh agent: ${config.ssh?.agent ?? process.env.SSH_AUTH_SOCK ?? "not set"}`);
    const tcpHosts = config.tcp?.hosts ?? {};
    if (Object.keys(tcpHosts).length > 0) {
      lines.push("  tcp mappings:");
      for (const [guest, upstream] of Object.entries(tcpHosts).sort(([a], [b]) => a.localeCompare(b))) lines.push(`    ${guest} -> ${upstream}`);
    }
  }
  const last = await readLastApply();
  if (last && (!conversationId || last.conversationId === conversationId)) {
    lines.push(`\nlast VM apply for ${last.conversationId} at ${last.at}:`);
    lines.push(`  identity: ${last.identity ? formatIdentity(last.identity) : "not applied"}`);
    lines.push(`  gitconfig: ${last.gitconfigGuestPath ?? "not mounted"}`);
    lines.push(`  ssh applied: ${last.sshApplied ? "yes" : "no"}`);
    lines.push(`  allowed hosts: ${last.allowedHosts.join(", ") || "none"}`);
    lines.push(`  known_hosts: ${last.knownHostsFiles.join(", ") || "none"}`);
    if (last.tcpHosts && Object.keys(last.tcpHosts).length > 0) {
      lines.push("  tcp mappings:");
      for (const [guest, upstream] of Object.entries(last.tcpHosts).sort(([a], [b]) => a.localeCompare(b))) lines.push(`    ${guest} -> ${upstream}`);
    }
    lines.push(`  warnings: ${last.warnings.join("; ") || "none"}`);
  }
  return { message: lines.join("\n") };
}

function fenced(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "`​``")}\n\`\`\``;
}

export default async function (pi: ExtensionAPI) {
  const wrapper = await tryInstallRuntimeWrapper();

  pi.registerCommand("chat-git", {
    description: "Configure git identity and SSH-agent GitHub auth for the connected pi-chat Gondolin VM",
    handler: async (args, ctx) => {
      try {
        const result = await runChatGit(args, ctx, wrapper);
        notice(ctx, `${result.message}${reloadHint(result.changed ?? false)}`, result.level);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on?.("input", async (event, ctx) => {
    const match = matchSlashCommand(event.text, ["chat-git"]);
    if (!match) return { action: "continue" };
    try {
      const result = await runChatGit(match.args, ctx, wrapper);
      return {
        action: "transform",
        text: `The remote /chat-git command completed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(`${result.message}${reloadHint(result.changed ?? false)}`)}`,
      };
    } catch (error) {
      return {
        action: "transform",
        text: `The remote /chat-git command failed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(error instanceof Error ? error.message : String(error))}`,
      };
    }
  });
}
