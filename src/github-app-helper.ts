export const GITHUB_APP_HELPER_PATH = "/gondolin-git/github-app-helper";
export const GITHUB_APP_HELPER_JS_PATH = "/gondolin-git/github-app-helper.js";

export function extractRepoFromCredentialInput(input: string): string | undefined {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    fields.set(line.slice(0, index), line.slice(index + 1));
  }
  const host = fields.get("host");
  if (host && host !== "github.com") return undefined;
  const path = (fields.get("path") ?? "").replace(/^\/+/, "").replace(/\.git$/, "");
  const match = path.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/.*)?$/);
  return match?.[1];
}

export function githubAppHelperJsSource(): string {
  return `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
const fields = new Map();
for (const line of input.split(/\\r?\\n/)) {
  const index = line.indexOf("=");
  if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
}
if (fields.get("host") && fields.get("host") !== "github.com") process.exit(0);
const repo = (fields.get("path") || "").replace(/^\\/+/, "").replace(/\\.git$/, "").match(/^([A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)/)?.[1];
if (!repo) process.exit(0);
const baseUrl = process.env.PI_SECRET_BROKER_URL;
const token = process.env.PI_SECRET_BROKER_TOKEN;
if (!baseUrl || !token) {
  console.error("PI_SECRET_BROKER_URL and PI_SECRET_BROKER_TOKEN are required for GitHub App auth");
  process.exit(1);
}
const response = await fetch(new URL("/mint", baseUrl), {
  method: "POST",
  headers: { Authorization: ` + "`Bearer ${token}`" + `, "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "github-app-token", repo }),
});
const body = await response.text();
let parsed;
try { parsed = JSON.parse(body); } catch { parsed = { ok: false, error: body }; }
if (!response.ok || !parsed.ok) {
  console.error(parsed.error || ` + "`secret broker returned ${response.status}`" + `);
  process.exit(1);
}
process.stdout.write(` + "`username=${parsed.username || 'x-access-token'}\npassword=${parsed.password}\n\n`" + `);
`;
}

export function githubAppHelperShellSource(): string {
  return `#!/bin/sh
[ "$1" = "get" ] || exit 0
exec node ${GITHUB_APP_HELPER_JS_PATH}
`;
}
