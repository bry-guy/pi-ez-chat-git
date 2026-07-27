import { GITHUB_APP_HELPER_PATH, githubAppHelperJsSource, githubAppHelperShellSource } from "./github-app-helper.js";
import { renderGitconfig } from "./gitconfig.js";
import { resolveIdentity } from "./git-identity.js";
import { GUEST_GITCONFIG_DIR, GUEST_GITCONFIG_PATH } from "./paths.js";
import { resolveSshAuth, type SshResolution } from "./ssh.js";
import { appendDebugLine, loadGitStore, writeGeneratedGitAssets, writeLastApply } from "./storage.js";

export const CHAT_GIT_CONFIG_API_KEY = Symbol.for("pi-ez-chat-git.config.v1");
export const SECRET_BROKER_API_KEY = Symbol.for("pi-ez-secret-broker.api.v1");

type GondolinLike = {
  RealFSProvider: new (hostPath: string) => unknown;
  ReadonlyProvider: new (provider: unknown) => unknown;
};

type ContributorContext = {
  conversationId: string;
  gondolin: GondolinLike;
};

type ContributorDeps = {
  loadStore?: typeof loadGitStore;
  writeLast?: typeof writeLastApply;
  writeGitAssets?: typeof writeGeneratedGitAssets;
  debug?: typeof appendDebugLine;
};

export function secretBrokerApi(): { upsertGithubAppPolicy(conversationId: string, repos: string[]): Promise<unknown> } | undefined {
  return (globalThis as Record<symbol, unknown>)[SECRET_BROKER_API_KEY] as { upsertGithubAppPolicy(conversationId: string, repos: string[]): Promise<unknown> } | undefined;
}

export function createGitContributor(deps: ContributorDeps = {}) {
  return {
    name: "pi-ez-chat-git",
    contribute: async (ctx: ContributorContext) => {
      const loadStore = deps.loadStore ?? loadGitStore;
      const writeLast = deps.writeLast ?? writeLastApply;
      const writeGitAssets = deps.writeGitAssets ?? writeGeneratedGitAssets;
      const debug = deps.debug ?? appendDebugLine;
      const config = (await loadStore())[ctx.conversationId];
      if (!config?.enabled) return undefined;

      const warnings: string[] = [];
      const fragment: Record<string, unknown> = {};
      const authType = config.auth?.type ?? "ssh-agent";

      if (config.image?.trim()) fragment.sandbox = { imagePath: config.image.trim() };

      const identity = await resolveIdentity(config.identity);
      if (!identity) warnings.push("No git identity configured and no host ~/.gitconfig user.name/user.email found.");

      let ssh: SshResolution = { enabled: false, applied: false, allowedHosts: [], knownHostsFiles: [], warnings: [] };
      let generatedHostDir: string;
      if (authType === "github-app") {
        const repos = config.auth?.type === "github-app" ? config.auth.repos : [];
        const gitconfig = renderGitconfig({
          identity,
          enableGithubSshRewrite: false,
          enableGithubHttpsRewrite: true,
          credentialHelper: GITHUB_APP_HELPER_PATH,
          safeDirectory: "*",
        });
        generatedHostDir = await writeGitAssets(ctx.conversationId, {
          gitconfig,
          helperShell: githubAppHelperShellSource(),
          helperJs: githubAppHelperJsSource(),
        });
        warnings.push(...(repos.length === 0 ? ["GitHub App auth is enabled but no repos are configured."] : []));
      } else {
        ssh = resolveSshAuth(config.ssh);
        warnings.push(...ssh.warnings);
        const gitconfig = renderGitconfig({ identity, enableGithubSshRewrite: ssh.applied, safeDirectory: "*" });
        generatedHostDir = await writeGitAssets(ctx.conversationId, { gitconfig });
      }

      fragment.vfs = {
        mounts: {
          [GUEST_GITCONFIG_DIR]: new ctx.gondolin.ReadonlyProvider(new ctx.gondolin.RealFSProvider(generatedHostDir)),
        },
      };

      fragment.env = {
        ...(config.env ?? {}),
        GIT_CONFIG_SYSTEM: GUEST_GITCONFIG_PATH,
        GIT_TERMINAL_PROMPT: "0",
        ...(ssh.applied ? { GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/pi-ez-chat-known_hosts" } : {}),
      };

      const tcpHosts = config.tcp?.hosts && Object.keys(config.tcp.hosts).length > 0 ? config.tcp.hosts : undefined;
      if (tcpHosts) {
        fragment.tcp = { hosts: tcpHosts };
        fragment.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
      }

      if (ssh.applied) {
        fragment.ssh = {
          allowedHosts: ssh.allowedHosts,
          agent: ssh.agent,
          knownHostsFile: ssh.knownHostsFiles,
        };
        fragment.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
      }

      await writeLast({
        conversationId: ctx.conversationId,
        enabled: true,
        identity,
        gitconfigGuestPath: GUEST_GITCONFIG_PATH,
        image: config.image,
        env: config.env,
        authType,
        githubAppRepos: config.auth?.type === "github-app" ? config.auth.repos : undefined,
        sshEnabled: ssh.enabled,
        sshApplied: ssh.applied,
        allowedHosts: ssh.allowedHosts,
        agent: ssh.agent,
        knownHostsFiles: ssh.knownHostsFiles,
        tcpHosts,
        warnings,
        at: new Date().toISOString(),
      }).catch(() => undefined);
      await debug(`[apply] conversation=${ctx.conversationId} image=${config.image ?? "default"} identity=${identity ? "yes" : "no"} auth=${authType} ssh=${ssh.applied ? "yes" : "no"} warnings=${warnings.length}`).catch(
        () => undefined,
      );
      return fragment;
    },
  };
}
