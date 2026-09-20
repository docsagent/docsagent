"""Zotero Web API v3 client for group library sync (src/zotero/web.ts port).

The core never talks to the web; the shell fetches and hands data over.
"""

import base64
import json
import urllib.error
import urllib.request
from pathlib import Path

from .errors import DocsAgentError

API_VERSION = "3"
PAGE_SIZE = 100
TIMEOUT_MS = 60_000


class ZoteroWebApi:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def _req(self, method: str, api_path: str, raw: bool = False) -> dict:
        req = urllib.request.Request(url=f"https://api.zotero.org{api_path}", method=method)
        req.add_header("Zotero-API-Version", API_VERSION)
        req.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_MS / 1000) as res:
                status = res.status
                headers = dict(res.headers)
                body = res.read()
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise DocsAgentError("auth_failed", f"zotero web api: HTTP {err.code} for {api_path}") from err
            raise DocsAgentError(
                "web_api_error", f"zotero web api: HTTP {err.code} for {api_path}"
            ) from err
        except urllib.error.URLError as err:
            raise DocsAgentError(
                "web_api_error", f"zotero web api: request failed ({err.reason})"
            ) from err
        except TimeoutError as err:
            raise DocsAgentError("web_api_error", f"zotero web api: timeout for {api_path}") from err
        if status < 200 or status >= 300:
            raise DocsAgentError("web_api_error", f"zotero web api: HTTP {status} for {api_path}")
        out: dict = {}
        lm = headers.get("last-modified-version") or headers.get("Last-Modified-Version")
        if lm:
            out["last-modified-version"] = lm
        if raw:
            out["body"] = base64.b64encode(body).decode("ascii")
            return out
        out["data"] = json.loads(body.decode("utf-8")) if body else {}
        return out

    def get_library_version(self, group_id: int) -> int:
        res = self._req("GET", f"/groups/{group_id}/items?limit=1&format=json")
        v = res.get("last-modified-version")
        try:
            return int(v)
        except (TypeError, ValueError) as err:
            raise DocsAgentError(
                "web_api_error", f"zotero web api: missing Last-Modified-Version for group {group_id}"
            ) from err

    def fetch_collections(self, group_id: int) -> list:
        out: list = []
        start = 0
        while True:
            res = self._req("GET", f"/groups/{group_id}/collections?limit={PAGE_SIZE}&start={start}&format=json")
            page = res.get("data") or []
            out.extend(page)
            if len(page) < PAGE_SIZE:
                return out
            start += PAGE_SIZE

    def fetch_items(self, group_id: int, since: int | None = None) -> dict:
        out: list = []
        library_version = None
        start = 0
        while True:
            suffix = f"&since={since}" if since is not None else ""
            res = self._req(
                "GET", f"/groups/{group_id}/items?limit={PAGE_SIZE}&start={start}{suffix}&format=json"
            )
            page = res.get("data") or []
            out.extend(page)
            if not library_version and res.get("last-modified-version"):
                library_version = int(res["last-modified-version"])
            if len(page) < PAGE_SIZE:
                return {"items": out, "libraryVersion": library_version}
            start += PAGE_SIZE

    def download_file(self, group_id: int, attachment_key: str, dest_path: str) -> None:
        res = self._req("GET", f"/groups/{group_id}/items/{attachment_key}/file", raw=True)
        b64 = res.get("body")
        if not b64:
            raise DocsAgentError("web_api_error", "zotero web api: empty file response")
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(base64.b64decode(b64))
