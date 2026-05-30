import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { identifyConversation } from "./conversation.js";
import { renderGitconfig } from "./gitconfig.js";
import { resolveIdentity } from "./git-identity.js";
import { GUEST_GITCONFIG_DIR, GUEST_GITCONFIG_PATH } from "./paths.js";
import { resolveSshAuth } from "./ssh.js";
import { appendDebugLine, loadGitStore, writeGeneratedGitconfig, writeLastApply } from "./storage.js";
import type { EnvInput, ProviderFactory, VmCreateOptionsLike } from "./types.js";

type VmModuleLike = {
  VM: { create: (options?: VmCreateOptionsLike) => Promise<unknown> };
  RealFSProvider?: new (hostPath: string) => unknown;
  ReadonlyProvider?: new (provider: unknown) => unknown;
};

const WRAPPED = Symbol.for("pi-ez-chat-git.vm-create-wrapped");
const ORIGINAL = Symbol.for("pi-ez-chat-git.vm-create-original");

type WrappedCreate = ((options?: VmCreateOptionsLike) => Promise<unknown>) & {
  [WRAPPED]?: true;
  [ORIGINAL]?: (options?: VmCreateOptionsLike) => Promise<unknown>;
};

export function defaultProviderFactory(module: VmModuleLike): ProviderFactory {
  return (hostPath: string, readonly: boolean): unknown => {
    if (!module.RealFSProvider) throw new Error("@earendil-works/gondolin RealFSProvider is unavailable");
    const provider = new module.RealFSProvider(hostPath);
    if (readonly) {
      if (!module.ReadonlyProvider) throw new Error("@earendil-works/gondolin ReadonlyProvider is unavailable");
      return new module.ReadonlyProvider(provider);
    }
    return provider;
  };
}

