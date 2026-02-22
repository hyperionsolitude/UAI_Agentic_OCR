#!/usr/bin/env bash
# Install prerequisites for developing Agentic OCR GPT (UAI_Agentic_OCR).
# Run from repo root: ./scripts/setup-dev.sh [--docker] [--java] [--xcode] [--all]
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OPT_DOCKER=
OPT_JAVA=
OPT_XCODE=
for arg in "$@"; do
  case "$arg" in
    --docker) OPT_DOCKER=1 ;;
    --java)   OPT_JAVA=1 ;;
    --xcode)  OPT_XCODE=1 ;;
    --all)    OPT_DOCKER=1; OPT_JAVA=1; OPT_XCODE=1 ;;
    -h|--help)
      echo "Usage: $0 [--docker] [--java] [--xcode] [--all]"
      echo "  --docker  Install Docker Desktop (optional, for running scripts in containers)"
      echo "  --java    Install OpenJDK (optional, for Java fallback when Docker not used)"
      echo "  --xcode   Install Xcode Command Line Tools (optional, for C/C++ fallback)"
      echo "  --all     Install all optional prerequisites"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

echo "==> Checking prerequisites for UAI_Agentic_OCR (Tauri + React)"

# --- Node.js ---
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "[ok] Node.js $(node -v) and npm $(npm -v) already installed"
else
  echo "[..] Installing Node.js (LTS)..."
  if [[ "$(uname)" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
      if command -v node >/dev/null 2>&1; then
        echo "[ok] Node.js installed via Homebrew"
      else
        echo "    Run: brew link node --force --overwrite  (or add $(brew --prefix)/bin to PATH)"
        exit 1
      fi
    else
      echo "    Install Homebrew first: https://brew.sh"
      echo "    Or install Node from https://nodejs.org (LTS)"
      exit 1
    fi
  else
    echo "    Install Node.js LTS from https://nodejs.org or use nvm"
    exit 1
  fi
fi

# --- Rust ---
if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  echo "[ok] Rust $(rustc -V) already installed"
else
  echo "[..] Installing Rust (rustup)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  . "${HOME}/.cargo/env"
  if command -v cargo >/dev/null 2>&1; then
    echo "[ok] Rust installed; run 'source \$HOME/.cargo/env' or open a new terminal"
  else
    echo "    Run: source \$HOME/.cargo/env"
    exit 1
  fi
fi

# Ensure cargo is on PATH for this script (for npm run tauri later)
export PATH="${HOME}/.cargo/bin:${PATH}"

# --- Optional: Xcode Command Line Tools (macOS) ---
if [[ -n "$OPT_XCODE" ]]; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "[skip] Xcode CLI is macOS-only"
  elif xcode-select -p >/dev/null 2>&1; then
    echo "[ok] Xcode Command Line Tools already installed"
  else
    echo "[..] Installing Xcode Command Line Tools (opens GUI)..."
    xcode-select --install
    echo "    Complete the installer, then re-run this script if needed"
  fi
fi

# --- Optional: Docker ---
if [[ -n "$OPT_DOCKER" ]]; then
  if command -v docker >/dev/null 2>&1; then
    echo "[ok] Docker already installed: $(docker -v)"
  elif [[ "$(uname)" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      echo "[..] Installing Docker (Homebrew cask)..."
      brew install --cask docker
      echo "    Start Docker Desktop from Applications, then re-run this script to verify"
    else
      echo "    Install Docker Desktop from https://www.docker.com/products/docker-desktop"
    fi
  else
    echo "    Install Docker: https://docs.docker.com/engine/install/"
  fi
fi

# --- Optional: Java (OpenJDK) ---
if [[ -n "$OPT_JAVA" ]]; then
  if command -v javac >/dev/null 2>&1 && command -v java >/dev/null 2>&1; then
    echo "[ok] Java already installed: $(java -version 2>&1 | head -1)"
  elif command -v brew >/dev/null 2>&1; then
    echo "[..] Installing OpenJDK..."
    brew install openjdk
    echo "    Add to PATH if needed: sudo ln -sfn \$(brew --prefix)/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk"
  else
    echo "    Install a JDK (e.g. OpenJDK) for Java support"
  fi
fi

# --- npm install ---
echo "[..] Running npm install in repo..."
npm install

echo ""
echo "==> Setup done. Next steps:"
echo "    1. Get a Groq API key: https://console.groq.com/"
echo "    2. Run the app: npm run tauri dev"
echo "    3. Or build release: ./rebuild-and-run.sh"
