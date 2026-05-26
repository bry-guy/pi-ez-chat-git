export type GitIdentity = {
  name: string;
  email: string;
};

export type ConversationGitConfig = {
  enabled: boolean;
  identity?: GitIdentity;
  ssh?: {
    enabled?: boolean;
    agent?: string;
    allowedHosts?: string[];
    knownHostsFiles?: string[];
  };
};

export type GitStore = Record<string, ConversationGitConfig>;

export type AppliedGitState = {
  conversationId: string;
  enabled: boolean;
  identity?: GitIdentity;
  gitconfigGuestPath?: string;
  sshEnabled: boolean;
  sshApplied: boolean;
  allowedHosts: string[];
  agent?: string;
  knownHostsFiles: string[];
  warnings: string[];
  at: string;
};

export type EnvInput = string[] | Record<string, string>;

export type VmCreateOptionsLike = {
  sessionLabel?: string;
  env?: EnvInput;
  dns?: {
    mode?: string;
    trustedServers?: string[];
    syntheticHostMapping?: string;
  };
  ssh?: {
    allowedHosts?: string[];
    agent?: string;
    knownHostsFile?: string | string[];
    credentials?: unknown;
  };
  vfs?: null | {
    mounts?: Record<string, unknown>;
  };
};

export type ProviderFactory = (hostPath: string, readonly: boolean) => unknown;
