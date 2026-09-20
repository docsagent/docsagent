"""Group library sync orchestration (src/zotero/sync.ts port).

full sync -> core.indexGroupData, incremental -> core.syncGroupIndex,
lastSyncedVersion tracked in ~/.docsagent/sync-state.json.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from .errors import DocsAgentError
from .ids import group_source_name
from .web import ZoteroWebApi


class GroupSyncer:
    def __init__(
        self,
        core,
        web: ZoteroWebApi,
        zotero_data_dir: str,
        cache_root: str,
        state_path: str,
        log,
    ) -> None:
        self.core = core
        self.web = web
        self.zotero_data_dir = zotero_data_dir
        self.cache_root = cache_root
        self.state_path = state_path
        self.log = log

    def sync_group(self, group: dict) -> dict:
        state = self._load_state()
        group_state = state["groups"].get(str(group["groupId"]))
        try:
            current_version = self.web.get_library_version(group["groupId"])
            if group_state and group_state.get("lastSyncedVersion") == current_version:
                return {"mode": "skipped", "message": "already up to date"}
            incremental = group_state is not None
            fetched = self.web.fetch_items(
                group["groupId"], group_state.get("lastSyncedVersion") if incremental else None
            )
            items = fetched["items"]
            library_version = fetched.get("libraryVersion")
            collections = [] if incremental else self.web.fetch_collections(group["groupId"])
            payload = []
            for raw in items:
                normalized = self._normalize_item(group["groupId"], raw)
                if normalized:
                    payload.append(normalized)
            source = group_source_name(group["groupId"])
            method = "syncGroupIndex" if incremental else "indexGroupData"
            result = self.core.call(
                method,
                {
                    "source": source,
                    "libraryVersion": library_version or current_version,
                    "collections": [
                        {
                            "id": str((c.get("data") or {}).get("key") or c.get("key") or ""),
                            "name": str((c.get("data") or {}).get("name") or ""),
                            "parentId": (c.get("data") or {}).get("parentCollection"),
                        }
                        for c in collections
                    ],
                    "items": payload,
                },
            )
            state["groups"][str(group["groupId"])] = {
                "lastSyncedVersion": library_version or current_version,
                "lastSyncedAt": datetime.now(timezone.utc).isoformat(),
            }
            self._save_state(state)
            self.log.info(f"group {group['groupId']} {method}: indexed {result.get('indexed')} items")
            return {"mode": "incremental" if incremental else "full", "indexed": result.get("indexed")}
        except DocsAgentError as err:
            self.log.error(f"group sync {group['groupId']} failed: {err.message}")
            return {"mode": "error", "message": err.message}
        except Exception as err:
            self.log.error(f"group sync {group['groupId']} failed: {err}")
            return {"mode": "error", "message": str(err)}

    # ---- item normalization ----

    def _resolve_attachment_path(self, group_id: int, data: dict) -> str | None:
        key = str(data.get("key") or "")
        filename = str(data["filename"]) if data.get("filename") else None
        if filename:
            storage_path = os.path.join(self.zotero_data_dir, "storage", key, filename)
            if os.path.exists(storage_path):
                return storage_path
        link_mode = data.get("linkMode")
        if link_mode and link_mode not in ("imported_file", "imported_url"):
            return None
        if not filename:
            return None
        dest = os.path.join(self.cache_root, "groups", str(group_id), filename)
        if os.path.exists(dest):
            return dest
        try:
            self.web.download_file(group_id, key, dest)
            return dest
        except Exception as err:
            self.log.warn(f"attachment download failed for {key}: {err}")
            return None

    def _normalize_item(self, group_id: int, raw: dict) -> dict | None:
        d = raw.get("data") or {}
        key = str(d.get("key") or raw.get("key") or "")
        if not key:
            return None
        item_type = str(d.get("itemType") or "")
        base = {
            "key": key,
            "parentKey": d.get("parentItem"),
            "itemType": item_type,
            "tags": [str(t.get("tag") or "") for t in d.get("tags", []) if isinstance(t, dict)]
            if isinstance(d.get("tags"), list)
            else [],
            "collections": list(d.get("collections") or []) if isinstance(d.get("collections"), list) else [],
            "deleted": d.get("deleted") is True,
        }
        if item_type == "annotation":
            return {
                **base,
                "title": None,
                "annotation": {
                    "text": str(d.get("annotationText") or d.get("annotationComment") or ""),
                    "comment": d.get("annotationComment"),
                    "color": d.get("annotationColor"),
                    "page": _parse_page(d.get("annotationPage")),
                },
            }
        if item_type == "note":
            return {**base, "title": None, "noteHtml": str(d.get("note") or "")}
        if item_type == "attachment":
            local_path = self._resolve_attachment_path(group_id, d)
            return {
                **base,
                "title": d.get("title"),
                "attachment": {"key": key, "contentType": d.get("contentType"), "localPath": local_path},
            }
        return {
            **base,
            "title": d.get("title"),
            "abstractNote": d.get("abstractNote"),
            "creators": d.get("creators") if isinstance(d.get("creators"), list) else [],
            "date": d.get("date"),
            "year": _parse_year(d.get("date")),
        }

    def _load_state(self) -> dict:
        try:
            with open(self.state_path, encoding="utf-8") as f:
                raw = json.load(f)
            return {"groups": raw.get("groups", {})}
        except Exception:
            return {"groups": {}}

    def _save_state(self, state: dict) -> None:
        path = Path(self.state_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _parse_year(date) -> int | None:
    if not isinstance(date, str):
        return None
    m = re.search(r"\d{4}", date)
    return int(m.group(0)) if m else None


def _parse_page(page) -> int | None:
    if not isinstance(page, (str, int)):
        return None
    m = re.search(r"\d+", str(page))
    return int(m.group(0)) if m else None
