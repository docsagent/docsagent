"""JSON-RPC 2.0 client for the resident C++ core (src/core/client.ts port).

Transport: HTTP, POST http://{coreHost}:{httpPort}/rpc. The shell never spawns
the core - an unreachable core surfaces as core_unavailable with startup
instructions.
"""

import json
import socket
import urllib.error
import urllib.request
import uuid

from .errors import (
    CORE_UNAVAILABLE_MESSAGE,
    DocsAgentError,
    core_error_to_docs_agent,
    is_connect_failure,
)

DEFAULT_TIMEOUT_MS = 30_000
GROUP_SYNC_TIMEOUT_MS = 300_000


class CoreClient:
    def __init__(self, config: dict, default_timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.core_host = config["coreHost"]
        self.http_port = config["httpPort"]
        self.default_timeout_ms = default_timeout_ms

    def describe_endpoint(self) -> str:
        return f"http://{self.core_host}:{self.http_port}/rpc"

    def call(self, method: str, params=None, timeout_ms: int | None = None):
        timeout = timeout_ms or (
            GROUP_SYNC_TIMEOUT_MS
            if method in ("indexGroupData", "syncGroupIndex")
            else self.default_timeout_ms
        )
        return self._http_call(method, params, timeout)

    def _http_call(self, method: str, params, timeout_ms: int):
        url = f"http://{self.core_host}:{self.http_port}/rpc"
        payload = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method}
        if params is not None:
            payload["params"] = params
        body = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as res:
                raw = res.read()
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else None
            except (ValueError, UnicodeDecodeError):
                parsed = None
            if not isinstance(parsed, dict):
                raise DocsAgentError(
                    "core_unavailable",
                    f"DocsAgent Core returned a non-JSON response.\n\n{CORE_UNAVAILABLE_MESSAGE}",
                )
            if parsed.get("error"):
                raise core_error_to_docs_agent(parsed["error"])
            return parsed.get("result")
        except DocsAgentError:
            raise
        except urllib.error.HTTPError as err:
            try:
                raw = err.read().decode("utf-8")
                parsed = json.loads(raw) if raw else None
            except Exception:
                parsed = None
            if not isinstance(parsed, dict):
                raise DocsAgentError(
                    "core_unavailable",
                    f"DocsAgent Core returned a non-JSON response (HTTP {err.code}).\n\n{CORE_UNAVAILABLE_MESSAGE}",
                ) from err
            if parsed.get("error"):
                raise core_error_to_docs_agent(parsed["error"]) from err
            return parsed.get("result")
        except urllib.error.URLError as err:
            if is_connect_failure(err):
                raise DocsAgentError("core_unavailable", CORE_UNAVAILABLE_MESSAGE) from err
            raise DocsAgentError(
                "core_unavailable", f"DocsAgent Core request failed: {err}"
            ) from err
        except (TimeoutError, socket.timeout) as err:
            raise DocsAgentError(
                "core_timeout", f'DocsAgent Core did not answer "{method}" within {timeout_ms}ms'
            ) from err
        except OSError as err:
            if is_connect_failure(err):
                raise DocsAgentError("core_unavailable", CORE_UNAVAILABLE_MESSAGE) from err
            raise DocsAgentError(
                "core_unavailable", f"DocsAgent Core request failed: {err}"
            ) from err

    def call_with_timeout(self, method: str, params=None, timeout_ms: int | None = None):
        timeout = timeout_ms or (
            GROUP_SYNC_TIMEOUT_MS if method in ("indexGroupData", "syncGroupIndex") else self.default_timeout_ms
        )
        return self._http_call(method, params, timeout)

    def health(self) -> dict:
        return self.call("health")

    def list_sources(self) -> dict:
        return self.call("listSources")

    def index_status(self, source: str) -> dict:
        return self.call("indexStatus", {"source": source})
