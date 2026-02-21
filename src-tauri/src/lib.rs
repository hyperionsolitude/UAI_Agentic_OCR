// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf, Component};
use std::process::Command;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const AGENTIC_LOG: &str = ".agentic.log";
const MAX_LOG_STREAM: usize = 32768;

/// Paths where Docker is often installed; GUI apps get a minimal PATH.
fn enriched_path_for_docker() -> String {
    let mut extra = String::from("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin");
    if let Ok(home) = env::var("HOME") {
        if !home.is_empty() {
            extra.push_str(&format!(":{}/.docker/bin", home));
        }
    }
    extra.push_str(":/Applications/Docker.app/Contents/Resources/bin");
    let existing = env::var_os("PATH").and_then(|v| v.into_string().ok()).unwrap_or_default();
    if existing.is_empty() {
        extra
    } else {
        format!("{}:{}", extra, existing)
    }
}

/// Resolve the docker binary path. Tries known Docker Desktop locations first so the GUI app
/// finds Docker even when PATH is minimal. Returns None only if docker is not found.
fn resolve_docker_binary() -> Option<PathBuf> {
    // 1. Docker Desktop app bundle (always works if Docker.app is installed)
    let app_bundle = Path::new("/Applications/Docker.app/Contents/Resources/bin/docker");
    if app_bundle.exists() {
        return Some(app_bundle.to_path_buf());
    }
    // 2. User CLI install (Docker Desktop setting: install in ~/.docker/bin)
    if let Ok(home) = env::var("HOME") {
        if !home.is_empty() {
            let user_bin = Path::new(&home).join(".docker/bin/docker");
            if user_bin.exists() {
                return Some(user_bin);
            }
        }
    }
    // 3. System-wide symlink (Docker Desktop default)
    let system_bin = Path::new("/usr/local/bin/docker");
    if system_bin.exists() {
        return Some(system_bin.to_path_buf());
    }
    // 4. Homebrew (e.g. docker from brew)
    let homebrew = Path::new("/opt/homebrew/bin/docker");
    if homebrew.exists() {
        return Some(homebrew.to_path_buf());
    }
    None
}

