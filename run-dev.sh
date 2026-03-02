#!/usr/bin/env bash
# One-shot setup + dev server runner for UAI_Agentic_OCR on Linux.
# Tries, in order:
#   - Use an existing Node.js >= 20.19
#   - Use nvm if installed
#   - On Linux with sudo, install Node.js 22.x via apt (NodeSource)
# Usage: ./run-dev.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

REQUIRED_NODE_MAJOR=20
REQUIRED_NODE_MINOR=19

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_node_linux_apt() {
  if [[ "$(uname)" != "Linux" ]]; then
    return 1
  fi

  if ! have_cmd sudo; then
    echo "[error] 'sudo' is not available; cannot install Node.js automatically."
    echo "        Install Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 manually, then re-run this script."
    exit 1
  fi

  echo "[..] Installing Node.js 22.x via NodeSource (apt) using sudo..."
  echo "    You may be prompted for your password."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

ensure_node_version() {
  if have_cmd node; then
    if node -e "const [M,m]=process.versions.node.split('.').map(Number); if (M > ${REQUIRED_NODE_MAJOR} || (M === ${REQUIRED_NODE_MAJOR} && m >= ${REQUIRED_NODE_MINOR})) process.exit(0); process.exit(1);" ; then
      echo "[ok] Node.js $(node -v) is new enough (>= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0)"
      return 0
    else
      echo "[warn] Node.js $(node -v) is too old; need >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0"
    fi
  else
    echo "[info] Node.js is not installed."
  fi

  # Try to upgrade/install via nvm if available
  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${HOME}/.nvm/nvm.sh"
    echo "[..] Using nvm to install Node.js 22 (recommended)..."
    nvm install 22
    nvm use 22
    echo "[ok] Now using Node.js $(node -v)"
    return 0
  fi

  # Try apt-based installation on Linux
  if [[ "$(uname)" == "Linux" ]]; then
    install_node_linux_apt || true
    if have_cmd node && node -e "const [M,m]=process.versions.node.split('.').map(Number); if (M > ${REQUIRED_NODE_MAJOR} || (M === ${REQUIRED_NODE_MAJOR} && m >= ${REQUIRED_NODE_MINOR})) process.exit(0); process.exit(1);" ; then
      echo "[ok] Node.js $(node -v) installed via apt and is new enough."
      return 0
    fi
  fi

  echo ""
  echo "[error] Suitable Node.js not found and automatic installation failed."
  echo "        Install Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 (or use nvm), then re-run:"
  echo "          curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "          source \"\$HOME/.nvm/nvm.sh\""
  echo "          nvm install 22 && nvm use 22"
  exit 1
}

echo "==> Ensuring compatible Node.js is installed..."
ensure_node_version

echo "==> Installing npm dependencies (if needed)..."
if [[ ! -d node_modules ]]; then
  npm install
else
  echo "[ok] node_modules already present; you can delete it to force a clean install."
fi

echo "==> Starting Vite dev server (npm run dev)..."
echo "    When it finishes starting, open the printed http://localhost:PORT in your browser."
echo ""
npm run dev

