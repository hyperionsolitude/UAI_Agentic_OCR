import { useState, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { chat, chatStream, fetchModels, FALLBACK_MODELS, type Message } from "./lib/groq";
import { extractTextFromImage, isImageFile } from "./lib/ocr";
import {
  parseFileEdits,
  parseRemoveEdits,
  parseListRequests,
  parseRemoveAllRequests,
  parseInstallRequirements,
  parsePipInstall,
  parseReadRequests,
  parseRunRequests,
  parseRunDockerRequests,
  parseRunDockerBuildRequests,
  parseCreateVenvRequests,
  applyFileEdit,
  runWorkspaceScript,
  runWorkspaceScriptDocker,
  runWorkspaceScriptDockerBuild,
  runPipInstallRequirements,
  runPipInstallPackages,
  createVenv,
  appendWorkspaceLog,
  isRunnablePath,
  listWorkspaceDir,
  readWorkspaceFile,
  removeWorkspaceFile,
  type FileEdit,
  type RunScriptResult,
  type RunDockerRequest,
  type RunDockerBuildRequest,
} from "./lib/agentic";
import "./App.css";

/** True if the path looks like a requirements file (e.g. requirements.txt), not a package name. */
function looksLikeRequirementsFilePath(path: string): boolean {
  const p = path.trim();
  return p.includes("/") || p.includes("\\") || /\.(txt|req|in)$/i.test(p);
}

const AGENTIC_SYSTEM = `You are a helpful assistant. When the user asks for a file to be created or saved "in the workspace" (or similar), you MUST output it using this EXACT format so the app can create the file. No other format will work.

Format (path is relative to the user's workspace folder):

\`\`\`file:FILENAME
full file content here
\`\`\`

Rules:
- For each request that involves creating and/or running a script (Python, C, C++, Java, or other): build and run in Docker. Output \`\`\`file:Dockerfile\`\`\` (use the right base image: python:3.11 for Python with RUN pip install as needed; gcc for C/C++; openjdk for Java), \`\`\`file:script.py\`\`\` or \`\`\`file:main.c\`\`\` / \`\`\`file:Main.java\`\`\` etc. if creating, then \`\`\`run-docker-build:path/to/script\`\`\`. Do not use \`\`\`pip-install\`\`\` + \`\`\`run\`\`\` unless the user explicitly says "run locally" or "without Docker".
- Each action (file, remove, list, pip-install, run, etc.) must be in its OWN \`\`\`...\`\`\` block. Never put two actions in one block (e.g. never \`\`\`pip-install: requests\\nrun:script.py\`\`\` — use two separate blocks).
- Use \`\`\`file:filename\`\`\` (with "file:" right after the backticks and the filename). Example: \`\`\`file:hanoi.py
- Put the ENTIRE file content between the opening and closing \`\`\`.
- Do NOT use \`\`\`python or other language tags for files that should be created in the workspace—only \`\`\`file:filename works.
- You can output multiple \`\`\`file:path\`\`\` blocks for multiple files.
- Only output \`\`\`file:path\`\`\` when the user explicitly asks to create, write, save, or change a file. If the user only asks to "run the script", "run it", or "execute" an existing file, output ONLY \`\`\`run:path\`\`\` — never \`\`\`file:path\`\`\`, or you will overwrite the file.
- When the user says "in the workspace", "create a file", "save as", or "give me X in the workspace", always include a \`\`\`file:...\`\`\` block with the content.

When the user asks to REMOVE or DELETE a specific file from the workspace, output:
\`\`\`remove:exact-path-only
\`\`\`
(e.g. \`\`\`remove:primes.py
\`\`\`). One path per block. Use exact file/folder names only — never \`\`\`remove:.*\`\`\`.

When the user asks to remove ALL files, clear the workspace, "remove ./*", "remove everything", or similar, output this so the app will remove every file in the workspace:
\`\`\`remove-all:.
\`\`\`
(Use \`\`\`remove-all:.\`\`\` for workspace root, or \`\`\`remove-all:subfolder\`\`\` to clear a subfolder.) The app will then list and remove all items after confirmation.

When the user asks to LIST FILES, show workspace contents, or "what's in my workspace", output this so the app will show the real file list:
\`\`\`list:.
\`\`\`
(Use \`\`\`list:.\`\`\` for workspace root, or \`\`\`list:subfolder\`\`\` for a subfolder.) The app will then display the actual files—do NOT make up a list; output the block and the app fills in the result.

When the user asks to INSTALL REQUIREMENTS, install dependencies to run a script, or "pip install" packages, output one of these so the app will run the install automatically (no button click needed):
- From a requirements FILE (path to a file like requirements.txt): \`\`\`install-requirements:requirements.txt
\`\`\` (or \`\`\`install-requirements:path/to/req.txt
\`\`\`). NEVER use install-requirements: for a package name — that is only for file paths.
- For one or more PACKAGE NAMES (e.g. requests, flask): \`\`\`pip-install: requests
\`\`\` or \`\`\`pip-install: requests flask
\`\`\` (space-separated). Always use pip-install: for package names, never install-requirements:.

When the user asks to READ or OPEN a file in the workspace (to see its contents, analyze it, or edit it), output:
\`\`\`read:path/to/file
\`\`\`
The app will read the file and give you its contents in a follow-up turn so you can respond.

When the user asks to RUN or EXECUTE a script in the workspace:
- DEFAULT: build and run in Docker for each request. Output 1) \`\`\`file:Dockerfile\`\`\` with the right base image (Python: FROM python:3.11 + RUN pip install as needed; C/C++: FROM gcc; Java: FROM openjdk), 2) \`\`\`run-docker-build:script_path\`\`\` (e.g. script.py, main.c, Main.java). If you are not sure which packages the script needs, output \`\`\`read:path\`\`\` first, then next turn output Dockerfile + run-docker-build. Do NOT use \`\`\`pip-install\`\`\` + \`\`\`run\`\`\` unless the user explicitly says "run locally" or "don't use Docker".
- Use the script path in the workspace. The run block is ONLY the path: \`\`\`run:path\`\`\` or \`\`\`run-docker-build:path\`\`\`. NEVER \`\`\`run:.venv/bin/python3 script.py\`\`\` — the app runs (or compiles and runs) the script in the container. Do NOT output \`\`\`file:path\`\`\` when the user only asked to run (except \`\`\`file:Dockerfile\`\`\` for the Docker flow).

When the user asks to RUN a script INSIDE A DOCKER CONTAINER (e.g. "run in Docker", "run with python:3.11", "run in container"), output a separate block:
\`\`\`run-docker:IMAGE path/to/script.py
\`\`\`
Example: \`\`\`run-docker:python:3.11 request_example.py
\`\`\` or \`\`\`run-docker:node:20 app.js
\`\`\`. Image and path are required; the workspace is mounted at /workspace inside the container. Use one block per run.

DEFAULT for script runs: build and run in Docker for each request. Output \`\`\`file:Dockerfile\`\`\` (Python: FROM python:3.11 + RUN pip install; C/C++: FROM gcc; Java: FROM openjdk) then \`\`\`run-docker-build:script_path\`\`\`. Works for .py, .c, .cpp, .java, .js, .sh. No explicit "Docker?" request needed.

When the user asks to create a script (any language) and run it — e.g. "give me a numpy example", "give me a request example", "give me a C hello world", "create a Java example" — use the Docker build flow every time: 1) \`\`\`file:Dockerfile\`\`\` (Python: FROM python:3.11, RUN pip install packages; C/C++: FROM gcc; Java: FROM openjdk), 2) \`\`\`file:script\`\`\`, 3) \`\`\`run-docker-build:script\`\`\`. Do not use \`\`\`pip-install\`\`\` + \`\`\`run\`\`\` for Python examples; use Docker so every example builds and runs in a container. Same for C, C++, Java: Dockerfile + file + run-docker-build.

When the user explicitly asks to run in a pre-made image (e.g. "run in Docker", "run with python:3.11") without building, use \`\`\`run-docker:IMAGE script.py\`\`\` instead.

When the user asks to create a Python VIRTUAL ENVIRONMENT (venv) for the project, e.g. to install prerequisites in isolation, output:
\`\`\`create-venv:.venv
\`\`\`
(or \`\`\`create-venv:venv\`\`\` for a different folder). The app creates the venv; pip installs and Python script runs then use this venv automatically.

When the user wants a script that needs packages or a compiler (Python + pip, C, C++, Java, etc.) — e.g. "give me a request example", "create a numpy example", "give me a C/Java example" — ALWAYS use the Docker build flow: 1) \`\`\`file:Dockerfile\`\`\` (Python: FROM python:3.11, RUN pip install ...; C/C++: FROM gcc; Java: FROM openjdk), 2) \`\`\`file:script\`\`\`, 3) \`\`\`run-docker-build:script\`\`\`. Do NOT use \`\`\`pip-install\`\`\` + \`\`\`run\`\`\` for these — use Docker so every example builds and runs the same way. Only use pip-install + run when the user explicitly says they do not want Docker.

When you see a tool result that a run failed with "ModuleNotFoundError: No module named 'X'", output \`\`\`pip-install: X\`\`\` then \`\`\`run:same_script.py\`\`\` in the SAME response. The run block must be ONLY the script path — never \`\`\`run:.venv/bin/python3 script.py\`\`\`; only \`\`\`run:script.py\`\`\`.

When Docker build or run fails with "docker: No such file or directory" or "env: docker: No such file", do NOT suggest \`\`\`pip-install: docker\`\`\` (that is the Python library, not the Docker engine). Instead tell the user to install Docker Desktop (https://docker.com/products/docker-desktop) or run the script locally: output \`\`\`pip-install: numpy\`\`\` (or the required package) and \`\`\`run:script.py\`\`\` so the app runs in the workspace .venv.

Graphs, plots, and animations: Scripts run in Docker have no display (no GUI). Do NOT use plt.show() or expect a window. Always save the output to a file in the workspace so the user can open it: e.g. fig.savefig('plot.png') for static plots, or animation.save('anim.mp4') for animations. For matplotlib animations saved as MP4, the Dockerfile must install ffmpeg (e.g. FROM python:3.11-slim, RUN apt-get update && apt-get install -y ffmpeg, RUN pip install matplotlib numpy). Only when the script actually saves a plot or animation to a real file (e.g. plot.png, anim.mp4), add exactly one sentence with that filename: "The graph/animation is saved as [filename] in your workspace — open that file to view it." Never say "saved as (none)", "saved as None", or mention opening a file when there is no such file. For C, C++, Java, or any script that only prints to stdout (no image/video file), do NOT add any sentence about a saved file — the result is just the program output.

Example for "Give me a tower of hanoi in the workspace":
\`\`\`file:hanoi.py
def tower_of_hanoi(n, from_rod, to_rod, aux_rod):
    ...
if __name__ == "__main__":
    main()
\`\`\`

If the user is not asking for a file to be created, removed, removed all, listed, requirements installed, read, run, run in Docker, run from Dockerfile (reproducible), or a virtual env, reply normally without using \`\`\`file: or \`\`\`remove: or \`\`\`remove-all: or \`\`\`list: or \`\`\`install-requirements: or \`\`\`pip-install: or \`\`\`read: or \`\`\`run: or \`\`\`run-docker: or \`\`\`run-docker-build: or \`\`\`create-venv:.\`\`\``;

const STORAGE_API_KEY = "agentic-ocr-gpt-api-key";
const STORAGE_MODEL = "agentic-ocr-gpt-model";
const STORAGE_SESSIONS_INDEX = "agentic-ocr-gpt-sessions";
const STORAGE_SESSION_PREFIX = "agentic-ocr-gpt-session:";

type ChatSessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  workspaceRoot?: string | null;
};

