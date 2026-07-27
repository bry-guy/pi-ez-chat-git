import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHAT_GIT_DIR, CONVERSATIONS_JSON_PATH, DEBUG_LOG_PATH, GENERATED_DIR, LAST_APPLY_JSON_PATH } from "./paths.js";
import type { AppliedGitState, GitStore } from "./types.js";

async function ensureDir(path = CHAT_GIT_DIR): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function loadGitStore(): Promise<GitStore> {
  try {
    const raw = await readFile(CONVERSATIONS_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as GitStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveGitStore(store: GitStore): Promise<void> {
  await ensureDir();
  await writeFile(CONVERSATIONS_JSON_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function readLastApply(): Promise<AppliedGitState | undefined> {
  try {
    return JSON.parse(await readFile(LAST_APPLY_JSON_PATH, "utf8")) as AppliedGitState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeLastApply(state: AppliedGitState): Promise<void> {
  await ensureDir();
  await writeFile(LAST_APPLY_JSON_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function appendDebugLine(line: string): Promise<void> {
  await ensureDir();
  await appendFile(DEBUG_LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
}

export function encodeConversationId(conversationId: string): string {
  return encodeURIComponent(conversationId);
}

export function generatedConversationDir(conversationId: string): string {
  return join(GENERATED_DIR, encodeConversationId(conversationId));
}

export async function writeGeneratedGitconfig(conversationId: string, content: string): Promise<string> {
  return writeGeneratedGitAssets(conversationId, { gitconfig: content });
}

export async function writeGeneratedGitAssets(conversationId: string, assets: { gitconfig: string; helperShell?: string; helperJs?: string }): Promise<string> {
  const dir = generatedConversationDir(conversationId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "gitconfig"), assets.gitconfig, "utf8");
  if (assets.helperShell) {
    const helperPath = join(dir, "github-app-helper");
    await writeFile(helperPath, assets.helperShell, "utf8");
    await chmod(helperPath, 0o755).catch(() => undefined);
  }
  if (assets.helperJs) {
    const jsPath = join(dir, "github-app-helper.js");
    await writeFile(jsPath, assets.helperJs, "utf8");
    await chmod(jsPath, 0o755).catch(() => undefined);
  }
  return dir;
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
