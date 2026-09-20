"""Zotero local API client (src/zotero/local.ts port).

http://localhost:23119/api, Web-API v3 shape, used for write orchestration.
DESIGN.md section 5.1: the core never writes Zotero data; the shell does,
through this API.
"""

import json
import urllib.error
import urllib.request

from .errors import DocsAgentError

TIMEOUT_MS = 15_000


class ZoteroLocalApi:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def _req(self, method: str, api_path: str, body=None):
        url = f"{self.base_url}{api_path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url=url, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=TIMEOUT_MS / 1000) as res:
                status = res.status
                text = res.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise DocsAgentError("auth_failed", f"zotero local api: HTTP {err.code} for {api_path}") from err
            detail = ""
            try:
                detail = err.read().decode("utf-8")[:300]
            except Exception:
                detail = ""
            raise DocsAgentError(
                "web_api_error",
                f"zotero local api: HTTP {err.code} for {api_path}" + (f" — {detail}" if detail else ""),
            ) from err
        except urllib.error.URLError as err:
            raise DocsAgentError(
                "web_api_error",
                f"zotero local api: request failed ({err.reason}). Is Zotero running?",
            ) from err
        except TimeoutError as err:
            raise DocsAgentError("web_api_error", f"zotero local api: timeout for {api_path}") from err
        if status in (401, 403):
            raise DocsAgentError("auth_failed", f"zotero local api: HTTP {status} for {api_path}")
        return json.loads(text) if text else {}

    def ping(self) -> bool:
        """Cheap liveness probe: returns False when Zotero is not running."""
        try:
            self._req("GET", "/users/0/items?limit=1&format=json")
            return True
        except Exception:
            return False

    def get_item(self, key: str):
        try:
            return self._req("GET", f"/users/0/items/{key}?format=json")
        except DocsAgentError as err:
            if "404" in str(err):
                return None
            raise

    def create_items(self, items: list) -> dict:
        """POST /users/0/items with an array of item objects."""
        res = self._req("POST", "/users/0/items", items) or {}
        return {"success": res.get("success", {}), "failed": res.get("failed", {})}

    def replace_items(self, items: list) -> dict:
        """POST /users/0/items with full item objects (incl. version) to update them."""
        return self.create_items(items)

    def delete_item(self, key: str) -> None:
        self._req("DELETE", f"/users/0/items/{key}", None)