function mergeEnv(existing: EnvInput | undefined, additions: Record<string, string>): EnvInput {
  if (Array.isArray(existing)) {
    const filtered = existing.filter((entry) => !Object.keys(additions).some((key) => entry.startsWith(`${key}=`)));
    return [...filtered, ...Object.entries(additions).map(([key, value]) => `${key}=${value}`)];
  }
  return { ...(existing ?? {}), ...additions };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergeKnownHosts(existing: string | string[] | undefined, additions: string[]): string[] | undefined {
  const current = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const merged = unique([...current, ...additions]);
  return merged.length ? merged : undefined;
}

export function installVmCreateWrapper(module: VmModuleLike, providerFactory = defaultProviderFactory(module)): boolean {
  const current = module.VM.create as WrappedCreate;
  if (current[WRAPPED]) return false;
  const original = current.bind(module.VM) as (options?: VmCreateOptionsLike) => Promise<unknown>;
  const wrapped = (async (options?: VmCreateOptionsLike) => {
    const opts = options ?? {};
    try {
      await applyGitConfig(opts, providerFactory);
    } catch (error) {
      await appendDebugLine(`[wrapper-error] ${error instanceof Error ? error.stack || error.message : String(error)}`).catch(() => undefined);
    }
    return original(opts);
  }) as WrappedCreate;
  wrapped[WRAPPED] = true;
  wrapped[ORIGINAL] = original;
  module.VM.create = wrapped;
  return true;
}

export async function applyGitConfig(
  opts: VmCreateOptionsLike,
  providerFactory: ProviderFactory,
  deps: { loadStore?: typeof loadGitStore; writeLast?: typeof writeLastApply; writeGitconfig?: typeof writeGeneratedGitconfig; debug?: typeof appendDebugLine } = {},
): Promise<void> {
  const conversationId = identifyConversation(opts);
  if (!conversationId) return;

  const loadStore = deps.loadStore ?? loadGitStore;
  const writeLast = deps.writeLast ?? writeLastApply;
  const writeGitconfig = deps.writeGitconfig ?? writeGeneratedGitconfig;
  const debug = deps.debug ?? appendDebugLine;
  const config = (await loadStore())[conversationId];
  if (!config?.enabled) return;

  const warnings: string[] = [];
  const identity = await resolveIdentity(config.identity);
  if (!identity) warnings.push("No git identity configured and no host ~/.gitconfig user.name/user.email found.");

  const ssh = resolveSshAuth(config.ssh);
  warnings.push(...ssh.warnings);
  const gitconfig = renderGitconfig({ identity, enableGithubSshRewrite: ssh.applied, safeDirectory: "*" });
  const generatedHostDir = await writeGitconfig(conversationId, gitconfig);

  if (!opts.vfs) opts.vfs = { mounts: {} };
  if (!opts.vfs.mounts) opts.vfs.mounts = {};
  if (opts.vfs.mounts[GUEST_GITCONFIG_DIR]) {
    warnings.push(`${GUEST_GITCONFIG_DIR} already exists in VM mounts; git config mount was skipped.`);
  } else {
    opts.vfs.mounts[GUEST_GITCONFIG_DIR] = providerFactory(generatedHostDir, true);
    opts.env = mergeEnv(opts.env, {
      GIT_CONFIG_SYSTEM: GUEST_GITCONFIG_PATH,
      GIT_TERMINAL_PROMPT: "0",
    });
  }

  const tcpHosts = config.tcp?.hosts && Object.keys(config.tcp.hosts).length > 0 ? config.tcp.hosts : undefined;
  if (tcpHosts) {
    opts.tcp = {
      ...(opts.tcp ?? {}),
      hosts: { ...(opts.tcp?.hosts ?? {}), ...tcpHosts },
    };
    opts.dns = {
      ...(opts.dns ?? {}),
      mode: "synthetic",
      syntheticHostMapping: "per-host",
    };
  }

  if (ssh.applied) {
    opts.ssh = {
      ...(opts.ssh ?? {}),
      allowedHosts: unique([...(opts.ssh?.allowedHosts ?? []), ...ssh.allowedHosts]),
      agent: ssh.agent,
      knownHostsFile: mergeKnownHosts(opts.ssh?.knownHostsFile, ssh.knownHostsFiles),
    };
    opts.dns = {
      ...(opts.dns ?? {}),
      mode: "synthetic",
      syntheticHostMapping: "per-host",
    };
  }

  await writeLast({
    conversationId,
    enabled: true,
    identity,
    gitconfigGuestPath: GUEST_GITCONFIG_PATH,
    sshEnabled: ssh.enabled,
    sshApplied: ssh.applied,
    allowedHosts: ssh.allowedHosts,
    agent: ssh.agent,
    knownHostsFiles: ssh.knownHostsFiles,
    tcpHosts,
    warnings,
    at: new Date().toISOString(),
  }).catch(() => undefined);
  await debug(`[apply] conversation=${conversationId} identity=${identity ? "yes" : "no"} ssh=${ssh.applied ? "yes" : "no"} warnings=${warnings.length}`).catch(
    () => undefined,
  );
}

async function importGondolin(): Promise<VmModuleLike> {
  try {
    return (await import("@earendil-works/gondolin")) as VmModuleLike;
  } catch (bareError) {
    const fallback = join(
      homedir(),
      ".pi",
      "agent",
      "git",
      "github.com",
      "earendil-works",
      "pi-chat",
      "node_modules",
      "@earendil-works",
      "gondolin",
      "dist",
      "src",
      "index.js",
    );
    if (existsSync(fallback)) return (await import(pathToFileURL(fallback).href)) as VmModuleLike;
    throw bareError;
  }
}

export async function tryInstallRuntimeWrapper(): Promise<{ installed: boolean; error?: string }> {
  try {
    const module = await importGondolin();
    return { installed: installVmCreateWrapper(module) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendDebugLine(`[install-error] ${message}`).catch(() => undefined);
    return { installed: false, error: message };
  }
}
