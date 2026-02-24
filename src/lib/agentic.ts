/**
 * Parse agentic file-edit blocks from AI response and apply them via Tauri commands.
 * Format: ```file:path/relative/to/workspace
 * content
 * ```
 */

import { invoke } from "@tauri-apps/api/core";

export interface FileEdit {
  path: string;
  content: string;
}

const FILE_BLOCK_REGEX = /```file:([^\n]+)\n([\s\S]*?)```/g;
const REMOVE_BLOCK_REGEX = /```remove:([^\n`]+)\s*```/g;
const LIST_BLOCK_REGEX = /```list:(?:([^\n`]*?))\s*```/g;
const REMOVE_ALL_BLOCK_REGEX = /```remove-all:(?:([^\n`]*?))\s*```/g;
const REMOVE_MATCHING_BLOCK_REGEX = /```remove-matching:(?:([^\n`]*?))\s*```/g;
const INSTALL_REQUIREMENTS_REGEX = /```install-requirements:(?:([^\n`]*?))\s*```/g;
const PIP_INSTALL_REGEX = /```pip-install:(?:([^\n`]*?))\s*```/g;
const READ_BLOCK_REGEX = /```read:(?:([^\n`]+?))\s*```/g;
const RUN_BLOCK_REGEX = /```run:(?:([^\n`]+?))\s*```/g;
const RUN_DOCKER_BLOCK_REGEX = /```run-docker:([^\s]+)\s+([^\n`]+?)\s*```/g;
const RUN_DOCKER_BUILD_BLOCK_REGEX = /```run-docker-build:(?:([^\n`]+?))\s*```/g;
const CREATE_VENV_REGEX = /```create-venv:(?:([^\n`]*?))\s*```/g;

export function parseFileEdits(text: string): FileEdit[] {
  const edits: FileEdit[] = [];
  let m: RegExpExecArray | null;
  FILE_BLOCK_REGEX.lastIndex = 0;
  while ((m = FILE_BLOCK_REGEX.exec(text)) !== null) {
    edits.push({ path: m[1].trim(), content: m[2].trimEnd() });
  }
  return edits;
}

/** Paths that look like glob/regex patterns, not concrete file paths. */
const REMOVE_PATTERN_BLACKLIST = /^\.\*$|[\*?\[\]]/;

/** Parse ```remove:path``` blocks from AI response (for agentic file removal). */
export function parseRemoveEdits(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  REMOVE_BLOCK_REGEX.lastIndex = 0;
  while ((m = REMOVE_BLOCK_REGEX.exec(text)) !== null) {
    const path = m[1].trim();
    if (path && !paths.includes(path) && !REMOVE_PATTERN_BLACKLIST.test(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/** Parse ```list:path``` blocks (path optional, default "."). Returns paths to list. */
export function parseListRequests(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  LIST_BLOCK_REGEX.lastIndex = 0;
  while ((m = LIST_BLOCK_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim() || ".";
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Parse ```remove-all:path``` blocks (path optional, default "."). Returns dir paths to clear. */
export function parseRemoveAllRequests(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  REMOVE_ALL_BLOCK_REGEX.lastIndex = 0;
  while ((m = REMOVE_ALL_BLOCK_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim() || ".";
    // Guardrails: remove-all is for directories (".", "subfolder"), not file types or globs.
    // Common wrong outputs like "remove-all:*.mp4" or "remove-all:.mp4" should be ignored.
    const looksLikeGlob = /[\*\?\[\]]/.test(path);
    const looksLikeBareExtension = /^\.[A-Za-z0-9]+$/.test(path);
    if (!looksLikeGlob && !looksLikeBareExtension && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Parse ```remove-matching:pattern``` blocks (e.g. "*.mp4" or "videos/*.mp4"). Returns the raw patterns. */
export function parseRemoveMatchingRequests(text: string): string[] {
  const patterns: string[] = [];
  let m: RegExpExecArray | null;
  REMOVE_MATCHING_BLOCK_REGEX.lastIndex = 0;
  while ((m = REMOVE_MATCHING_BLOCK_REGEX.exec(text)) !== null) {
    let pattern = (m[1] || "").trim();
    if (!pattern) continue;
    // Normalize bare extensions like ".mp4" to "*.mp4" so they behave as expected.
    if (/^\.[A-Za-z0-9]+$/.test(pattern)) {
      pattern = `*${pattern}`;
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

/** Parse ```install-requirements:path``` (path optional, default "requirements.txt"). */
export function parseInstallRequirements(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  INSTALL_REQUIREMENTS_REGEX.lastIndex = 0;
  while ((m = INSTALL_REQUIREMENTS_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim() || "requirements.txt";
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Parse ```pip-install: pkg1 pkg2```. Returns list of package strings (space-separated). */
export function parsePipInstall(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  PIP_INSTALL_REGEX.lastIndex = 0;
  while ((m = PIP_INSTALL_REGEX.exec(text)) !== null) {
    const s = (m[1] || "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Parse ```read:path``` blocks. Returns list of file paths to read. */
export function parseReadRequests(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  READ_BLOCK_REGEX.lastIndex = 0;
  while ((m = READ_BLOCK_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Parse ```run:path``` blocks. Returns list of script paths the model wants to run. */
export function parseRunRequests(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  RUN_BLOCK_REGEX.lastIndex = 0;
  while ((m = RUN_BLOCK_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

export interface RunDockerRequest {
  image: string;
  path: string;
}

/** Parse ```run-docker:image path``` blocks. Returns list of { image, path }. */
export function parseRunDockerRequests(text: string): RunDockerRequest[] {
  const out: RunDockerRequest[] = [];
  let m: RegExpExecArray | null;
  RUN_DOCKER_BLOCK_REGEX.lastIndex = 0;
  while ((m = RUN_DOCKER_BLOCK_REGEX.exec(text)) !== null) {
    const image = (m[1] || "").trim();
    const path = (m[2] || "").trim();
    if (image && path && !out.some((r) => r.image === image && r.path === path)) {
      out.push({ image, path });
    }
  }
  return out;
}

export interface RunDockerBuildRequest {
  dockerfile?: string;
  path: string;
}

/** Parse ```run-docker-build:script.py``` or ```run-docker-build:Dockerfile script.py```. */
export function parseRunDockerBuildRequests(text: string): RunDockerBuildRequest[] {
  const out: RunDockerBuildRequest[] = [];
  let m: RegExpExecArray | null;
  RUN_DOCKER_BUILD_BLOCK_REGEX.lastIndex = 0;
  while ((m = RUN_DOCKER_BUILD_BLOCK_REGEX.exec(text)) !== null) {
    const rest = (m[1] || "").trim();
    if (!rest) continue;
    const parts = rest.split(/\s+/).filter(Boolean);
    const req: RunDockerBuildRequest =
      parts.length >= 2
        ? { dockerfile: parts[0], path: parts[1] }
        : { path: parts[0] };
    if (!out.some((r) => r.path === req.path && r.dockerfile === req.dockerfile)) {
      out.push(req);
    }
  }
  return out;
}

/** Parse ```create-venv:path``` blocks (path optional, default ".venv"). Returns list of venv paths to create. */
export function parseCreateVenvRequests(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  CREATE_VENV_REGEX.lastIndex = 0;
  while ((m = CREATE_VENV_REGEX.exec(text)) !== null) {
    const path = (m[1] || "").trim() || ".venv";
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export async function createVenv(
  workspaceRoot: string,
  relativePath?: string
): Promise<RunScriptResult> {
  return invoke("create_venv", {
    workspaceRoot,
    relativePath: relativePath ?? null,
  });
}

/** Append a line to the workspace log file (.agentic.log) for real-time progress. */
export async function appendWorkspaceLog(workspaceRoot: string, message: string): Promise<void> {
  await invoke("append_workspace_log", { workspaceRoot, message });
}

export async function runPipInstallRequirements(
  workspaceRoot: string,
  requirementsPath: string
): Promise<RunScriptResult> {
  return invoke("run_pip_install", {
    workspaceRoot,
    requirementsPath,
    packages: null,
  });
}

export async function runPipInstallPackages(
  workspaceRoot: string,
  packagesStr: string
): Promise<RunScriptResult> {
  const packages = packagesStr.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return invoke("run_pip_install", {
    workspaceRoot,
    requirementsPath: null,
    packages,
  });
}

export async function applyFileEdit(
  workspaceRoot: string,
  path: string,
  content: string
): Promise<void> {
  await invoke("write_workspace_file", {
    workspaceRoot,
    relativePath: path,
    content,
  });
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string
): Promise<string> {
  return invoke("read_workspace_file", {
    workspaceRoot,
    relativePath,
  });
}

export async function listWorkspaceDir(
  workspaceRoot: string,
  relativePath: string
): Promise<string[]> {
  return invoke("list_workspace_dir", {
    workspaceRoot,
    relativePath: relativePath || ".",
  });
}

export async function removeWorkspaceFile(
  workspaceRoot: string,
  relativePath: string
): Promise<void> {
  await invoke("remove_workspace_file", {
    workspaceRoot,
    relativePath,
  });
}

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** When set, indicates which Python env was used (e.g. "workspace .venv" or "system python3"). */
  interpreter_used?: string;
}

const RUNNABLE_EXT = /\.(py|js|mjs|ts|sh)$/i;

export function isRunnablePath(path: string): boolean {
  return RUNNABLE_EXT.test(path);
}

export async function runWorkspaceScript(
  workspaceRoot: string,
  relativePath: string,
  interpreterOverride?: string,
  runId?: string
): Promise<RunScriptResult> {
  return invoke("run_workspace_script", {
    workspaceRoot,
    relativePath,
    interpreterOverride: interpreterOverride ?? null,
    runId: runId ?? null,
  });
}

export async function runWorkspaceScriptDocker(
  workspaceRoot: string,
  relativePath: string,
  dockerImage: string,
  runId?: string
): Promise<RunScriptResult> {
  return invoke("run_workspace_script_docker", {
    workspaceRoot,
    relativePath,
    dockerImage,
    runId: runId ?? null,
  });
}

export async function runWorkspaceScriptDockerBuild(
  workspaceRoot: string,
  relativeScriptPath: string,
  dockerfilePath?: string,
  runId?: string
): Promise<RunScriptResult> {
  return invoke("run_workspace_script_docker_build", {
    workspaceRoot,
    relativeScriptPath,
    dockerfilePath: dockerfilePath ?? null,
    runId: runId ?? null,
  });
}
