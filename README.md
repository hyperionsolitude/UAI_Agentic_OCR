# Agentic OCR GPT

A **free and open source** desktop app that brings [OCR_GPT](https://github.com/hyperionsolitude/OCR_GPT)-style OCR + AI to the desktop and adds **agentic file operations**: the AI can suggest creating or editing files in your workspace, and you can apply those changes with one click.

- **OCR**: Extract text from images (Tesseract.js).
- **AI chat**: Groq API (same as OCR_GPT); conversation history and model selection.
- **Agentic mode**: When enabled, the model can output file edits in a structured format; you pick a workspace folder and apply changes safely.

## Prerequisites

Install these before building or developing:

| Prerequisite | Purpose | Install |
|-------------|---------|---------|
| **Node.js** (LTS) | Frontend (React, Vite) and npm | [nodejs.org](https://nodejs.org/) or `nvm install --lts` |
| **Rust** | Tauri desktop backend | [rustup.rs](https://rustup.rs/) — run `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Groq API key** | AI chat (no install) | [console.groq.com](https://console.groq.com/) — paste in app on first run |

Optional (for agentic “create and run” examples):

| Optional | Purpose |
|----------|---------|
| **Docker Desktop** | Run Python/C/Java scripts in containers (recommended). [docker.com](https://www.docker.com/products/docker-desktop) |
| **Xcode Command Line Tools** (macOS) | C/C++ fallback when Docker isn’t used: `xcode-select --install` |
| **JDK** (e.g. OpenJDK) | Java fallback when Docker isn’t used: `brew install openjdk` |

## Quick start

**Option A — automated setup (macOS):**

```bash
git clone https://github.com/hyperionsolitude/UAI_Agentic_OCR.git
cd UAI_Agentic_OCR
./scripts/setup-dev.sh              # install Node, Rust, run npm install
./scripts/setup-dev.sh --all         # also install Docker, Java, Xcode CLI (optional)
```

**Option B — manual:**

```bash
git clone https://github.com/hyperionsolitude/UAI_Agentic_OCR.git
cd UAI_Agentic_OCR
npm install
npm run tauri dev
```

On first run, enter your Groq API key in the header. Pick a **workspace** folder when you want to use agentic file edits.

To build a release app (macOS: `.app` + DMG):

```bash
npm run tauri build
# Or use the helper script (build + launch .app):
./rebuild-and-run.sh
```

## Usage

1. **OCR**: Click “OCR from image” and select an image; extracted text is added to the chat input.
2. **Chat**: Type your question (or use OCR text) and send. Choose a model from the dropdown.
3. **Agentic**: Leave “Agentic (file edits)” checked. Ask the AI to create or modify files (e.g. “Create a file `hello.txt` in my workspace with the text Hello World”). The app parses suggested file blocks and shows **Suggested file changes** with an **Apply** button per file.
4. **Workspace**: Click “Pick workspace” and choose the folder where file creation/edits are allowed. Apply only runs for paths under this folder.

## Agentic file format

When agentic mode is on, the system prompt tells the AI to output file changes like this (path is relative to your chosen workspace):

````
```file:path/relative/to/workspace
file content here
```
````

You can have multiple such blocks in one reply. Each appears as a card; **Apply** writes that file under your chosen workspace.

## Tech stack

- **Desktop**: [Tauri 2](https://tauri.app/) (Rust backend, web frontend)
- **Frontend**: React, TypeScript, Vite
- **OCR**: [Tesseract.js](https://tesseract.projectnaptha.com/)
- **AI**: [Groq API](https://console.groq.com/) (OpenAI-compatible)

## License

MIT. See [LICENSE](LICENSE).

---

Inspired by the Android app [OCR_GPT](https://github.com/hyperionsolitude/OCR_GPT).
