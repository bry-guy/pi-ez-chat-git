import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { formatIdentity, parseIdentity, resolveHostGitIdentity } from "./src/git-identity.js";
import { CONVERSATIONS_JSON_PATH } from "./src/paths.js";
import { loadGitStore, readLastApply, saveGitStore } from "./src/storage.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import type { ConversationGitConfig, GitIdentity } from "./src/types.js";

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

function parseEnableArgs(args: string): { identity?: GitIdentity; noSsh: boolean; sshAgent?: string; allowedHosts: string[] } {
  const tokens = shellTokens(args);
  let identity: GitIdentity | undefined;
  let noSsh = false;
  let sshAgent: string | undefined;
  const allowedHosts: string[] = [];
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
      default:
        throw new Error(`unknown /chat-git enable argument: ${token}`);
    }
  }
  return { identity, noSsh, sshAgent, allowedHosts };
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

export default async function (pi: ExtensionAPI) {
  const wrapper = await tryInstallRuntimeWrapper();

  pi.registerCommand("chat-git", {
    description: "Configure git identity and SSH-agent GitHub auth for the connected pi-chat Gondolin VM",
    handler: async (args, ctx) => {
      try {
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
          };
          await saveGitStore(store);
          notice(ctx, `Enabled pi-ez-chat-git for ${conversationId}. Restart the pi-chat sandbox (for example /chat-new or reconnect) for it to apply.`);
          return;
        }

        if (subcommand === "disable") {
          const conversationId = requireConversationId(ctx);
          const store = await loadGitStore();
          store[conversationId] = { ...(store[conversationId] ?? { enabled: false }), enabled: false };
          await saveGitStore(store);
          notice(ctx, `Disabled pi-ez-chat-git for ${conversationId}. Restart the pi-chat sandbox for it to stop applying.`);
          return;
        }

        if (subcommand === "identity") {
          const conversationId = requireConversationId(ctx);
          const identity = parseIdentity(shellTokens(rest).join(" ") || rest);
          const store = await loadGitStore();
          store[conversationId] = { ...(store[conversationId] ?? { enabled: true }), enabled: true, identity };
          await saveGitStore(store);
          notice(ctx, `Set git identity for ${conversationId}: ${formatIdentity(identity)}. Restart the pi-chat sandbox for it to apply.`);
          return;
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
        }
        const last = await readLastApply();
        if (last && (!conversationId || last.conversationId === conversationId)) {
          lines.push(`\nlast VM apply for ${last.conversationId} at ${last.at}:`);
          lines.push(`  identity: ${last.identity ? formatIdentity(last.identity) : "not applied"}`);
          lines.push(`  gitconfig: ${last.gitconfigGuestPath ?? "not mounted"}`);
          lines.push(`  ssh applied: ${last.sshApplied ? "yes" : "no"}`);
          lines.push(`  allowed hosts: ${last.allowedHosts.join(", ") || "none"}`);
          lines.push(`  known_hosts: ${last.knownHostsFiles.join(", ") || "none"}`);
          lines.push(`  warnings: ${last.warnings.join("; ") || "none"}`);
        }
        notice(ctx, lines.join("\n"));
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
