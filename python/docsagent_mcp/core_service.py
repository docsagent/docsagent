"""Lifecycle management for the resident C++ core (src/core-service.ts port).

The MCP server itself never spawns the core; these commands let one CLI
invocation start, stop, restart or inspect it as a background process. State
(pid/log) lives next to the config file.
"""

import os
import signal
import sys
import subprocess
import time
from pathlib import Path

from .config import config_path, expand_home
from .core import CoreClient
from .errors import DocsAgentError
from .native import ensure_executable, library_dir_for

START_WAIT_MS = 15_000
STOP_GRACE_S = 10
POLL_INTERVAL_S = 0.15
HEALTH_TIMEOUT_MS = 1_500


def service_dir() -> Path:
    return config_path().parent


def pid_file() -> Path:
    return service_dir() / "core.pid"


def log_file() -> Path:
    return service_dir() / "core.log"


def read_pid() -> int | None:
    try:
        pid = int(pid_file().read_text(encoding="utf-8").strip())
        return pid if pid > 0 else None
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def is_core_reachable(config: dict, timeout_ms: int = HEALTH_TIMEOUT_MS) -> dict | None:
    client = CoreClient(config)
    try:
        health = client.call("health", None, timeout_ms)
        return {"version": health.get("version"), "uptimeSec": health.get("uptimeSec")}
    except Exception:
        return None


def resolve_core_binary(config: dict) -> Path:
    from .native import bundled_binary

    if config.get("coreBinary"):
        resolved = Path(expand_home(config["coreBinary"]))
        if not resolved.exists():
            raise DocsAgentError("core_unavailable", f'coreBinary "{resolved}" (config) does not exist')
        return resolved
    bundled = bundled_binary()
    if bundled:
        return bundled
    raise DocsAgentError(
        "core_unavailable",
        f"No DocsAgent Core binary found for {sys.platform}-{machine_key()}. "
        "Supported platforms: macOS universal (Intel + Apple Silicon), Windows x64, "
        "Linux x64 (x86_64 only — no Linux ARM). "
        f'Alternatively set "coreBinary" in {config_path()} to the core binary path.',
    )


def machine_key() -> str:
    from .native import _platform_key

    return _platform_key()


def _spawn_env(config: dict, core_binary: Path) -> dict:
    env = dict(os.environ)
    env["DOCSAGENT_HTTP_PORT"] = str(config["httpPort"])
    env["DOCSAGENT_ROOT_DIR"] = str(config_path().parent)
    if not config.get("coreBinary"):
        lib_dir = library_dir_for(core_binary, config)
        if lib_dir:
            if sys.platform == "darwin":
                env["DYLD_LIBRARY_PATH"] = lib_dir
                env["DYLD_FALLBACK_LIBRARY_PATH"] = lib_dir
            elif sys.platform == "linux":
                env["LD_LIBRARY_PATH"] = lib_dir
    return env


def _spawn_core(config: dict) -> int:
    from .native import _platform_key

    binary = resolve_core_binary(config)
    ensure_executable(binary)
    service_dir().mkdir(parents=True, exist_ok=True)
    out = open(log_file(), "a")
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": out,
        "stderr": out,
        "env": _spawn_env(config, binary),
        "cwd": str(binary.parent),
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )
    else:
        kwargs["start_new_session"] = True
    child = subprocess.Popen([str(binary)], **kwargs)
    pid_file().write_text(str(child.pid), encoding="utf-8")
    return child.pid


def _wait_for_health(config: dict, wait_ms: int) -> None:
    deadline = time.monotonic() + wait_ms / 1000
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_S)
        if is_core_reachable(config):
            return
    raise DocsAgentError(
        "core_unavailable",
        f'Core started but did not answer "health" within {wait_ms}ms — see {log_file()}',
    )


def start_core(config: dict) -> dict:
    client = CoreClient(config)
    if is_core_reachable(config):
        return {"started": False, "pid": read_pid(), "endpoint": client.describe_endpoint()}
    pid = _spawn_core(config)
    _wait_for_health(config, START_WAIT_MS)
    return {"started": True, "pid": pid, "endpoint": client.describe_endpoint()}


def stop_core(_config: dict | None = None) -> dict:
    pid = read_pid()
    if pid is None:
        return {"stopped": False}
    killed = False
    if pid_alive(pid):
        if sys.platform == "win32":
            os.kill(pid, signal.SIGTERM)  # TerminateProcess on Windows
        else:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + STOP_GRACE_S
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(POLL_INTERVAL_S)
        if pid_alive(pid):
            os.kill(pid, signal.SIGKILL)
            time.sleep(POLL_INTERVAL_S)
        killed = not pid_alive(pid)
    pid_file().unlink(missing_ok=True)
    return {"stopped": killed, "pid": pid}


def restart_core(config: dict) -> dict:
    stop_core(config)
    return start_core(config)


def core_status(config: dict) -> dict:
    client = CoreClient(config)
    pid = read_pid()
    health = is_core_reachable(config)
    return {
        "pid": pid,
        "running": (pid is not None and pid_alive(pid)) or health is not None,
        "reachable": health is not None,
        "version": health.get("version") if health else None,
        "uptimeSec": health.get("uptimeSec") if health else None,
        "endpoint": client.describe_endpoint(),
    }
