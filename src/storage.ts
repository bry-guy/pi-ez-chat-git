import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const dir = generatedConversationDir(conversationId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "gitconfig");
  await writeFile(path, content, "utf8");
  return dir;
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
