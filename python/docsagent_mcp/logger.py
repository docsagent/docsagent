"""All shell logs go to stderr - stdout carries the MCP stdio protocol."""

import sys

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


class Logger:
    def __init__(self, level: str = "info") -> None:
        self.level = level

    def set_level(self, level: str) -> None:
        self.level = level

    def write(self, level: str, msg: str) -> None:
        if LEVELS[level] < LEVELS[self.level]:
            return
        sys.stderr.write(f"[docsagent] {msg}\n")
        sys.stderr.flush()

    def debug(self, msg: str) -> None:
        self.write("debug", msg)

    def info(self, msg: str) -> None:
        self.write("info", msg)

    def warn(self, msg: str) -> None:
        self.write("warn", msg)

    def error(self, msg: str) -> None:
        self.write("error", msg)
