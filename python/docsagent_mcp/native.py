"""Bundled core binary resolution (src/core-service.ts BUNDLED_BINARIES port).

The wheel ships every platform's core binary + dylibs under docsagent_mcp/bin/
(same layout as the npm package's bin/).
"""

import platform
import stat
import sys
from pathlib import Path

PKG_BIN = Path(__file__).resolve().parent / "bin"

BUNDLED_BINARIES = {
    # One universal (x86_64 + arm64) binary serves every mac.
    "darwin-arm64": "docsagent-universal-apple-darwin",
    "darwin-x64": "docsagent-universal-apple-darwin",
    "linux-x64": "docsagent-linux-gnu",
    # The Linux core is built for x86_64 only — Linux ARM is not supported.
    "win32-x64": "docsagent-x86_64-pc-windows-msvc.exe",
}


def _platform_key() -> str:
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    return f"{sys.platform}-{arch}"


def bundled_binary() -> Path | None:
    name = BUNDLED_BINARIES.get(_platform_key())
    if not name:
        return None
    candidate = PKG_BIN / name
    return candidate if candidate.exists() else None


def bundled_bin_dir() -> Path | None:
    return PKG_BIN if PKG_BIN.exists() else None


def ensure_executable(path: Path) -> None:
    """Wheels do not reliably preserve the executable bit (the npm package
    relies on its postinstall for the same reason)."""
    if sys.platform == "win32":
        return
    mode = path.stat().st_mode
    if not mode & stat.S_IXUSR:
        path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def library_dir_for(core_binary: Path, config: dict) -> str | None:
    """Directory containing the core's dylibs: the bundled bin/ layout, or the
    external coreBinary's directory (the core's dylibs sit next to it)."""
    if config.get("coreBinary"):
        return str(core_binary.parent)
    return str(PKG_BIN) if PKG_BIN.exists() else None
