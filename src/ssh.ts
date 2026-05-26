import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SshResolution = {
  enabled: boolean;
  applied: boolean;
  agent?: string;
  allowedHosts: string[];
  knownHostsFiles: string[];
  warnings: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim()).map((v) => v.trim()))];
}

export function defaultKnownHostsFiles(): string[] {
  return [join(homedir(), ".ssh", "known_hosts"), "/etc/ssh/ssh_known_hosts"].filter((p) => existsSync(p));
}

export function resolveSshAuth(config?: { enabled?: boolean; agent?: string; allowedHosts?: string[]; knownHostsFiles?: string[] }): SshResolution {
  const enabled = config?.enabled !== false;
  const allowedHosts = unique(config?.allowedHosts?.length ? config.allowedHosts : ["github.com"]);
  const warnings: string[] = [];
  if (!enabled) return { enabled: false, applied: false, allowedHosts, knownHostsFiles: [], warnings };
  const agent = config?.agent || process.env.SSH_AUTH_SOCK;
  if (!agent) {
    warnings.push("SSH_AUTH_SOCK is not set; SSH git push auth was not wired into the VM.");
    return { enabled: true, applied: false, allowedHosts, knownHostsFiles: [], warnings };
  }
  const knownHostsFiles = unique(config?.knownHostsFiles?.length ? config.knownHostsFiles.filter(existsSync) : defaultKnownHostsFiles());
  if (knownHostsFiles.length === 0) warnings.push("No known_hosts files found; Gondolin may reject SSH upstream host verification.");
  return { enabled: true, applied: true, agent, allowedHosts, knownHostsFiles, warnings };
}
