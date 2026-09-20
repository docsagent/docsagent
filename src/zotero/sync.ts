import { mkdir, readFile, writeFile } from "fs/promises";
import fs from "fs";
import path from "path";
import type { CoreClient } from "../core/client.js";
import type { Logger } from "../logger.js";
import { groupSourceName } from "../ids.js";
import type { ZoteroGroupConfig } from "../config.js";
import { ZoteroWebApi } from "./web.js";

export interface SyncState {
  groups: Record<string, { lastSyncedVersion: number; lastSyncedAt: string }>;
}

export interface SyncResult {
  mode: "full" | "incremental" | "skipped" | "error";
  indexed?: number;
  message?: string;
}

/**
 * Group library sync orchestration (DESIGN.md §3.6):
 * full sync -> core.indexGroupData, incremental -> core.syncGroupIndex,
 * lastSyncedVersion tracked in ~/.docsagent/sync-state.json.
 */
export class GroupSyncer {
  constructor(
    private readonly core: CoreClient,
    private readonly web: ZoteroWebApi,
    private readonly zoteroDataDir: string,
    private readonly cacheRoot: string,
    private readonly statePath: string,
    private readonly log: Logger,
  ) {}

  async syncGroup(group: ZoteroGroupConfig): Promise<SyncResult> {
    const state = await this.loadState();
    const groupState = state.groups[String(group.groupId)];
    try {
      const currentVersion = await this.web.getLibraryVersion(group.groupId);
      if (groupState && groupState.lastSyncedVersion === currentVersion) {
        return { mode: "skipped", message: "already up to date" };
      }
      const incremental = groupState !== undefined;
      const { items, libraryVersion } = await this.web.fetchItems(group.groupId, incremental ? groupState.lastSyncedVersion : undefined);
      const collections = incremental ? [] : await this.web.fetchCollections(group.groupId);
      const payload = [];
      for (const raw of items) {
        const normalized = await this.normalizeItem(group.groupId, raw);
        if (normalized) payload.push(normalized);
      }
      const source = groupSourceName(group.groupId);
      const method = incremental ? "syncGroupIndex" : "indexGroupData";
      const result = (await this.core.call(method, {
        source,
        libraryVersion: libraryVersion ?? currentVersion,
        collections: collections.map((c) => {
          const cd = (c.data ?? {}) as Record<string, unknown>;
          return { id: String(cd.key ?? c.key), name: String(cd.name ?? ""), parentId: (cd.parentCollection as string) ?? null };
        }),
        items: payload,
      })) as { indexed: number };

      state.groups[String(group.groupId)] = {
        lastSyncedVersion: libraryVersion ?? currentVersion,
        lastSyncedAt: new Date().toISOString(),
      };
      await this.saveState(state);
      this.log.info(`group ${group.groupId} ${method}: indexed ${result.indexed} items`);
      return { mode: incremental ? "incremental" : "full", indexed: result.indexed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`group sync ${group.groupId} failed: ${msg}`);
      return { mode: "error", message: msg };
    }
  }

  /**
   * Resolve a locally readable path for attachment files (DESIGN.md §2.3):
   * prefer the Zotero storage cache, else download into the shell cache so the
   * core can read the file from disk.
   */
  private async resolveAttachmentPath(groupId: number, data: Record<string, unknown>): Promise<string | null> {
    const key = String(data.key ?? "");
    const filename = data.filename ? String(data.filename) : null;
    if (filename) {
      const storagePath = path.join(this.zoteroDataDir, "storage", key, filename);
      if (fs.existsSync(storagePath)) return storagePath;
    }
    if (data.linkMode && data.linkMode !== "imported_file" && data.linkMode !== "imported_url") return null;
    if (!filename) return null;
    const dest = path.join(this.cacheRoot, "groups", String(groupId), filename);
    if (fs.existsSync(dest)) return dest;
    try {
      await this.web.downloadFile(groupId, key, dest);
      return dest;
    } catch (err) {
      this.log.warn(`attachment download failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async normalizeItem(groupId: number, raw: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const d = (raw.data ?? {}) as Record<string, unknown>;
    const key = String(d.key ?? raw.key ?? "");
    if (!key) return null;
    const itemType = String(d.itemType ?? "");
    const base: Record<string, unknown> = {
      key,
      parentKey: (d.parentItem as string) ?? null,
      itemType,
      tags: Array.isArray(d.tags) ? (d.tags as Array<{ tag?: string }>).map((t) => String(t.tag ?? "")).filter(Boolean) : [],
      collections: Array.isArray(d.collections) ? (d.collections as string[]) : [],
      deleted: d.deleted === true,
    };
    if (itemType === "annotation") {
      return {
        ...base,
        title: null,
        annotation: {
          text: String(d.annotationText ?? d.annotationComment ?? ""),
          comment: (d.annotationComment as string) ?? null,
          color: (d.annotationColor as string) ?? null,
          page: parsePage(d.annotationPage),
        },
      };
    }
    if (itemType === "note") {
      return { ...base, title: null, noteHtml: String(d.note ?? "") };
    }
    if (itemType === "attachment") {
      const localPath = await this.resolveAttachmentPath(groupId, d);
      return {
        ...base,
        title: (d.title as string) ?? null,
        attachment: { key, contentType: (d.contentType as string) ?? null, localPath },
      };
    }
    return {
      ...base,
      title: (d.title as string) ?? null,
      abstractNote: (d.abstractNote as string) ?? null,
      creators: Array.isArray(d.creators) ? d.creators : [],
      date: (d.date as string) ?? null,
      year: parseYear(d.date),
    };
  }

  private async loadState(): Promise<SyncState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as SyncState;
      return { groups: raw.groups ?? {} };
    } catch {
      return { groups: {} };
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(state, null, 2));
  }
}

function parseYear(date: unknown): number | null {
  if (typeof date !== "string") return null;
  const m = date.match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

function parsePage(page: unknown): number | null {
  if (typeof page !== "string" && typeof page !== "number") return null;
  const m = String(page).match(/\d+/);
  return m ? Number(m[0]) : null;
}
