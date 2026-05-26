import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GitIdentity } from "./types.js";

export function parseIdentity(input: string): GitIdentity {
  const trimmed = input.trim();
  const match = trimmed.match(/^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (!match) throw new Error('identity must look like: "Name <email@example.com>"');
  const name = match[1].trim();
  const email = match[2].trim();
  if (!name || !email) throw new Error('identity must look like: "Name <email@example.com>"');
  return { name, email };
}

export function formatIdentity(identity: GitIdentity): string {
  return `${identity.name} <${identity.email}>`;
}

export function parseGitconfigIdentity(content: string): GitIdentity | undefined {
  let section = "";
  let name: string | undefined;
  let email: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== "user") continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === "name") name = value;
    if (key === "email") email = value;
  }
  return name && email ? { name, email } : undefined;
}

export async function resolveHostGitIdentity(gitconfigPath = join(homedir(), ".gitconfig")): Promise<GitIdentity | undefined> {
  try {
    return parseGitconfigIdentity(await readFile(gitconfigPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolveIdentity(override?: GitIdentity): Promise<GitIdentity | undefined> {
  return override ?? (await resolveHostGitIdentity());
}