/// Run docker: use resolved binary path if available, otherwise shell with enriched PATH.
#[cfg(unix)]
fn run_docker(
    path_env: &str,
    args: &[impl AsRef<str>],
    current_dir: Option<&Path>,
) -> std::io::Result<std::process::Output> {
    let args_vec: Vec<String> = args.iter().map(|a| a.as_ref().to_string()).collect();
    if let Some(docker_path) = resolve_docker_binary() {
        let mut c = Command::new(&docker_path);
        for a in &args_vec {
            c.arg(a);
        }
        if let Some(dir) = current_dir {
            c.current_dir(dir);
        }
        return c.output();
    }
    // Fallback: run via login shell with enriched PATH (for custom installs)
    let shell = env::var_os("SHELL")
        .and_then(|s| s.into_string().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut c = Command::new(&shell);
    c.arg("-l")
        .arg("-c")
        .arg("docker \"$@\"")
        .arg("--");
    for a in &args_vec {
        c.arg(a);
    }
    c.env("PATH", path_env);
    if let Some(dir) = current_dir {
        c.current_dir(dir);
    }
    c.output()
}

#[cfg(not(unix))]
fn run_docker(
    path_env: &str,
    args: &[impl AsRef<str>],
    current_dir: Option<&Path>,
) -> std::io::Result<std::process::Output> {
    let mut c = Command::new("docker");
    c.env("PATH", path_env);
    for a in args {
        c.arg(a.as_ref());
    }
    if let Some(dir) = current_dir {
        c.current_dir(dir);
    }
    c.output()
}

/// Extract package names from Dockerfile RUN pip install lines (e.g. "RUN pip install numpy" -> ["numpy"]).
fn pip_packages_from_dockerfile(dockerfile_path: &Path) -> Vec<String> {
    let content = match fs::read_to_string(dockerfile_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut packages = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.to_uppercase().starts_with("RUN") {
            let rest = line.get(3..).unwrap_or("").trim();
            if let Some(idx) = rest.to_lowercase().find("pip install") {
                let after = rest.get(idx + "pip install".len()..).unwrap_or("").trim();
                for word in after.split_whitespace() {
                    let w = word.trim();
                    if !w.is_empty() && !w.starts_with('-') && w != "install" && w != "pip" && w != "&&" {
                        packages.push(w.to_string());
                    }
                }
            }
        }
    }
    packages
}

fn append_workspace_log_path(root: &Path, msg: &str) {
    let Ok(root) = root.canonicalize() else { return };
    let log_path = root.join(AGENTIC_LOG);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("[{}] {}\n", ts, msg);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

fn truncate_log(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!("{}\n... (truncated, {} chars total)", truncated, s.chars().count())
}

fn log_command_result(root: &Path, label: &str, stdout: &str, stderr: &str, exit_code: i32) {
    let so = truncate_log(stdout.trim_end(), MAX_LOG_STREAM);
    let se = truncate_log(stderr.trim_end(), MAX_LOG_STREAM);
    let block = format!("{} (exit {})\n  stdout:\n{}\n  stderr:\n{}", label, exit_code, so, se);
    append_workspace_log_path(root, &block);
}

/// Convert workspace_root string (may be file:// URL from dialog) to a filesystem path.
fn workspace_path_from_input(workspace_root: &str) -> PathBuf {
    let s = workspace_root.trim();
    if s.starts_with("file://") {
        let path_part = s.strip_prefix("file://").unwrap_or(s).trim_start_matches('/');
        PathBuf::from("/").join(path_part)
    } else {
        PathBuf::from(s)
    }
}

/// Normalize relative_path (drop ".." and ".", fix slashes) and return path under workspace.
fn path_under_workspace(workspace_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_workspace = workspace_root.canonicalize().map_err(|e| e.to_string())?;
    let normalized = relative_path.trim().replace('\\', "/").trim_start_matches('/').to_string();
    let rel = Path::new(&normalized);
    let mut safe = PathBuf::new();
    for c in rel.components() {
        match c {
            Component::ParentDir => { safe.pop(); }
            Component::CurDir => {}
            Component::Normal(s) => { safe.push(s); }
            _ => {}
        }
    }
    let full = canonical_workspace.join(safe);
    if full.starts_with(&canonical_workspace) {
        Ok(full)
    } else {
        Err("Path is outside workspace".to_string())
    }
}

#[tauri::command]
fn append_workspace_log(workspace_root: String, message: String) -> Result<(), String> {
    let root = workspace_path_from_input(&workspace_root);
    append_workspace_log_path(&root, &message);
    Ok(())
}

#[tauri::command]
fn read_workspace_file(workspace_root: String, relative_path: String) -> Result<String, String> {
    let root = workspace_path_from_input(&workspace_root);
    let path = path_under_workspace(&root, &relative_path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_workspace_file(workspace_root: String, relative_path: String, content: String) -> Result<(), String> {
    let root = workspace_path_from_input(&workspace_root);
    let path = path_under_workspace(&root, &relative_path)?;
    append_workspace_log_path(&root, &format!("Writing file: {}", relative_path));
    eprintln!("[agentic] Writing file: {}", relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    append_workspace_log_path(&root, &format!("Wrote: {}", relative_path));
    Ok(())
}

#[tauri::command]
fn list_workspace_dir(workspace_root: String, relative_path: String) -> Result<Vec<String>, String> {
    let root = workspace_path_from_input(&workspace_root);
    let path = path_under_workspace(&root, &relative_path)?;
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
fn remove_workspace_file(workspace_root: String, relative_path: String) -> Result<(), String> {
    let root = workspace_path_from_input(&workspace_root);
    let path = path_under_workspace(&root, &relative_path)?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    } else if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        return Err("Not a file or directory".to_string());
    }
    Ok(())
}

/// Path to workspace venv (e.g. .venv). Returns None if not present.
fn workspace_venv_python(workspace_root: &Path) -> Option<PathBuf> {
    let venv_base = workspace_root.join(".venv");
    #[cfg(unix)]
    {
        let venv = venv_base.join("bin").join("python3");
        if venv.exists() {
            return Some(venv);
        }
        let venv_py = venv_base.join("bin").join("python");
        if venv_py.exists() {
            return Some(venv_py);
        }
    }
    #[cfg(windows)]
    {
        let venv = venv_base.join("Scripts").join("python3.exe");
        if venv.exists() {
            return Some(venv);
        }
        let venv_py = venv_base.join("Scripts").join("python.exe");
        if venv_py.exists() {
            return Some(venv_py);
        }
    }
    None
}

/// Creates workspace .venv if missing so Python scripts run inside a venv.
fn ensure_workspace_venv(workspace_root: &Path) -> Result<(), String> {
    if workspace_venv_python(workspace_root).is_some() {
        return Ok(());
    }
    let venv_path = path_under_workspace(workspace_root, ".venv")?;
    if venv_path.exists() {
        return Ok(());
    }
    append_workspace_log_path(workspace_root, "Creating .venv for Python run…");
    let out = Command::new("python3")
        .args(["-m", "venv", venv_path.to_string_lossy().as_ref()])
        .current_dir(workspace_root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Failed to create venv: {}", stderr));
    }
    append_workspace_log_path(workspace_root, "Venv created.");
    Ok(())
}

fn workspace_venv_pip(workspace_root: &Path) -> Option<PathBuf> {
    let venv_base = workspace_root.join(".venv");
    #[cfg(unix)]
    {
        let pip = venv_base.join("bin").join("pip");
        if pip.exists() {
            return Some(pip);
        }
        let pip3 = venv_base.join("bin").join("pip3");
        if pip3.exists() {
            return Some(pip3);
        }
    }
    #[cfg(windows)]
    {
        let pip = venv_base.join("Scripts").join("pip.exe");
        if pip.exists() {
            return Some(pip);
        }
        let pip3 = venv_base.join("Scripts").join("pip3.exe");
        if pip3.exists() {
            return Some(pip3);
        }
    }
    None
}

#[tauri::command]
fn create_venv(workspace_root: String, relative_path: Option<String>) -> Result<RunScriptResult, String> {
    let root = workspace_path_from_input(&workspace_root);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let venv_path = path_under_workspace(&root, relative_path.as_deref().unwrap_or(".venv"))?;
    append_workspace_log_path(&root, &format!("Creating venv: {}", venv_path.display()));
    eprintln!("[agentic] Creating venv at {}", venv_path.display());
    if venv_path.exists() {
        append_workspace_log_path(&root, "Venv already exists");
        eprintln!("[agentic] Venv already exists");
        return Ok(RunScriptResult {
            stdout: format!("Virtual env already exists at {}", venv_path.display()),
            stderr: String::new(),
            exit_code: 0,
            interpreter_used: None,
        });
    }
    let out = Command::new("python3")
        .args(["-m", "venv", venv_path.to_string_lossy().as_ref()])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let code = out.status.code().unwrap_or(-1);
    log_command_result(&root, "Venv created", &stdout, &stderr, code);
    eprintln!("[agentic] Venv created (exit {})", code);
    Ok(RunScriptResult {
        stdout,
        stderr,
        exit_code: code,
        interpreter_used: None,
    })
}

fn interpreter_for_path(path: &Path) -> Option<(&'static str, &'static [&'static str])> {
    let ext = path.extension().and_then(|e| e.to_str())?;
    let ext_lower = ext.to_lowercase();
    Some(match ext_lower.as_str() {
        "py" => ("python3", &[]),
        "js" | "mjs" => ("node", &[]),
        "sh" => ("bash", &[]),
        "ts" => ("npx", &["ts-node"]),
        "c" | "cpp" | "cc" | "cxx" | "java" => return None, // use interpreter_for_docker_run instead
        _ => return None,
    })
}

/// For Docker build+run: returns (interpreter, args) for `docker run ... tag interpreter args`.
/// For compiled languages (C, C++, Java) returns a shell command that compiles and runs.
fn interpreter_for_docker_run(rel_norm: &str) -> Option<(String, Vec<String>)> {
    let path = Path::new(rel_norm);
    let ext = path.extension().and_then(|e| e.to_str())?;
    let ext_lower = ext.to_lowercase();
    Some(match ext_lower.as_str() {
        "py" => ("python3".to_string(), vec![format!("/workspace/{}", rel_norm)]),
        "js" | "mjs" => ("node".to_string(), vec![format!("/workspace/{}", rel_norm)]),
        "sh" => ("bash".to_string(), vec![format!("/workspace/{}", rel_norm)]),
        "ts" => ("npx".to_string(), vec!["ts-node".to_string(), format!("/workspace/{}", rel_norm)]),
        "c" => (
            "sh".to_string(),
            vec!["-c".to_string(), format!("gcc -o /tmp/out /workspace/{} && /tmp/out", rel_norm)],
        ),
        "cpp" | "cc" | "cxx" => (
            "sh".to_string(),
            vec!["-c".to_string(), format!("g++ -o /tmp/out /workspace/{} && /tmp/out", rel_norm)],
        ),
        "java" => {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Main");
            let parent = path.parent().and_then(|p| p.to_str()).unwrap_or(".");
            let cd = if parent.is_empty() || parent == "." {
                "cd /workspace".to_string()
            } else {
                format!("cd /workspace/{}", parent)
            };
            (
                "sh".to_string(),
                vec![
                    "-c".to_string(),
                    format!("javac /workspace/{} && {} && java {}", rel_norm, cd, stem),
                ],
            )
        }
        _ => return None,
    })
}

#[derive(serde::Serialize)]
struct RunScriptResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    /// Human-readable interpreter used (e.g. "workspace .venv" or "system python3").
    #[serde(skip_serializing_if = "Option::is_none")]
    interpreter_used: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct ScriptFinishedPayload {
    run_id: String,
    relative_path: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    interpreter_used: Option<String>,
}

#[tauri::command]
fn run_workspace_script(
    app: tauri::AppHandle,
    workspace_root: String,
    relative_path: String,
    interpreter_override: Option<String>,
    run_id: Option<String>,
) -> Result<RunScriptResult, String> {
    let root = workspace_path_from_input(&workspace_root);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let script_path = {
        let p = path_under_workspace(&root, &relative_path)?;
        if p.exists() {
            p
        } else if relative_path.starts_with(".venv/") || relative_path.starts_with(".venv\\") {
            let stripped = relative_path.trim_start_matches(".venv/").trim_start_matches(".venv\\").trim_start_matches('/');
            path_under_workspace(&root, stripped).ok().and_then(|q| if q.exists() { Some(q) } else { None }).unwrap_or(p)
        } else {
            p
        }
    };
    if !script_path.exists() {
        return Err("Script file does not exist. Apply the file first.".to_string());
    }
    let cwd = script_path
        .parent()
        .ok_or("Invalid script path")?
        .to_path_buf();

    let (program, args): (String, Vec<String>) = if let Some(ref interp) = interpreter_override {
        let interp = interp.trim();
        if interp.is_empty() {
            let (prog, a) = interpreter_for_path(&script_path)
                .ok_or("Unknown script type. Specify interpreter (e.g. python3, node).")?;
            let mut v = a.iter().filter(|s| !s.is_empty()).map(|s| s.to_string()).collect::<Vec<_>>();
            v.push(script_path.to_string_lossy().into_owned());
            (prog.to_string(), v)
        } else {
            let parts: Vec<&str> = interp.split_whitespace().collect();
            let (prog, rest) = parts.split_first().ok_or("Empty interpreter")?;
            let mut v: Vec<String> = rest.iter().map(|s| (*s).to_string()).collect();
            v.push(script_path.to_string_lossy().into_owned());
            ((*prog).to_string(), v)
        }
    } else {
        let (prog, a) = interpreter_for_path(&script_path)
            .ok_or("Unknown script type. Use .py, .js, .sh or specify interpreter.")?;
        let mut v = a.iter().filter(|s| !s.is_empty()).map(|s| s.to_string()).collect::<Vec<_>>();
        v.push(script_path.to_string_lossy().into_owned());
        let program: String = if prog == "python3" {
            // Prefer .venv in script's directory, then workspace root
            let venv_py = workspace_venv_python(&cwd)
                .or_else(|| workspace_venv_python(&root));
            let program = match venv_py {
                Some(p) => p.to_string_lossy().into_owned(),
                None => {
                    ensure_workspace_venv(&root).ok();
                    workspace_venv_python(&root)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| prog.to_string())
                }
            };
            program
        } else {
            prog.to_string()
        };
        (program, v)
    };

    let rel = script_path.strip_prefix(&root).map(|p| p.display().to_string()).unwrap_or_else(|_| relative_path.clone());
    let interpreter_used: Option<String> = if script_path.extension().map(|e| e == "py").unwrap_or(false) {
        if program.contains(".venv") || program.contains("venv") {
            Some("workspace .venv".to_string())
        } else {
            Some("system python3".to_string())
        }
    } else {
        None
    };
    append_workspace_log_path(&root, &format!("Running script: {} ({})", rel, interpreter_used.as_deref().unwrap_or("")));
    eprintln!("[agentic] Running script: {} {:?} (env: {:?})", program, &args, interpreter_used);

    if let Some(id) = run_id {
        let root_bg = root.clone();
        let rel_bg = rel.clone();
        let interp_bg = interpreter_used.clone();
        thread::spawn(move || {
            let out = Command::new(&program)
                .args(&args)
                .current_dir(&cwd)
                .output();
            match out {
                Ok(result) => {
                    let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
                    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
                    let exit_code = result.status.code().unwrap_or(-1);
                    log_command_result(&root_bg, &format!("Script finished: {}", rel_bg), &stdout, &stderr, exit_code);
                    eprintln!("[agentic] Script finished (exit {})", exit_code);
                    let payload = ScriptFinishedPayload {
                        run_id: id,
                        relative_path: rel_bg,
                        stdout,
                        stderr,
                        exit_code,
                        interpreter_used: interp_bg,
                    };
                    let _ = app.emit("script-finished", payload);
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = app.emit("script-finished", ScriptFinishedPayload {
                        run_id: id,
                        relative_path: rel_bg,
                        stdout: String::new(),
                        stderr: msg.clone(),
                        exit_code: -1,
                        interpreter_used: interp_bg,
                    });
                }
            }
        });
        return Ok(RunScriptResult {
            stdout: String::new(),
            stderr: "Running in background (plot/server OK). Results will appear when the script finishes.".to_string(),
            exit_code: -2,
            interpreter_used,
        });
    }

    let out = Command::new(&program)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let exit_code = out.status.code().unwrap_or(-1);
    log_command_result(&root, &format!("Script finished: {}", rel), &stdout, &stderr, exit_code);
    eprintln!("[agentic] Script finished (exit {})", exit_code);

    Ok(RunScriptResult {
        stdout,
        stderr,
        exit_code,
        interpreter_used,
    })
}

#[tauri::command]
fn run_pip_install(
    workspace_root: String,
    requirements_path: Option<String>,
    packages: Option<Vec<String>>,
) -> Result<RunScriptResult, String> {
    let root = workspace_path_from_input(&workspace_root);
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;

    let (args, cwd_use): (Vec<String>, std::path::PathBuf) = if let Some(ref path) = requirements_path {
        let path = path.trim();
        if path.is_empty() {
            return Err("Requirements path is empty".to_string());
        }
        let req_path = path_under_workspace(&root, path)?;
        if !req_path.exists() {
            return Err(format!("File not found: {}", path));
        }
        let dir = req_path.parent().unwrap_or(&root_canon).to_path_buf();
        (vec!["install".to_string(), "-r".to_string(), req_path.to_string_lossy().into_owned()], dir)
    } else if let Some(ref pkgs) = packages {
        if pkgs.is_empty() {
            return Err("No packages specified".to_string());
        }
        let mut args = vec!["install".to_string()];
        args.extend(pkgs.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
        (args, root_canon.clone())
    } else {
        return Err("Specify requirements_path or packages".to_string());
    };

    let pip_bin: PathBuf = workspace_venv_pip(&root_canon)
        .unwrap_or_else(|| PathBuf::from("pip3"));

    let pip_msg = format!("pip {} (cwd: {})", args.join(" "), cwd_use.display());
    append_workspace_log_path(&root_canon, &format!("Running: {}", pip_msg));
    eprintln!("[agentic] Running pip: {} {:?}", pip_bin.display(), &args);
    let out = Command::new(&pip_bin)
        .args(&args)
        .current_dir(&cwd_use)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let code = out.status.code().unwrap_or(-1);
    log_command_result(&root_canon, "Pip finished", &stdout, &stderr, code);
    eprintln!("[agentic] Pip finished (exit {})", code);

    Ok(RunScriptResult {
        stdout,
        stderr,
        exit_code: code,
        interpreter_used: None,
    })
}

fn docker_build_and_run(
    root: &Path,
    df: &str,
    df_path: &Path,
    rel: &str,
    _rel_norm: &str,
    run_cmd: &[String],
    tag: &str,
    interpreter_used: &Option<String>,
) -> Result<RunScriptResult, String> {
    append_workspace_log_path(root, &format!("Building Docker image from {}…", df));
    eprintln!("[agentic] Docker build: -f {} -t {} .", df, tag);
    let path_env = enriched_path_for_docker();
    let build_out = run_docker(
        &path_env,
        &["build", "-f", df_path.to_string_lossy().as_ref(), "-t", tag, "."],
        Some(root),
    )
    .map_err(|e| e.to_string())?;
    let build_stdout = String::from_utf8_lossy(&build_out.stdout).into_owned();
    let build_stderr = String::from_utf8_lossy(&build_out.stderr).into_owned();
    let build_code = build_out.status.code().unwrap_or(-1);
    log_command_result(root, "Docker build", &build_stdout, &build_stderr, build_code);

    let docker_unavailable = build_code == 127
        || build_stderr.contains("command not found")
        || build_stderr.contains("No such file")
        || build_stderr.contains("docker: not found");
    if docker_unavailable {
        append_workspace_log_path(root, "Docker not found — running script in workspace .venv instead.");
        eprintln!("[agentic] Docker unavailable, falling back to venv + pip + run");
        ensure_workspace_venv(root).ok();
        let packages = pip_packages_from_dockerfile(df_path);
        if !packages.is_empty() {
            if let Some(pip_bin) = workspace_venv_pip(root) {
                let mut args = vec!["install".to_string()];
                args.extend(packages);
                let pip_out = Command::new(&pip_bin)
                    .args(&args)
                    .current_dir(root)
                    .output()
                    .map_err(|e| e.to_string())?;
                let _ = pip_out.status.code();
                log_command_result(root, "Pip install (fallback)", &String::from_utf8_lossy(&pip_out.stdout), &String::from_utf8_lossy(&pip_out.stderr), pip_out.status.code().unwrap_or(-1));
            }
        }
        let script_path_fallback = path_under_workspace(root, rel).map_err(|e| e.to_string())?;
        let cwd = script_path_fallback.parent().unwrap_or(root);
        let is_python = run_cmd.first().map(|s| s.as_str()) == Some("python3");
        let ext = script_path_fallback.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_c = ext == "c";
        let is_cpp = ext == "cpp" || ext == "cc" || ext == "cxx";

        // C/C++ fallback: try gcc/g++ or clang locally when Docker is unavailable
        if !is_python && (is_c || is_cpp) {
            let script_str = script_path_fallback.to_string_lossy();
            let out_bin = std::env::temp_dir().join("agentic_c_run");
            let out_str = out_bin.to_string_lossy();
            let (compiler_name, compile_ok, compile_stdout, compile_stderr) = {
                let gcc = if is_cpp { "g++" } else { "gcc" };
                match Command::new(gcc)
                    .args(["-o", out_str.as_ref(), script_str.as_ref()])
                    .current_dir(cwd)
                    .output()
                {
                    Ok(o) => (
                        gcc.to_string(),
                        o.status.success(),
                        String::from_utf8_lossy(&o.stdout).into_owned(),
                        String::from_utf8_lossy(&o.stderr).into_owned(),
                    ),
                    Err(_) => {
                        let clang = if is_cpp { "clang++" } else { "clang" };
                        match Command::new(clang)
                            .args(["-o", out_str.as_ref(), script_str.as_ref()])
                            .current_dir(cwd)
                            .output()
                        {
                            Ok(o) => (
                                clang.to_string(),
                                o.status.success(),
                                String::from_utf8_lossy(&o.stdout).into_owned(),
                                String::from_utf8_lossy(&o.stderr).into_owned(),
                            ),
                            Err(_) => {
                                return Err("Docker is required to run this script (C/C++). Install Docker Desktop or install gcc/clang (e.g. xcode-select --install or brew install gcc).".to_string());
                            }
                        }
                    }
                }
            };
            append_workspace_log_path(root, &format!("Docker unavailable — compiling and running with {} (fallback)", compiler_name));
            log_command_result(root, &format!("Compile ({} fallback)", compiler_name), &compile_stdout, &compile_stderr, if compile_ok { 0 } else { 1 });
            if !compile_ok {
                let _ = std::fs::remove_file(&out_bin);
                return Ok(RunScriptResult {
                    stdout: compile_stdout,
                    stderr: compile_stderr,
                    exit_code: 1,
                    interpreter_used: Some(format!("{} (Docker unavailable)", compiler_name)),
                });
            }
            let run_out = Command::new(out_str.as_ref()).current_dir(cwd).output();
            let _ = std::fs::remove_file(&out_bin);
            let run_out = run_out.map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
            let exit_code = run_out.status.code().unwrap_or(-1);
            log_command_result(root, &format!("Run (fallback): {}", rel), &stdout, &stderr, exit_code);
            return Ok(RunScriptResult {
                stdout,
                stderr,
                exit_code,
                interpreter_used: Some(format!("{} (Docker unavailable)", compiler_name)),
            });
        }

        // Java fallback: try javac + java locally when Docker is unavailable
        if !is_python && ext == "java" {
            let stem = script_path_fallback
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Main");
            let script_str = script_path_fallback.to_string_lossy();
            let path_env = enriched_path_for_docker();
            append_workspace_log_path(root, "Docker unavailable — compiling and running with javac/java (fallback)");
            let compile_out = Command::new("javac")
                .arg(script_str.as_ref())
                .current_dir(cwd)
                .env("PATH", &path_env)
                .output();
            let compile_out = match compile_out {
                Ok(o) => o,
                Err(_) => {
                    return Err("Docker is required to run this script (Java). Install Docker Desktop or install a JDK (e.g. brew install openjdk).".to_string());
                }
            };
            let compile_stdout = String::from_utf8_lossy(&compile_out.stdout).into_owned();
            let compile_stderr = String::from_utf8_lossy(&compile_out.stderr).into_owned();
            let compile_ok = compile_out.status.success();
            log_command_result(root, "javac (fallback)", &compile_stdout, &compile_stderr, compile_out.status.code().unwrap_or(-1));
            if !compile_ok {
                return Ok(RunScriptResult {
                    stdout: compile_stdout,
                    stderr: compile_stderr,
                    exit_code: 1,
                    interpreter_used: Some("javac (Docker unavailable)".to_string()),
                });
            }
            let run_out = Command::new("java")
                .arg(stem)
                .current_dir(cwd)
                .env("PATH", &path_env)
                .output();
            let run_out = run_out.map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
            let exit_code = run_out.status.code().unwrap_or(-1);
            log_command_result(root, &format!("java {} (fallback)", stem), &stdout, &stderr, exit_code);
            return Ok(RunScriptResult {
                stdout,
                stderr,
                exit_code,
                interpreter_used: Some("javac/java (Docker unavailable)".to_string()),
            });
        }

        if !is_python {
            return Err("Docker is required to run this script. Install Docker Desktop or run a Python/C/Java script.".to_string());
        }
        let program = workspace_venv_python(root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "python3".to_string());
        // run_cmd has Docker paths (/workspace/...); use local script path for venv fallback
        let script_path_str = script_path_fallback.to_string_lossy().into_owned();
        let run_args: Vec<String> = vec![script_path_str];
        append_workspace_log_path(root, &format!("Running script in venv (fallback): {}", rel));
        let run_out = Command::new(&program)
            .args(&run_args)
            .current_dir(cwd)
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
        let exit_code = run_out.status.code().unwrap_or(-1);
        log_command_result(root, &format!("Script finished (venv fallback): {}", rel), &stdout, &stderr, exit_code);
        return Ok(RunScriptResult {
            stdout,
            stderr,
            exit_code,
            interpreter_used: Some("workspace .venv (Docker unavailable)".to_string()),
        });
    }

    if build_code != 0 {
        return Ok(RunScriptResult {
            stdout: build_stdout,
            stderr: build_stderr,
            exit_code: build_code,
            interpreter_used: interpreter_used.clone(),
        });
    }
    let mut run_args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-v".to_string(),
        format!("{}:/workspace", root.display()),
        "-w".to_string(),
        "/workspace".to_string(),
        tag.to_string(),
    ];
    run_args.extend(run_cmd.iter().cloned());
        append_workspace_log_path(root, &format!("Running in built image: {}", rel));
    let run_out = run_docker(&path_env, &run_args, None).map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&run_out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&run_out.stderr).into_owned();
    let exit_code = run_out.status.code().unwrap_or(-1);
    log_command_result(root, &format!("Docker run finished: {}", rel), &stdout, &stderr, exit_code);
    Ok(RunScriptResult {
        stdout,
        stderr,
        exit_code,
        interpreter_used: interpreter_used.clone(),
    })
}

/// Run a workspace script inside a Docker container. Mounts workspace at /workspace, runs interpreter with script path.
#[tauri::command]
fn run_workspace_script_docker(
    app: tauri::AppHandle,
    workspace_root: String,
    relative_path: String,
    docker_image: String,
    run_id: Option<String>,
) -> Result<RunScriptResult, String> {
    let root = workspace_path_from_input(&workspace_root);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let script_path = path_under_workspace(&root, &relative_path)?;
    if !script_path.exists() {
        return Err("Script file does not exist. Apply the file first.".to_string());
    }
    let (interpreter, extra_args): (&str, &[&str]) = interpreter_for_path(&script_path)
        .ok_or("Unknown script type for Docker. Use .py, .js, .sh.")?;
    let image = docker_image.trim();
    if image.is_empty() {
        return Err("Docker image name is required (e.g. python:3.11 or node:20).".to_string());
    }
    let rel = script_path
        .strip_prefix(&root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| relative_path.clone());
    let rel_norm = rel.replace('\\', "/");
    let interpreter_used = Some(format!("docker {}", image));
    append_workspace_log_path(&root, &format!("Running in Docker {}: {}", image, rel));
    eprintln!("[agentic] Running in Docker: image={} script={}", image, rel_norm);

    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-v".to_string(),
        format!("{}:/workspace", root.display()),
        "-w".to_string(),
        "/workspace".to_string(),
        image.to_string(),
        interpreter.to_string(),
    ];
    args.extend(extra_args.iter().map(|s| s.to_string()));
    args.push(format!("/workspace/{}", rel_norm));

    if let Some(id) = run_id {
        let args_bg = args.clone();
        let root_bg = root.clone();
        let rel_bg = rel.clone();
        let interp_bg = interpreter_used.clone();
        let path_env_bg = enriched_path_for_docker();
        thread::spawn(move || {
            let out = run_docker(&path_env_bg, &args_bg, None);
            match out {
                Ok(result) => {
                    let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
                    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
                    let exit_code = result.status.code().unwrap_or(-1);
                    log_command_result(&root_bg, &format!("Docker script finished: {}", rel_bg), &stdout, &stderr, exit_code);
                    let _ = app.emit(
                        "script-finished",
                        ScriptFinishedPayload {
                            run_id: id.clone(),
                            relative_path: rel_bg.clone(),
                            stdout,
                            stderr,
                            exit_code,
                            interpreter_used: interp_bg.clone(),
                        },
                    );
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = app.emit(
                        "script-finished",
                        ScriptFinishedPayload {
                            run_id: id,
                            relative_path: rel_bg,
                            stdout: String::new(),
                            stderr: msg,
                            exit_code: -1,
                            interpreter_used: interp_bg,
                        },
                    );
                }
            }
        });
        return Ok(RunScriptResult {
            stdout: String::new(),
            stderr: "Running in Docker (background). Results will appear when the container finishes.".to_string(),
            exit_code: -2,
            interpreter_used,
        });
    }

    let path_env = enriched_path_for_docker();
    let out = run_docker(&path_env, &args, None).map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let exit_code = out.status.code().unwrap_or(-1);
    log_command_result(&root, &format!("Docker script finished: {}", rel), &stdout, &stderr, exit_code);
    Ok(RunScriptResult {
        stdout,
        stderr,
        exit_code,
        interpreter_used,
    })
}

/// Build image from workspace Dockerfile then run script in it. Reproducible: same Dockerfile => same env.
#[tauri::command]
fn run_workspace_script_docker_build(
    app: tauri::AppHandle,
    workspace_root: String,
    relative_script_path: String,
    dockerfile_path: Option<String>,
    run_id: Option<String>,
) -> Result<RunScriptResult, String> {
    let root = workspace_path_from_input(&workspace_root);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let script_path = path_under_workspace(&root, &relative_script_path)?;
    if !script_path.exists() {
        return Err("Script file does not exist. Apply the file first.".to_string());
    }
    let df = dockerfile_path.as_deref().unwrap_or("Dockerfile").trim().to_string();
    let df_path = path_under_workspace(&root, &df)?;
    if !df_path.exists() {
        return Err(format!("Dockerfile not found: {} (put a Dockerfile in the workspace for reproducible runs)", df));
    }
    let rel = script_path
        .strip_prefix(&root)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| relative_script_path.clone());
    let rel_norm = rel.replace('\\', "/");
    let run_cmd: Vec<String> = interpreter_for_docker_run(&rel_norm)
        .map(|(interp, args)| {
            let mut v = vec![interp];
            v.extend(args);
            v
        })
        .or_else(|| {
            interpreter_for_path(&script_path).map(|(interp, extra)| {
                let mut v = vec![interp.to_string()];
                v.extend(extra.iter().map(|s| s.to_string()));
                v.push(format!("/workspace/{}", rel_norm));
                v
            })
        })
        .ok_or("Unknown script type. Use .py, .js, .sh, .c, .cpp, .java.")?;
    let tag = "agentic-build";
    let interpreter_used = Some(format!("docker (built from {})", df));

    if let Some(id) = run_id {
        let root_bg = root.clone();
        let rel_bg = rel.clone();
        let df_bg = df.clone();
        let df_path_bg = df_path.clone();
        let rel_norm_bg = rel_norm.clone();
        let interp_bg = interpreter_used.clone();
        let run_cmd_bg = run_cmd.clone();
        thread::spawn(move || {
            let result = docker_build_and_run(
                &root_bg,
                &df_bg,
                &df_path_bg,
                &rel_bg,
                &rel_norm_bg,
                &run_cmd_bg,
                tag,
                &interp_bg,
            );
            match result {
                Ok(res) => {
                    let _ = app.emit(
                        "script-finished",
                        ScriptFinishedPayload {
                            run_id: id.clone(),
                            relative_path: rel_bg.clone(),
                            stdout: res.stdout,
                            stderr: res.stderr,
                            exit_code: res.exit_code,
                            interpreter_used: interp_bg.clone(),
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "script-finished",
                        ScriptFinishedPayload {
                            run_id: id,
                            relative_path: rel_bg,
                            stdout: String::new(),
                            stderr: e,
                            exit_code: -1,
                            interpreter_used: interp_bg,
                        },
                    );
                }
            }
        });
        return Ok(RunScriptResult {
            stdout: String::new(),
            stderr: "Building image and running (background). Results will appear when done.".to_string(),
            exit_code: -2,
            interpreter_used,
        });
    }

    docker_build_and_run(&root, &df, &df_path, &rel, &rel_norm, &run_cmd, tag, &interpreter_used)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_workspace_file,
            write_workspace_file,
            list_workspace_dir,
            remove_workspace_file,
            run_workspace_script,
            run_workspace_script_docker,
            run_workspace_script_docker_build,
            run_pip_install,
            create_venv,
            append_workspace_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
