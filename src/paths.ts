import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_GIT_DIR = join(homedir(), ".pi", "agent", "chat-git");
export const CONVERSATIONS_JSON_PATH = join(CHAT_GIT_DIR, "conversations.json");
export const LAST_APPLY_JSON_PATH = join(CHAT_GIT_DIR, "last-apply.json");
export const DEBUG_LOG_PATH = join(CHAT_GIT_DIR, "debug.log");
export const GENERATED_DIR = join(CHAT_GIT_DIR, "generated");
export const GUEST_GITCONFIG_DIR = "/gondolin-git";
export const GUEST_GITCONFIG_PATH = `${GUEST_GITCONFIG_DIR}/gitconfig`;