function App() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(STORAGE_API_KEY) || ""
  );
  const [model, setModel] = useState(
    () => localStorage.getItem(STORAGE_MODEL) || FALLBACK_MODELS[0]
  );
  const [availableModels, setAvailableModels] = useState<string[]>(() => FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [agenticMode, setAgenticMode] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_SESSIONS_INDEX);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ChatSessionMeta[];
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastFailedUserMessage, setLastFailedUserMessage] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [pendingEdits, setPendingEdits] = useState<FileEdit[]>([]);
  const [pendingRemoves, setPendingRemoves] = useState<string[]>([]);
  const [removeStatus, setRemoveStatus] = useState<Record<number, "idle" | "ok" | "err">>({});
  const [pendingListPaths, setPendingListPaths] = useState<string[]>([]);
  const [listResults, setListResults] = useState<Record<string, string[]>>({});
  const [pendingRemoveAllPaths, setPendingRemoveAllPaths] = useState<string[]>([]);
  const [removeAllItems, setRemoveAllItems] = useState<Record<string, string[]>>({});
  const [removeAllStatus, setRemoveAllStatus] = useState<Record<string, "idle" | "done" | "err">>({});
  const [pendingPipRequirements, setPendingPipRequirements] = useState<string[]>([]);
  const [pendingPipPackages, setPendingPipPackages] = useState<string[]>([]);
  const [pipInstallOutput, setPipInstallOutput] = useState<Record<string, RunScriptResult | null>>({});
  const [pipInstallLoading, setPipInstallLoading] = useState<Record<string, boolean>>({});
  const [applyStatus, setApplyStatus] = useState<Record<number, "idle" | "ok" | "err">>({});
  const [applyError, setApplyError] = useState<Record<number, string>>({});
  const [runOutput, setRunOutput] = useState<Record<number, RunScriptResult | null>>({});
  const [runLoading, setRunLoading] = useState<Record<number, boolean>>({});
  const [runFilePath, setRunFilePath] = useState("");
  const [runFileOutput, setRunFileOutput] = useState<RunScriptResult | null>(null);
  const [runFileLoading, setRunFileLoading] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [removeError, setRemoveError] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [lastUsage, setLastUsage] = useState<{ prompt_tokens: number; completion_tokens: number } | null>(null);
  const [pendingRunPaths, setPendingRunPaths] = useState<string[]>([]);
  const [runRequestOutput, setRunRequestOutput] = useState<Record<string, RunScriptResult | null>>({});
  const [runRequestLoading, setRunRequestLoading] = useState<Record<string, boolean>>({});
  const [pendingDockerRuns, setPendingDockerRuns] = useState<RunDockerRequest[]>([]);
  const [runDockerOutput, setRunDockerOutput] = useState<Record<string, RunScriptResult | null>>({});
  const [runDockerLoading, setRunDockerLoading] = useState<Record<string, boolean>>({});
  const [pendingDockerBuildRuns, setPendingDockerBuildRuns] = useState<RunDockerBuildRequest[]>([]);
  const [runDockerBuildOutput, setRunDockerBuildOutput] = useState<Record<string, RunScriptResult | null>>({});
  const [runDockerBuildLoading, setRunDockerBuildLoading] = useState<Record<string, boolean>>({});
  const [pendingCreateVenv, setPendingCreateVenv] = useState<string[]>([]);
  const [createVenvOutput, setCreateVenvOutput] = useState<Record<string, RunScriptResult | null>>({});
  const [createVenvLoading, setCreateVenvLoading] = useState<Record<string, boolean>>({});
  const [confirmBeforeRun, setConfirmBeforeRunState] = useState(
    () => localStorage.getItem("agentic-confirm-before-run") === "true"
  );
  const setConfirmBeforeRun = (v: boolean) => {
    setConfirmBeforeRunState(v);
    localStorage.setItem("agentic-confirm-before-run", v ? "true" : "false");
  };
  const [showHelp, setShowHelp] = useState(false);
  const [autoApplyAndRun, setAutoApplyAndRunState] = useState(
    () => localStorage.getItem("agentic-auto-apply-and-run") === "true"
  );
  const setAutoApplyAndRun = (v: boolean) => {
    setAutoApplyAndRunState(v);
    localStorage.setItem("agentic-auto-apply-and-run", v ? "true" : "false");
  };
  const [autoRunStatus, setAutoRunStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showHistory, setShowHistory] = useState(false);

  const persistSessionsIndex = (next: ChatSessionMeta[]) => {
    setSessions(next);
    try {
      localStorage.setItem(STORAGE_SESSIONS_INDEX, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const persistSessionSnapshot = (nextMessages: Message[]) => {
    if (nextMessages.length === 0) return;
    const firstUser = nextMessages.find((m) => m.role === "user");
    const titleSource = firstUser?.content.trim().split("\n")[0] || "New chat";
    const title = titleSource.length > 80 ? titleSource.slice(0, 80) + "…" : titleSource;
    const now = Date.now();
    let id = currentSessionId;
    let nextSessions = sessions;
    if (!id) {
      id = String(now);
      const meta: ChatSessionMeta = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        workspaceRoot: workspaceRoot ?? null,
      };
      nextSessions = [meta, ...sessions];
      setCurrentSessionId(id);
    } else {
      nextSessions = sessions.map((s) =>
        s.id === id
          ? {
              ...s,
              title,
              updatedAt: now,
              workspaceRoot: workspaceRoot ?? null,
            }
          : s
      );
    }
    persistSessionsIndex(nextSessions);
    try {
      localStorage.setItem(STORAGE_SESSION_PREFIX + id, JSON.stringify(nextMessages));
    } catch {
      /* ignore */
    }
  };

  const startNewSession = () => {
    setCurrentSessionId(null);
    setMessages([]);
    setWorkspaceRoot(null);
  };

  const openSession = (id: string) => {
    const meta = sessions.find((s) => s.id === id);
    setCurrentSessionId(id);
    if (meta) {
      const nextWorkspace = meta.workspaceRoot ?? null;
      setWorkspaceRoot(nextWorkspace);
    }
  };

  const deleteSession = (id: string) => {
    if (!confirm(`Delete conversation permanently?`)) return;
    const next = sessions.filter((s) => s.id !== id);
    persistSessionsIndex(next);
    try {
      localStorage.removeItem(STORAGE_SESSION_PREFIX + id);
    } catch {
      /* ignore */
    }
    if (currentSessionId === id) {
      setCurrentSessionId(null);
      setMessages([]);
      setWorkspaceRoot(null);
    }
  };

  const saveApiKey = (v: string) => {
    setApiKey(v);
    localStorage.setItem(STORAGE_API_KEY, v);
  };
  const clearApiKey = () => {
    setApiKey("");
    localStorage.removeItem(STORAGE_API_KEY);
  };
  const saveModel = (v: string) => {
    setModel(v);
    localStorage.setItem(STORAGE_MODEL, v);
  };

  const clearWorkspace = () => {
    setWorkspaceRoot(null);
  };

  const pickWorkspace = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path && typeof path === "string") {
      setWorkspaceRoot(path);
    }
  };

  // Load messages for current session on mount / when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setMessages([]);
      return;
    }
    try {
      const raw = localStorage.getItem(STORAGE_SESSION_PREFIX + currentSessionId);
      if (!raw) {
        setMessages([]);
        return;
      }
      const parsed = JSON.parse(raw) as Message[];
      if (Array.isArray(parsed)) {
        setMessages(parsed);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }
  }, [currentSessionId]);

  useEffect(() => {
    if (!workspaceRoot) return;
    listWorkspaceDir(workspaceRoot, ".")
      .then(setWorkspaceFiles)
      .catch(() => setWorkspaceFiles([]));
  }, [workspaceRoot]);

  useEffect(() => {
    const unlisten = listen<{
      run_id: string;
      relative_path: string;
      stdout: string;
      stderr: string;
      exit_code: number;
      interpreter_used?: string;
    }>("script-finished", (event) => {
        const { run_id, stdout, stderr, exit_code, interpreter_used } = event.payload;
        const result: RunScriptResult = { stdout, stderr, exit_code, interpreter_used };
        if (run_id.startsWith("suggested:")) {
          const path = run_id.slice("suggested:".length);
          setRunRequestOutput((o) => ({ ...o, [path]: result }));
          setRunRequestLoading((l) => ({ ...l, [path]: false }));
        } else if (run_id.startsWith("docker:")) {
          const key = run_id.slice("docker:".length);
          setRunDockerOutput((o) => ({ ...o, [key]: result }));
          setRunDockerLoading((l) => ({ ...l, [key]: false }));
        } else if (run_id.startsWith("dockerbuild:")) {
          const key = run_id.slice("dockerbuild:".length);
          setRunDockerBuildOutput((o) => ({ ...o, [key]: result }));
          setRunDockerBuildLoading((l) => ({ ...l, [key]: false }));
        } else if (run_id.startsWith("edit:")) {
          const index = parseInt(run_id.slice("edit:".length), 10);
          if (!Number.isNaN(index)) {
            setRunOutput((o) => ({ ...o, [index]: result }));
            setRunLoading((l) => ({ ...l, [index]: false }));
          }
        } else if (run_id.startsWith("manual:")) {
          setRunFileOutput(result);
          setRunFileLoading(false);
        }
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    setModelsLoading(true);
    fetchModels(apiKey)
      .then((list) => {
        setAvailableModels(list);
        const first = list[0];
        setModel((current) => {
          if (list.includes(current)) return current;
          if (first) localStorage.setItem(STORAGE_MODEL, first);
          return first ?? current;
        });
      })
      .finally(() => setModelsLoading(false));
  }, [apiKey]);

  const runOcr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !isImageFile(file)) return;
    try {
      const text = await extractTextFromImage(file);
      setOcrText(text);
      setInput((prev) => (prev ? prev + "\n\n" + text : text));
    } catch (err) {
      setOcrText("OCR failed: " + (err instanceof Error ? err.message : String(err)));
    }
    e.target.value = "";
  };

  const send = async (overrideText?: string, isResubmit?: boolean) => {
    const text = ((isResubmit ? overrideText : input.trim()) ?? "").trim();
    if (!text || !apiKey) return;
    if (!isResubmit) {
      setLastFailedUserMessage(null);
      setInput("");
      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
    } else {
      setLastFailedUserMessage(null);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content.startsWith("Error:"))
          return [...prev.slice(0, -1), { role: "assistant" as const, content: "" }];
        return prev;
      });
    }
    setLoading(true);
    setPendingEdits([]);
    setPendingRemoves([]);
    setPendingListPaths([]);
    setPendingRemoveAllPaths([]);
    setRemoveAllItems({});
    setRemoveAllStatus({});
    setPendingPipRequirements([]);
    setPendingPipPackages([]);
    setPipInstallOutput({});
    setPipInstallLoading({});
    setPendingRunPaths([]);
    setRunRequestOutput({});
    setRunRequestLoading({});
    setPendingDockerRuns([]);
    setRunDockerOutput({});
    setRunDockerLoading({});
    setPendingDockerBuildRuns([]);
    setRunDockerBuildOutput({});
    setRunDockerBuildLoading({});
    setPendingCreateVenv([]);
    setCreateVenvOutput({});
    setCreateVenvLoading({});
    setListResults({});
    setRemoveStatus({});
    setApplyStatus({});
    setApplyError({});

    try {
      if (workspaceRoot) {
        appendWorkspaceLog(workspaceRoot, "=== User ===\n" + text).catch(() => {});
      }
      let systemPrompt = agenticMode ? AGENTIC_SYSTEM : undefined;
      if (systemPrompt) {
        systemPrompt =
          systemPrompt +
          "\n\nThe user's currently selected chat model is: " +
          model +
          ". If they ask which model is selected, what model is being used, or similar, answer with this model name (e.g. \"The current model is " +
          model +
          ".\").";
      }
      if (workspaceRoot && systemPrompt) {
        try {
          const rootFiles = await listWorkspaceDir(workspaceRoot, ".");
          systemPrompt =
            systemPrompt +
            "\n\nCurrent workspace root files: " +
            rootFiles.join(", ") +
            ". When the user asks to run or open a script, use the exact file name from this list (e.g. if script.py is listed, output run:script.py). Do not ask them to replace with the actual name.";
        } catch {
          /* keep prompt as is */
        }
      }
      const userMessage: Message = { role: "user", content: text };
      const baseMessages = isResubmit ? messages.slice(0, -1) : messages;
      const chatMessages: Message[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...baseMessages,
        ...(isResubmit ? [] : [userMessage]),
      ];
      if (!isResubmit) setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      let resultContent: string;
      if (streaming) {
        const result = await chatStream({
          apiKey,
          model,
          messages: chatMessages,
          maxTokens: 4096,
          onChunk: (delta) => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
              return next;
            });
          },
          onUsage: setLastUsage,
        });
        resultContent = result.content;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: resultContent };
          persistSessionSnapshot(next);
          return next;
        });
        if (result.usage) setLastUsage(result.usage);
      } else {
        const result = await chat({
          apiKey,
          model,
          messages: chatMessages,
          maxTokens: 4096,
        });
        resultContent = result.content;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: resultContent };
          persistSessionSnapshot(next);
          return next;
        });
        if (result.usage) setLastUsage(result.usage);
      }
      if (workspaceRoot) {
        const maxLen = 100000;
        const modelLog = resultContent.length > maxLen ? resultContent.slice(0, maxLen) + "\n... (truncated, " + resultContent.length + " chars total)" : resultContent;
        appendWorkspaceLog(workspaceRoot, "=== Model ===\n" + modelLog).catch(() => {});
      }
      const edits = parseFileEdits(resultContent);
      const removes = parseRemoveEdits(resultContent);
      const listPaths = parseListRequests(resultContent);
      const removeAllPaths = parseRemoveAllRequests(resultContent);
      const pipReqsRaw = parseInstallRequirements(resultContent);
      const pipPkgs = parsePipInstall(resultContent);
      const pipReqPaths = pipReqsRaw.filter(looksLikeRequirementsFilePath);
      const reqAsPackages = pipReqsRaw.filter((p) => !looksLikeRequirementsFilePath(p));
      const allPipPkgs = pipPkgs.length || reqAsPackages.length ? [...pipPkgs, ...reqAsPackages] : [];
      if (edits.length) setPendingEdits(edits);
      if (removes.length) setPendingRemoves(removes);
      if (pipReqPaths.length) setPendingPipRequirements(pipReqPaths);
      else setPendingPipRequirements([]);
      if (allPipPkgs.length) setPendingPipPackages(allPipPkgs);
      else setPendingPipPackages([]);
      // Auto-run pip when model suggests (if not autoApplyAndRun we fire here; else we await in order below)
      if ((pipReqPaths.length || allPipPkgs.length) && workspaceRoot && !autoApplyAndRun) {
        for (const path of pipReqPaths) runPipRequirements(path);
        for (const packagesStr of allPipPkgs) runPipPackages(packagesStr);
      }
      if (listPaths.length > 0 && workspaceRoot) {
        setPendingListPaths(listPaths);
        const results: Record<string, string[]> = {};
        for (const p of listPaths) {
          try {
            results[p] = await listWorkspaceDir(workspaceRoot, p);
          } catch {
            results[p] = [];
          }
        }
        setListResults(results);
      } else {
        setPendingListPaths([]);
        setListResults({});
      }
      if (removeAllPaths.length > 0 && workspaceRoot) {
        setPendingRemoveAllPaths(removeAllPaths);
        const items: Record<string, string[]> = {};
        for (const p of removeAllPaths) {
          try {
            items[p] = await listWorkspaceDir(workspaceRoot, p);
          } catch {
            items[p] = [];
          }
        }
        setRemoveAllItems(items);
        setRemoveAllStatus({});
      } else {
        setPendingRemoveAllPaths([]);
        setRemoveAllItems({});
        setRemoveAllStatus({});
      }
      const runPaths = parseRunRequests(resultContent);
      if (runPaths.length) setPendingRunPaths(runPaths);
      else setPendingRunPaths([]);
      const dockerRuns = parseRunDockerRequests(resultContent);
      if (dockerRuns.length) setPendingDockerRuns(dockerRuns);
      else setPendingDockerRuns([]);
      if (dockerRuns.length && workspaceRoot && !autoApplyAndRun) {
        for (const r of dockerRuns) runSuggestedDockerScript(r.path, r.image);
      }
      const dockerBuildRuns = parseRunDockerBuildRequests(resultContent);
      if (dockerBuildRuns.length) setPendingDockerBuildRuns(dockerBuildRuns);
      else setPendingDockerBuildRuns([]);
      if (dockerBuildRuns.length && workspaceRoot && !autoApplyAndRun) {
        for (const r of dockerBuildRuns) runSuggestedDockerBuildScript(r.path, r.dockerfile);
      }
      const venvPaths = parseCreateVenvRequests(resultContent);
      if (venvPaths.length) setPendingCreateVenv(venvPaths);
      else setPendingCreateVenv([]);
      if (venvPaths.length > 0 && workspaceRoot && !autoApplyAndRun) {
        for (const path of venvPaths) {
          setCreateVenvLoading((l) => ({ ...l, [path]: true }));
          setCreateVenvOutput((o) => ({ ...o, [path]: null }));
          createVenv(workspaceRoot, path)
            .then((result) => setCreateVenvOutput((o) => ({ ...o, [path]: result })))
            .catch((e) =>
              setCreateVenvOutput((o) => ({
                ...o,
                [path]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
              }))
            )
            .finally(() => setCreateVenvLoading((l) => ({ ...l, [path]: false })));
        }
      }
      const readPaths = parseReadRequests(resultContent);
      if (autoApplyAndRun && workspaceRoot) {
        (async () => {
          const root = workspaceRoot;
          try {
            await appendWorkspaceLog(root, "Auto-apply started");
            for (const path of venvPaths) {
              setAutoRunStatus(`Creating venv ${path}…`);
              await appendWorkspaceLog(root, `Creating venv ${path}…`);
              setCreateVenvLoading((l) => ({ ...l, [path]: true }));
              setCreateVenvOutput((o) => ({ ...o, [path]: null }));
              try {
                const result = await createVenv(root, path);
                setCreateVenvOutput((o) => ({ ...o, [path]: result }));
              } catch (e) {
                setCreateVenvOutput((o) => ({
                  ...o,
                  [path]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
                }));
                await appendWorkspaceLog(root, `Venv failed: ${e instanceof Error ? e.message : String(e)}`);
              }
              setCreateVenvLoading((l) => ({ ...l, [path]: false }));
            }
            if (pipReqPaths.length || allPipPkgs.length) {
              setAutoRunStatus("Installing packages…");
              await appendWorkspaceLog(root, "Installing packages…");
              for (const path of pipReqPaths) await runPipRequirements(path);
              for (const packagesStr of allPipPkgs) await runPipPackages(packagesStr);
            }
            if (edits.length) {
              setAutoRunStatus(`Applying ${edits.length} file(s)…`);
              await appendWorkspaceLog(root, `Applying ${edits.length} file(s)…`);
              for (let i = 0; i < edits.length; i++) {
                try {
                  await applyFileEdit(root, edits[i].path, edits[i].content);
                  setApplyStatus((s) => ({ ...s, [i]: "ok" }));
                  setRunOutput((o) => ({ ...o, [i]: null }));
                } catch (e) {
                  setApplyStatus((s) => ({ ...s, [i]: "err" }));
                  setApplyError((err) => ({ ...err, [i]: e instanceof Error ? e.message : String(e) }));
                  await appendWorkspaceLog(root, `Apply failed ${edits[i].path}: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }
            if (runPaths.length) {
              setAutoRunStatus(`Running ${runPaths.length} script(s)…`);
              await appendWorkspaceLog(root, `Running ${runPaths.length} script(s)…`);
              for (const path of runPaths) {
                runSuggestedScript(path, true);
              }
            }
            if (dockerRuns.length) {
              setAutoRunStatus(`Running ${dockerRuns.length} script(s) in Docker…`);
              await appendWorkspaceLog(root, `Running ${dockerRuns.length} script(s) in Docker…`);
              for (const r of dockerRuns) {
                runSuggestedDockerScript(r.path, r.image, true);
              }
            }
            if (dockerBuildRuns.length) {
              setAutoRunStatus(`Building and running ${dockerBuildRuns.length} script(s) in Docker…`);
              await appendWorkspaceLog(root, `Building and running ${dockerBuildRuns.length} script(s) in Docker…`);
              for (const r of dockerBuildRuns) {
                runSuggestedDockerBuildScript(r.path, r.dockerfile, true);
              }
            }
            if (readPaths.length > 0) {
              const readContents: Record<string, string> = {};
              for (const p of readPaths) {
                try {
                  readContents[p] = await readWorkspaceFile(root, p);
                } catch {
                  readContents[p] = "(failed to read file)";
                }
              }
              const readSummary = readPaths
                .map((p) => `Content of ${p}:\n\`\`\`\n${readContents[p]}\n\`\`\``)
                .join("\n\n");
              const readUserMessage: Message = { role: "user", content: `[Tool result: file contents]\n${readSummary}` };
              const conversationWithRead: Message[] = [
                ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
                ...messages,
                userMessage,
                { role: "assistant", content: resultContent },
                readUserMessage,
              ];
              setMessages((prev) => [...prev, readUserMessage, { role: "assistant", content: "" }]);
              try {
                if (streaming) {
                  const second = await chatStream({
                    apiKey,
                    model,
                    messages: conversationWithRead,
                    maxTokens: 4096,
                    onChunk: (delta) => {
                      setMessages((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
                        return next;
                      });
                    },
                    onUsage: setLastUsage,
                  });
                  setMessages((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last?.role === "assistant") next[next.length - 1] = { ...last, content: second.content };
                    return next;
                  });
                  if (second.usage) setLastUsage(second.usage);
                  const modelLog = second.content.length > 100000 ? second.content.slice(0, 100000) + "\n... (truncated)" : second.content;
                  appendWorkspaceLog(root, "=== Model (read follow-up) ===\n" + modelLog).catch(() => {});
                } else {
                  const second = await chat({
                    apiKey,
                    model,
                    messages: conversationWithRead,
                    maxTokens: 4096,
                  });
                  setMessages((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last?.role === "assistant") next[next.length - 1] = { ...last, content: second.content };
                    return next;
                  });
                  if (second.usage) setLastUsage(second.usage);
                  const modelLog = second.content.length > 100000 ? second.content.slice(0, 100000) + "\n... (truncated)" : second.content;
                  appendWorkspaceLog(root, "=== Model (read follow-up) ===\n" + modelLog).catch(() => {});
                }
              } catch (readErr) {
                setMessages((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last?.role === "assistant" && last.content === "")
                    next[next.length - 1] = { ...last, content: "Error (read follow-up): " + (readErr instanceof Error ? readErr.message : String(readErr)) };
                  return next;
                });
              }
            }
            await appendWorkspaceLog(root, "Auto-apply finished");
          } catch (e) {
            await appendWorkspaceLog(root, `Auto-apply error: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            setAutoRunStatus(null);
          }
        })();
      }
      if (readPaths.length > 0 && workspaceRoot && !autoApplyAndRun) {
        const readContents: Record<string, string> = {};
        for (const p of readPaths) {
          try {
            readContents[p] = await readWorkspaceFile(workspaceRoot, p);
          } catch {
            readContents[p] = "(failed to read file)";
          }
        }
        const readSummary = readPaths
          .map((p) => `Content of ${p}:\n\`\`\`\n${readContents[p]}\n\`\`\``)
          .join("\n\n");
        const readUserMessage: Message = { role: "user", content: `[Tool result: file contents]\n${readSummary}` };
        const conversationWithRead: Message[] = [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          ...messages,
          userMessage,
          { role: "assistant", content: resultContent },
          readUserMessage,
        ];
        setMessages((prev) => [...prev, readUserMessage, { role: "assistant", content: "" }]);
        try {
          if (streaming) {
            const second = await chatStream({
              apiKey,
              model,
              messages: conversationWithRead,
              maxTokens: 4096,
              onChunk: (delta) => {
                setMessages((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
                  return next;
                });
              },
              onUsage: setLastUsage,
            });
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: second.content };
              return next;
            });
            if (second.usage) setLastUsage(second.usage);
            const modelLog = second.content.length > 100000 ? second.content.slice(0, 100000) + "\n... (truncated)" : second.content;
            if (workspaceRoot) appendWorkspaceLog(workspaceRoot, "=== Model (read follow-up) ===\n" + modelLog).catch(() => {});
          } else {
            const second = await chat({
              apiKey,
              model,
              messages: conversationWithRead,
              maxTokens: 4096,
            });
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: second.content };
              return next;
            });
            if (second.usage) setLastUsage(second.usage);
            const modelLog = second.content.length > 100000 ? second.content.slice(0, 100000) + "\n... (truncated)" : second.content;
            if (workspaceRoot) appendWorkspaceLog(workspaceRoot, "=== Model (read follow-up) ===\n" + modelLog).catch(() => {});
          }
        } catch (readErr) {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && last.content === "")
              next[next.length - 1] = { ...last, content: "Error (read follow-up): " + (readErr instanceof Error ? readErr.message : String(readErr)) };
            return next;
          });
        }
      }
    } catch (err) {
      const errContent = "Error: " + (err instanceof Error ? err.message : String(err));
      setLastFailedUserMessage(text);
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          next[next.length - 1] = { ...last, content: errContent };
          return next;
        }
        return [...prev, { role: "assistant" as const, content: errContent }];
      });
    } finally {
      setLoading(false);
    }
  };

  const applyEdit = async (index: number, edit: FileEdit) => {
    if (!workspaceRoot) {
      setApplyStatus((s) => ({ ...s, [index]: "err" }));
      setApplyError((e) => ({ ...e, [index]: "Pick a workspace first." }));
      return;
    }
    setApplyError((e) => ({ ...e, [index]: "" }));
    try {
      await applyFileEdit(workspaceRoot, edit.path, edit.content);
      setApplyStatus((s) => ({ ...s, [index]: "ok" }));
      setRunOutput((o) => ({ ...o, [index]: null }));
    } catch (e) {
      setApplyStatus((s) => ({ ...s, [index]: "err" }));
      setApplyError((err) => ({ ...err, [index]: e instanceof Error ? e.message : String(e) }));
    }
  };

  const runScript = async (index: number, edit: FileEdit) => {
    if (!workspaceRoot || applyStatus[index] !== "ok") return;
    if (confirmBeforeRun) {
      const ok = await confirm(`Run script "${edit.path}" in the workspace?`, { title: "Run script", kind: "info" });
      if (!ok) return;
    }
    setRunLoading((l) => ({ ...l, [index]: true }));
    setRunOutput((o) => ({ ...o, [index]: null }));
    try {
      const result = await runWorkspaceScript(workspaceRoot, edit.path, undefined, "edit:" + index);
      setRunOutput((o) => ({ ...o, [index]: result }));
    } catch (e) {
      setRunOutput((o) => ({
        ...o,
        [index]: {
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          exit_code: -1,
        },
      }));
    } finally {
      setRunLoading((l) => ({ ...l, [index]: false }));
    }
  };

  const refreshWorkspaceFiles = async () => {
    if (!workspaceRoot) return;
    try {
      const names = await listWorkspaceDir(workspaceRoot, ".");
      setWorkspaceFiles(names);
    } catch {
      setWorkspaceFiles([]);
    }
  };

  const runFileInWorkspace = async () => {
    const path = runFilePath.trim();
    if (!workspaceRoot || !path) return;
    if (confirmBeforeRun) {
      const ok = await confirm(`Run script "${path}" in the workspace?`, { title: "Run script", kind: "info" });
      if (!ok) return;
    }
    setRunFileLoading(true);
    setRunFileOutput(null);
    try {
      const result = await runWorkspaceScript(workspaceRoot, path, undefined, "manual:" + path);
      setRunFileOutput(result);
    } catch (e) {
      setRunFileOutput({
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exit_code: -1,
      });
    } finally {
      setRunFileLoading(false);
    }
  };

  const removeFileInWorkspace = async () => {
    const path = runFilePath.trim();
    if (!workspaceRoot || !path) return;
    setRemoveError("");
    const ok = await confirm(
      `Remove "${path}" from workspace? This cannot be undone.`,
      { title: "Remove file", kind: "warning" }
    );
    if (!ok) return;
    try {
      await removeWorkspaceFile(workspaceRoot, path);
      setRunFilePath("");
      setRunFileOutput(null);
      refreshWorkspaceFiles();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    }
  };

  const applyRemove = async (index: number, path: string) => {
    if (!workspaceRoot) return;
    const ok = await confirm(
      `Remove "${path}" from workspace? This cannot be undone.`,
      { title: "Remove file", kind: "warning" }
    );
    if (!ok) return;
    try {
      await removeWorkspaceFile(workspaceRoot, path);
      setRemoveStatus((s) => ({ ...s, [index]: "ok" }));
      refreshWorkspaceFiles();
    } catch (e) {
      setRemoveStatus((s) => ({ ...s, [index]: "err" }));
    }
  };

  const runPipRequirements = async (path: string) => {
    if (!workspaceRoot) return;
    const key = `req:${path}`;
    setPipInstallLoading((l) => ({ ...l, [key]: true }));
    setPipInstallOutput((o) => ({ ...o, [key]: null }));
    try {
      const result = await runPipInstallRequirements(workspaceRoot, path);
      setPipInstallOutput((o) => ({ ...o, [key]: result }));
    } catch (e) {
      setPipInstallOutput((o) => ({
        ...o,
        [key]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
      }));
    } finally {
      setPipInstallLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const runPipPackages = async (packagesStr: string) => {
    if (!workspaceRoot) return;
    const key = `pkg:${packagesStr}`;
    setPipInstallLoading((l) => ({ ...l, [key]: true }));
    setPipInstallOutput((o) => ({ ...o, [key]: null }));
    try {
      const result = await runPipInstallPackages(workspaceRoot, packagesStr);
      setPipInstallOutput((o) => ({ ...o, [key]: result }));
    } catch (e) {
      setPipInstallOutput((o) => ({
        ...o,
        [key]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
      }));
    } finally {
      setPipInstallLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const runSuggestedScript = async (path: string, skipConfirm = false) => {
    if (!workspaceRoot) return;
    if (!skipConfirm && confirmBeforeRun) {
      const ok = await confirm(`Run script "${path}" in the workspace?`, { title: "Run script", kind: "info" });
      if (!ok) return;
    }
    setRunRequestLoading((l) => ({ ...l, [path]: true }));
    setRunRequestOutput((o) => ({ ...o, [path]: null }));
    try {
      const result = await runWorkspaceScript(workspaceRoot, path, undefined, "suggested:" + path);
      setRunRequestOutput((o) => ({ ...o, [path]: result }));
    } catch (e) {
      setRunRequestOutput((o) => ({
        ...o,
        [path]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
      }));
    } finally {
      setRunRequestLoading((l) => ({ ...l, [path]: false }));
    }
  };

  const dockerRunKey = (image: string, path: string) => `${image}|${path}`;

  const runSuggestedDockerScript = async (path: string, image: string, skipConfirm = false) => {
    if (!workspaceRoot) return;
    if (!skipConfirm && confirmBeforeRun) {
      const ok = await confirm(`Run "${path}" in Docker image ${image}?`, { title: "Run in Docker", kind: "info" });
      if (!ok) return;
    }
    const key = dockerRunKey(image, path);
    setRunDockerLoading((l) => ({ ...l, [key]: true }));
    setRunDockerOutput((o) => ({ ...o, [key]: null }));
    try {
      const result = await runWorkspaceScriptDocker(workspaceRoot, path, image, "docker:" + key);
      if (result.exit_code !== -2) setRunDockerOutput((o) => ({ ...o, [key]: result }));
    } catch (e) {
      setRunDockerOutput((o) => ({
        ...o,
        [key]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
      }));
    } finally {
      setRunDockerLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const dockerBuildRunKey = (path: string, dockerfile?: string) => (dockerfile ? `${dockerfile}|${path}` : path);

  const runSuggestedDockerBuildScript = async (path: string, dockerfile?: string, skipConfirm = false) => {
    if (!workspaceRoot) return;
    if (!skipConfirm && confirmBeforeRun) {
      const ok = await confirm(
        `Build image from ${dockerfile ?? "Dockerfile"} and run "${path}"?`,
        { title: "Build & run in Docker", kind: "info" }
      );
      if (!ok) return;
    }
    const key = dockerBuildRunKey(path, dockerfile);
    setRunDockerBuildLoading((l) => ({ ...l, [key]: true }));
    setRunDockerBuildOutput((o) => ({ ...o, [key]: null }));
    try {
      const result = await runWorkspaceScriptDockerBuild(
        workspaceRoot,
        path,
        dockerfile ?? undefined,
        "dockerbuild:" + key
      );
      if (result.exit_code !== -2) setRunDockerBuildOutput((o) => ({ ...o, [key]: result }));
    } catch (e) {
      setRunDockerBuildOutput((o) => ({
        ...o,
        [key]: { stdout: "", stderr: e instanceof Error ? e.message : String(e), exit_code: -1 },
      }));
    } finally {
      setRunDockerBuildLoading((l) => ({ ...l, [key]: false }));
    }
  };

  const buildToolResultsSummary = (): string => {
    const parts: string[] = [];
    Object.entries(listResults).forEach(([path, names]) => {
      parts.push(`List ${path}: ${names.length ? names.join(", ") : "(empty)"}`);
    });
    Object.entries(runRequestOutput).forEach(([path, out]) => {
      if (out == null) return;
      parts.push(`Run ${path}: exit ${out.exit_code}${out.stdout ? "\nstdout:\n" + out.stdout : ""}${out.stderr ? "\nstderr:\n" + out.stderr : ""}`);
    });
    Object.entries(runDockerOutput).forEach(([key, out]) => {
      if (out == null) return;
      const [img, path] = key.includes("|") ? key.split("|") : ["", key];
      parts.push(`Docker ${img} ${path}: exit ${out.exit_code}${out.stdout ? "\nstdout:\n" + out.stdout : ""}${out.stderr ? "\nstderr:\n" + out.stderr : ""}`);
    });
    Object.entries(runDockerBuildOutput).forEach(([key, out]) => {
      if (out == null) return;
      parts.push(`Docker build+run ${key}: exit ${out.exit_code}${out.stdout ? "\nstdout:\n" + out.stdout : ""}${out.stderr ? "\nstderr:\n" + out.stderr : ""}`);
    });
    Object.entries(pipInstallOutput).forEach(([key, out]) => {
      if (out == null) return;
      const label = key.startsWith("req:") ? `pip -r ${key.slice(4)}` : `pip ${key.slice(4)}`;
      parts.push(`${label}: exit ${out.exit_code}${out.stderr ? "\n" + out.stderr : ""}`);
    });
    pendingEdits.forEach((edit, i) => {
      if (applyStatus[i] === "ok") {
        parts.push(`File ${edit.path}: applied`);
        const ro = runOutput[i];
        if (ro != null) parts.push(`  Run output: exit ${ro.exit_code}${ro.stdout ? "\n" + ro.stdout : ""}${ro.stderr ? "\n" + ro.stderr : ""}`);
      }
    });
    if (parts.length === 0) return "No tool results yet.";
    return "[Tool results]\n" + parts.join("\n\n");
  };

  const hasToolResults =
    Object.keys(listResults).length > 0 ||
    Object.keys(runRequestOutput).some((k) => runRequestOutput[k] != null) ||
    Object.keys(runDockerOutput).some((k) => runDockerOutput[k] != null) ||
    Object.keys(runDockerBuildOutput).some((k) => runDockerBuildOutput[k] != null) ||
    Object.keys(pipInstallOutput).some((k) => pipInstallOutput[k] != null) ||
    pendingEdits.some((_, i) => applyStatus[i] === "ok");

  const sendContinue = async () => {
    if (!apiKey || !hasToolResults) return;
    const toolSummary = buildToolResultsSummary();
    const userMessage: Message = { role: "user", content: toolSummary };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    let systemPrompt = agenticMode ? AGENTIC_SYSTEM : undefined;
    if (systemPrompt) {
      systemPrompt =
        systemPrompt +
        "\n\nThe user's currently selected chat model is: " +
        model +
        ". If they ask which model is selected, what model is being used, or similar, answer with this model name.";
    }
    const chatMessages: Message[] = [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...messages,
      userMessage,
    ];
    try {
      if (streaming) {
        const result = await chatStream({
          apiKey,
          model,
          messages: chatMessages,
          maxTokens: 4096,
          onChunk: (delta) => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
              return next;
            });
          },
          onUsage: setLastUsage,
        });
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: result.content };
          persistSessionSnapshot(next);
          return next;
        });
        if (result.usage) setLastUsage(result.usage);
      } else {
        const result = await chat({
          apiKey,
          model,
          messages: chatMessages,
          maxTokens: 4096,
        });
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: result.content };
          persistSessionSnapshot(next);
          return next;
        });
        if (result.usage) setLastUsage(result.usage);
      }
    } catch (err) {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.content === "")
          next[next.length - 1] = { ...last, content: "Error: " + (err instanceof Error ? err.message : String(err)) };
        return next;
      });
    } finally {
      setLoading(false);
    }
  };

  const applyRemoveAll = async (dirPath: string) => {
    if (!workspaceRoot) return;
    const names = removeAllItems[dirPath] || [];
    if (names.length === 0) {
      setRemoveAllStatus((s) => ({ ...s, [dirPath]: "done" }));
      setPendingRemoveAllPaths((p) => p.filter((x) => x !== dirPath));
      return;
    }
    const relPath = dirPath === "." ? "" : dirPath + "/";
    const ok = await confirm(
      `Remove all ${names.length} item(s) in "${dirPath === "." ? "(workspace root)" : dirPath}"? This cannot be undone.\n\n${names.slice(0, 15).join(", ")}${names.length > 15 ? "…" : ""}`,
      { title: "Remove all", kind: "warning" }
    );
    if (!ok) return;
    let err = false;
    for (const name of names) {
      const fullPath = relPath ? relPath + name : name;
      try {
        await removeWorkspaceFile(workspaceRoot, fullPath);
      } catch {
        err = true;
      }
    }
    setRemoveAllStatus((s) => ({ ...s, [dirPath]: err ? "err" : "done" }));
    refreshWorkspaceFiles();
  };

  return (
    <main className="app">
      <header className="header">
        <h1>Agentic OCR GPT</h1>
        <div className="header-controls">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={agenticMode}
              onChange={(e) => setAgenticMode(e.target.checked)}
            />
            Agentic (file edits)
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={streaming}
              onChange={(e) => setStreaming(e.target.checked)}
            />
            Stream
          </label>
          <label className="checkbox" title="Ask for confirmation before running any script">
            <input
              type="checkbox"
              checked={confirmBeforeRun}
              onChange={(e) => setConfirmBeforeRun(e.target.checked)}
            />
            Confirm before run
          </label>
          <label className="checkbox" title="Automatically apply file edits and run suggested scripts (agent runs on its own)">
            <input
              type="checkbox"
              checked={autoApplyAndRun}
              onChange={(e) => setAutoApplyAndRun(e.target.checked)}
            />
            Auto-apply &amp; run
          </label>
          {lastUsage && (
            <span className="token-usage" title="Last response token usage">
              Tokens: {lastUsage.prompt_tokens} in / {lastUsage.completion_tokens} out
            </span>
          )}
          <select
            value={availableModels.includes(model) ? model : (availableModels[0] ?? "")}
            onChange={(e) => saveModel(e.target.value)}
            aria-label="Model"
            disabled={modelsLoading}
            title={modelsLoading ? "Loading models from API…" : "Model (from Groq API)"}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            type="password"
            placeholder="Groq API key"
            value={apiKey}
            onChange={(e) => saveApiKey(e.target.value)}
            className="api-key-input"
          />
          {apiKey && (
            <button
              type="button"
              className="btn small"
              onClick={clearApiKey}
              title="Clear API key from this device"
            >
              Clear key
            </button>
          )}
          <button type="button" onClick={pickWorkspace} className="btn">
            {workspaceRoot ? "Workspace: " + workspaceRoot.replace(/^.*[/\\]/, "") : "Pick workspace"}
          </button>
          {workspaceRoot && (
            <button
              type="button"
              onClick={clearWorkspace}
              className="btn small"
              title="Clear selected workspace"
            >
              Clear workspace
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className="btn help-btn"
            title="Show help and capabilities"
            aria-expanded={showHelp}
          >
            {showHelp ? "Hide help" : "Help"}
          </button>
          {sessions.length > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => setShowHistory(true)}
              title="View or manage previous conversations"
            >
              History
            </button>
          )}
        </div>
      </header>

      {showHelp && (
        <section className="help-section" aria-label="Help and capabilities">
          <h2 className="help-title">Capabilities &amp; usage</h2>
          <p className="help-intro">
            This app is an <strong>agentic AI assistant</strong> with a local workspace. You chat with a Groq-powered model; when you ask for files, runs, or installs, the app parses the reply and performs the actions (create/edit files, list, remove, read, run scripts, pip install).
          </p>
          <div className="help-grid">
            <div className="help-block">
              <h3>Workspace</h3>
              <p>Pick a folder as your workspace. All file paths are relative to it. You can list files, create/edit/remove files, read files, and run scripts (.py, .js, .sh, .ts) there.</p>
            </div>
            <div className="help-block">
              <h3>Chat &amp; agentic mode</h3>
              <p>Enter your <strong>Groq API key</strong> and choose a model. With <strong>Agentic (file edits)</strong> on, the model can output special blocks that the app turns into actions: create files, remove files, list dir, remove all, read file, run script, install pip packages. Pip installs run automatically; file edits and runs need Apply/Run (or use <strong>Continue</strong> after to get a follow-up).</p>
            </div>
            <div className="help-block">
              <h3>What you can ask for</h3>
              <ul>
                <li><strong>Create/save a file</strong> → model outputs <code>file:path</code>; you Apply to write.</li>
                <li><strong>Remove a file</strong> → <code>remove:path</code>; confirm to delete.</li>
                <li><strong>List files</strong> → <code>list:.</code> or <code>list:subfolder</code>; app shows the real list.</li>
                <li><strong>Remove all</strong> → <code>remove-all:.</code>; confirm to clear.</li>
                <li><strong>Read a file</strong> → <code>read:path</code>; app reads and sends content in a follow-up turn.</li>
                <li><strong>Run a script</strong> → <code>run:path</code>; use the Suggested runs Run button (or Run file in workspace).</li>
                <li><strong>Run in Docker</strong> → <code>run-docker:image path</code> (e.g. <code>run-docker:python:3.11 script.py</code>); workspace is mounted at /workspace. Docker must be installed.</li>
                <li><strong>Reproducible (build + run)</strong> → <code>run-docker-build:script</code> (e.g. script.py, main.c, Main.java); builds image from workspace Dockerfile then runs (or compiles and runs) the script. Put a Dockerfile in the workspace first (or ask the agent to create one).</li>
                <li><strong>Install deps</strong> → <code>install-requirements:requirements.txt</code> or <code>pip-install: pkg1 pkg2</code>; runs automatically. If the workspace has a <code>.venv</code>, pip and Python scripts use it.</li>
                <li><strong>Python virtual env</strong> → <code>create-venv:.venv</code>; app creates a venv. After that, pip installs and Python runs use it automatically.</li>
                <li><strong>Script that needs packages</strong> — Ask e.g. &quot;a script that uses requests&quot;; with <strong>Auto-apply &amp; run</strong> on, the agent will create venv → install deps → create script → run it in order.</li>
              </ul>
            </div>
            <div className="help-block">
              <h3>Options</h3>
              <ul>
                <li><strong>Stream</strong> — show the reply as it’s generated (default on).</li>
                <li><strong>Confirm before run</strong> — ask before executing any script (safety).</li>
                <li><strong>Auto-apply &amp; run</strong> — when on, the agent creates files and runs suggested scripts automatically (no Apply/Run clicks). Pip and venv already run automatically.</li>
                <li><strong>Workspace log</strong> — when the agent runs, it writes to <code>.agentic.log</code> in your workspace. Use <code>tail -f .agentic.log</code> in a terminal to watch progress in real time.</li>
                <li><strong>Continue (multi-step)</strong> — after listing/running/installing, click to send tool results back to the model for a summary or next steps.</li>
              </ul>
            </div>
            <div className="help-block">
              <h3>OCR</h3>
              <p>Use <strong>OCR from image</strong> to extract text from an image; it’s appended to your message so you can ask the model about it.</p>
            </div>
          </div>
        </section>
      )}

      <section className="ocr-bar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={runOcr}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => fileInputRef.current?.click()}
        >
          📷 OCR from image
        </button>
        {ocrText && (
          <div className="ocr-preview">
            <small>Extracted: {ocrText.slice(0, 120)}{ocrText.length > 120 ? "…" : ""}</small>
          </div>
        )}
      </section>

      {workspaceRoot && (
        <section className="run-file-section">
          <h3 className="run-file-heading">Run file in workspace</h3>
          <p className="run-file-hint">Run any script already in your workspace (.py, .js, .sh, .ts)</p>
          <div className="run-file-row">
            <input
              type="text"
              className="run-file-input"
              value={runFilePath}
              onChange={(e) => setRunFilePath(e.target.value)}
              placeholder="e.g. hanoi.py or scripts/hello.js"
              onKeyDown={(e) => e.key === "Enter" && runFileInWorkspace()}
            />
            <button
              type="button"
              className="btn small"
              onClick={refreshWorkspaceFiles}
              title="List files in workspace root"
            >
              List
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={runFileInWorkspace}
              disabled={!runFilePath.trim() || runFileLoading}
            >
              {runFileLoading ? "Running…" : "Run"}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={removeFileInWorkspace}
              disabled={!runFilePath.trim()}
              title="Remove file or folder from workspace"
            >
              Remove
            </button>
          </div>
          {removeError && <p className="edit-error">{removeError}</p>}
          {workspaceFiles.length > 0 && (
            <div className="workspace-file-list">
              {workspaceFiles.map((name) => (
                <span key={name} className="workspace-file-chip-wrap">
                  <button
                    type="button"
                    className="workspace-file-chip"
                    onClick={() => setRunFilePath(name)}
                    title={name}
                  >
                    {name}
                  </button>
                  <button
                    type="button"
                    className="workspace-file-remove"
                    onClick={async () => {
                      const ok = await confirm(
                        `Remove "${name}" from workspace? This cannot be undone.`,
                        { title: "Remove", kind: "warning" }
                      );
                      if (!ok || !workspaceRoot) return;
                      try {
                        await removeWorkspaceFile(workspaceRoot, name);
                        setRemoveError("");
                        refreshWorkspaceFiles();
                        if (runFilePath === name) setRunFilePath("");
                      } catch (e) {
                        setRemoveError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                    title={`Remove ${name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {runFileOutput != null && (
            <div className="run-output run-file-output">
              {runFileOutput.interpreter_used != null && runFileOutput.interpreter_used !== "" && (
                <span className="run-env" title="Environment used to run the script">
                  Environment: {runFileOutput.interpreter_used}
                </span>
              )}
              {runFileOutput.stdout && (
                <pre className="run-stdout">{runFileOutput.stdout}</pre>
              )}
              {runFileOutput.stderr && (
                <pre className="run-stderr">{runFileOutput.stderr}</pre>
              )}
              <span className="run-exit">Exit code: {runFileOutput.exit_code}</span>
            </div>
          )}
        </section>
      )}

      <div className="chat-area">
        <div className="messages">
          {messages.map((m, i) => (
            <div key={i} className={"message " + m.role}>
              <strong>{m.role === "user" ? "You" : "Assistant"}:</strong>
              <pre className="message-content">{m.content}</pre>
            </div>
          ))}
          {loading && <div className="message assistant">Thinking…</div>}
          {autoRunStatus && (
            <div className="message assistant auto-run-status" role="status">
              <strong>Agent:</strong> {autoRunStatus}
            </div>
          )}
        </div>

        {pendingCreateVenv.length > 0 && workspaceRoot && (
          <div className="pending-edits create-venv-section">
            <h3>Create virtual env</h3>
            {pendingCreateVenv.map((path) => {
              const loading = createVenvLoading[path];
              const output = createVenvOutput[path];
              return (
                <div key={path} className="edit-card">
                  <code className="edit-path">python3 -m venv {path}</code>
                  {output != null && (
                    <div className="run-output">
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                  {loading && <span className="run-exit">Creating…</span>}
                </div>
              );
            })}
          </div>
        )}

        {pendingRunPaths.length > 0 && workspaceRoot && (
          <div className="pending-edits suggested-runs-section">
            <h3>Suggested runs</h3>
            {pendingRunPaths.map((path) => {
              const loading = runRequestLoading[path];
              const output = runRequestOutput[path];
              return (
                <div key={path} className="edit-card">
                  <code className="edit-path">{path}</code>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => runSuggestedScript(path)}
                    disabled={loading}
                  >
                    {loading ? "Running…" : "Run"}
                  </button>
                  {output != null && (
                    <div className="run-output">
                      {output.interpreter_used != null && output.interpreter_used !== "" && (
                        <span className="run-env" title="Environment used to run the script">
                          Environment: {output.interpreter_used}
                        </span>
                      )}
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pendingDockerRuns.length > 0 && workspaceRoot && (
          <div className="pending-edits suggested-runs-section">
            <h3>Suggested runs (Docker)</h3>
            {pendingDockerRuns.map((r) => {
              const key = dockerRunKey(r.image, r.path);
              const loading = runDockerLoading[key];
              const output = runDockerOutput[key];
              return (
                <div key={key} className="edit-card">
                  <code className="edit-path">{r.path}</code>
                  <span className="run-docker-image" title="Docker image">{r.image}</span>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => runSuggestedDockerScript(r.path, r.image)}
                    disabled={loading}
                  >
                    {loading ? "Running…" : "Run in Docker"}
                  </button>
                  {output != null && (
                    <div className="run-output">
                      {output.interpreter_used != null && output.interpreter_used !== "" && (
                        <span className="run-env">{output.interpreter_used}</span>
                      )}
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pendingDockerBuildRuns.length > 0 && workspaceRoot && (
          <div className="pending-edits suggested-runs-section">
            <h3>Suggested runs (Docker build)</h3>
            {pendingDockerBuildRuns.map((r) => {
              const key = dockerBuildRunKey(r.path, r.dockerfile);
              const loading = runDockerBuildLoading[key];
              const output = runDockerBuildOutput[key];
              return (
                <div key={key} className="edit-card">
                  <code className="edit-path">{r.path}</code>
                  <span className="run-docker-image" title="Dockerfile">
                    {r.dockerfile ?? "Dockerfile"}
                  </span>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => runSuggestedDockerBuildScript(r.path, r.dockerfile)}
                    disabled={loading}
                  >
                    {loading ? "Building…" : "Build & run"}
                  </button>
                  {output != null && (
                    <div className="run-output">
                      {output.interpreter_used != null && output.interpreter_used !== "" && (
                        <span className="run-env">{output.interpreter_used}</span>
                      )}
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(pendingPipRequirements.length > 0 || pendingPipPackages.length > 0) && workspaceRoot && (
          <div className="pending-edits pip-install-section">
            <h3>Install requirements</h3>
            {pendingPipRequirements.map((path) => {
              const key = `req:${path}`;
              const loading = pipInstallLoading[key];
              const output = pipInstallOutput[key];
              return (
                <div key={key} className="edit-card">
                  <code className="edit-path">pip install -r {path}</code>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => runPipRequirements(path)}
                    disabled={loading}
                  >
                    {loading ? "Installing…" : "Install"}
                  </button>
                  {output != null && (
                    <div className="run-output">
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {pendingPipPackages.map((packagesStr) => {
              const key = `pkg:${packagesStr}`;
              const loading = pipInstallLoading[key];
              const output = pipInstallOutput[key];
              return (
                <div key={key} className="edit-card">
                  <code className="edit-path">pip install {packagesStr}</code>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => runPipPackages(packagesStr)}
                    disabled={loading}
                  >
                    {loading ? "Installing…" : "Install"}
                  </button>
                  {output != null && (
                    <div className="run-output">
                      {output.stdout && <pre className="run-stdout">{output.stdout}</pre>}
                      {output.stderr && <pre className="run-stderr">{output.stderr}</pre>}
                      <span className="run-exit">Exit code: {output.exit_code}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pendingRemoveAllPaths.length > 0 && workspaceRoot && (
          <div className="pending-edits remove-all-section">
            <h3>Remove all files</h3>
            {pendingRemoveAllPaths.map((dirPath) => {
              const names = removeAllItems[dirPath] || [];
              const status = removeAllStatus[dirPath];
              return (
                <div key={dirPath} className="edit-card">
                  <code className="edit-path">{dirPath === "." ? "(workspace root)" : dirPath}</code>
                  <p className="remove-all-count">{names.length} item(s): {names.join(", ") || "(empty)"}</p>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => applyRemoveAll(dirPath)}
                    disabled={status === "done"}
                  >
                    {status === "done" ? "Removed" : status === "err" ? "Some errors" : "Remove all"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {pendingListPaths.length > 0 && workspaceRoot && (
          <div className="pending-edits list-results">
            <h3>Workspace listing</h3>
            {pendingListPaths.map((path) => (
              <div key={path} className="edit-card">
                <code className="edit-path">{path === "." ? "(root)" : path}</code>
                <ul className="list-files">
                  {(listResults[path] || []).length === 0 ? (
                    <li className="list-empty">No files or folders</li>
                  ) : (
                    (listResults[path] || []).map((name) => (
                      <li key={name}>{name}</li>
                    ))
                  )}
                </ul>
              </div>
            ))}
          </div>
        )}

        {pendingRemoves.length > 0 && workspaceRoot && (
          <div className="pending-edits pending-removes">
            <h3>Suggested removals</h3>
            {pendingRemoves.map((path, i) => (
              <div key={i} className="edit-card">
                <code className="edit-path">{path}</code>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => applyRemove(i, path)}
                  disabled={removeStatus[i] === "ok"}
                >
                  {removeStatus[i] === "ok" ? "Removed" : removeStatus[i] === "err" ? "Error" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}

        {pendingEdits.length > 0 && workspaceRoot && (
          <div className="pending-edits">
            <h3>Suggested file changes</h3>
            {pendingEdits.map((edit, i) => (
              <div key={i} className="edit-card">
                <code className="edit-path">{edit.path}</code>
                <pre className="edit-content">{edit.content.slice(0, 200)}{edit.content.length > 200 ? "…" : ""}</pre>
                <div className="edit-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => applyEdit(i, edit)}
                    disabled={applyStatus[i] === "ok"}
                  >
                    {applyStatus[i] === "ok" ? "Applied" : applyStatus[i] === "err" ? "Error" : "Apply"}
                  </button>
                  {isRunnablePath(edit.path) && !pendingDockerBuildRuns.some((r) => r.path === edit.path) && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => runScript(i, edit)}
                      disabled={applyStatus[i] !== "ok" || runLoading[i]}
                      title="Run script (after Apply)"
                    >
                      {runLoading[i] ? "Running…" : "Run"}
                    </button>
                  )}
                  {isRunnablePath(edit.path) && pendingDockerBuildRuns.some((r) => r.path === edit.path) && (
                    <span className="edit-docker-hint" title="Use Build & run in Suggested runs (Docker build) above">
                      Run via Docker build above
                    </span>
                  )}
                </div>
                {applyError[i] && (
                  <p className="edit-error">{applyError[i]}</p>
                )}
                {runOutput[i] != null && (
                  <div className="run-output">
                    {runOutput[i]!.interpreter_used != null && runOutput[i]!.interpreter_used !== "" && (
                      <span className="run-env" title="Environment used to run the script">
                        Environment: {runOutput[i]!.interpreter_used}
                      </span>
                    )}
                    {runOutput[i]!.stdout && (
                      <pre className="run-stdout">{runOutput[i]!.stdout}</pre>
                    )}
                    {runOutput[i]!.stderr && (
                      <pre className="run-stderr">{runOutput[i]!.stderr}</pre>
                    )}
                    <span className="run-exit">Exit code: {runOutput[i]!.exit_code}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {hasToolResults && (
          <div className="continue-bar">
            <button
              type="button"
              className="btn small"
              onClick={sendContinue}
              disabled={loading}
              title="Send tool results (list/run/pip/applied edits) back to the model for a follow-up reply"
            >
              {loading ? "…" : "Continue (multi-step)"}
            </button>
          </div>
        )}

        <form
          className="input-row"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type or paste OCR text, then ask for file edits..."
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={loading}>
            Send
          </button>
          {lastFailedUserMessage != null && (
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => send(lastFailedUserMessage, true)}
              title="Resubmit the last message after a failed response"
            >
              Resubmit
            </button>
          )}
        </form>
      </div>
      {showHistory && (
        <div className="history-overlay" onClick={() => setShowHistory(false)}>
          <div
            className="history-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Conversation history"
          >
            <div className="history-header">
              <h3>Conversation history</h3>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  startNewSession();
                  setShowHistory(false);
                }}
              >
                New chat
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => setShowHistory(false)}
              >
                Close
              </button>
            </div>
            {sessions.length === 0 ? (
              <p className="history-empty">No previous conversations yet.</p>
            ) : (
              <div className="history-list">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={
                      "history-item" +
                      (s.id === currentSessionId ? " active" : "")
                    }
                  >
                    <button
                      type="button"
                      className="history-title"
                      onClick={() => {
                        openSession(s.id);
                        setShowHistory(false);
                      }}
                      title={s.title}
                    >
                      {s.title}
                    </button>
                    <div className="history-meta">
                      <span>
                        {new Date(s.updatedAt || s.createdAt).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        className="history-delete"
                        onClick={() => deleteSession(s.id)}
                        title="Delete conversation"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
