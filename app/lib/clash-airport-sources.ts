import { getRawDb } from "../../db";
import { decryptSourceUrl, encryptSourceUrl, parseSourceEntries, type ClashSourceEntry } from "./clash-link";
import { fetchAirportSubscription } from "./airport-subscription";
import { getAirportProxyCount } from "./clash-config";
import { getSourceSnapshot, listClashProfiles, saveSourceSnapshot, updateClashProfileSource } from "./clash-links";

export type ClashAirportSourceRow = {
  id: string;
  name: string;
  kind: "url" | "content";
  sourceUrl: string;
  content: string;
  hidden: boolean;
  status: "active" | "deleted";
  nodeCount: number | null;
  createdAt: number;
  updatedAt: number;
};

function sourceName(entry: ClashSourceEntry, index = 0) {
  if (entry.name?.trim()) return entry.name.trim();
  if (entry.kind === "content") return `本地订阅文件 ${index + 1}`;
  try { return new URL(entry.value).hostname; } catch { return `订阅来源 ${index + 1}`; }
}

function sourceValue(source: ClashAirportSourceRow) {
  return source.kind === "url" ? source.sourceUrl : source.content;
}

function toEntry(source: ClashAirportSourceRow): ClashSourceEntry {
  return {
    kind: source.kind,
    value: sourceValue(source),
    name: source.name,
    sourceId: source.id,
  };
}

function normalize(row: {
  id: string; name: string; kind: string; source_url: string; content: string; hidden: number | boolean;
  status: string; node_count: number | null; created_at: number; updated_at: number;
}): ClashAirportSourceRow {
  return {
    id: row.id,
    name: row.name || "机场订阅",
    kind: row.kind === "content" ? "content" : "url",
    sourceUrl: row.source_url || "",
    content: row.content || "",
    hidden: row.hidden === true || row.hidden === 1,
    status: row.status === "deleted" ? "deleted" : "active",
    nodeCount: typeof row.node_count === "number" ? row.node_count : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getById(id: string) {
  const row = await getRawDb().prepare("SELECT id, name, kind, source_url, content, hidden, status, node_count, created_at, updated_at FROM clash_airport_sources WHERE id = ? LIMIT 1").bind(id).first<{
    id: string; name: string; kind: string; source_url: string; content: string; hidden: number; status: string; node_count: number | null; created_at: number; updated_at: number;
  }>();
  return row ? normalize(row) : null;
}

async function findByEntry(entry: ClashSourceEntry) {
  const query = entry.kind === "url"
    ? "SELECT id, name, kind, source_url, content, hidden, status, node_count, created_at, updated_at FROM clash_airport_sources WHERE kind = 'url' AND source_url = ? AND status <> 'deleted' LIMIT 1"
    : "SELECT id, name, kind, source_url, content, hidden, status, node_count, created_at, updated_at FROM clash_airport_sources WHERE kind = 'content' AND content = ? AND status <> 'deleted' LIMIT 1";
  // `entry.value` is the source value from the encrypted profile payload.
  // Do not pass it through `sourceValue`, which expects a normalized DB row
  // with `source_url`/`content` fields and would otherwise return undefined.
  const row = await getRawDb().prepare(query).bind(entry.value).first<{
    id: string; name: string; kind: string; source_url: string; content: string; hidden: number; status: string; node_count: number | null; created_at: number; updated_at: number;
  }>();
  return row ? normalize(row) : null;
}

async function entryNodeCount(entry: ClashSourceEntry) {
  if (entry.kind === "content") return getAirportProxyCount(entry.value);
  try { return (await getSourceSnapshot(entry.value))?.node_count ?? null; } catch { return null; }
}

async function insertSource(entry: ClashSourceEntry, name = sourceName(entry), nodeCount?: number | null) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const count = nodeCount === undefined ? await entryNodeCount(entry) : nodeCount;
  const sourceUrl = entry.kind === "url" ? String(entry.value || "") : "";
  const content = entry.kind === "content" ? String(entry.value || "") : "";
  const safeNodeCount = typeof count === "number" ? count : null;
  await getRawDb().prepare(
    "INSERT INTO clash_airport_sources (id, name, kind, source_url, content, hidden, status, node_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)"
  ).bind(id, name.trim().slice(0, 80) || "机场订阅", entry.kind, sourceUrl, content, safeNodeCount, now, now).run();
  return getById(id);
}

async function ensureSourceForEntry(entry: ClashSourceEntry, index: number) {
  if (entry.sourceId) {
    const known = await getById(entry.sourceId);
    if (known && known.status !== "deleted") return known;
  }
  return (await findByEntry(entry)) || await insertSource(entry, sourceName(entry, index));
}

export async function ensureClashAirportSources() {
  const profiles = await listClashProfiles();
  for (const profile of profiles) {
    if (!profile.encrypted_source) continue;
    let entries: ClashSourceEntry[];
    try { entries = parseSourceEntries(await decryptSourceUrl(profile.encrypted_source)); } catch { continue; }
    let changed = false;
    const nextEntries = [] as ClashSourceEntry[];
    for (const [index, entry] of entries.entries()) {
      const source = await ensureSourceForEntry(entry, index);
      if (source && (entry.sourceId !== source.id || entry.name !== source.name)) {
        nextEntries.push({ ...entry, sourceId: source.id, name: source.name });
        changed = true;
      } else nextEntries.push(entry);
    }
    if (changed) await updateClashProfileSource(profile.id, await encryptSourceUrl(nextEntries));
  }
  const rows = await getRawDb().prepare("SELECT id, name, kind, source_url, content, hidden, status, node_count, created_at, updated_at FROM clash_airport_sources WHERE status <> 'deleted' ORDER BY created_at ASC").all<{
    id: string; name: string; kind: string; source_url: string; content: string; hidden: number; status: string; node_count: number | null; created_at: number; updated_at: number;
  }>();
  return rows.results.map(normalize);
}

export async function listClashAirportSources() {
  return ensureClashAirportSources();
}

export async function getClashAirportSource(id: string) {
  const source = await getById(id);
  if (!source || source.status === "deleted") return null;
  return source;
}

export async function createClashAirportSource(entry: ClashSourceEntry, name?: string, nodeCount?: number | null) {
  const existing = await findByEntry(entry);
  if (existing) throw new Error("这个机场已经在机场列表中");
  const source = await insertSource(entry, name || sourceName(entry), nodeCount);
  if (!source) throw new Error("保存机场失败");
  return source;
}

function matchesEntry(entry: ClashSourceEntry, source: ClashAirportSourceRow) {
  if (entry.sourceId === source.id) return true;
  return entry.kind === source.kind && sourceValue(source) === entry.value;
}

async function rewriteProfiles(source: ClashAirportSourceRow, replacement: ClashAirportSourceRow | null) {
  const profiles = await listClashProfiles();
  for (const profile of profiles) {
    if (!profile.encrypted_source) continue;
    let entries: ClashSourceEntry[];
    try { entries = parseSourceEntries(await decryptSourceUrl(profile.encrypted_source)); } catch { continue; }
    const nextEntries = replacement
      ? entries.map((entry) => matchesEntry(entry, source) ? { ...toEntry(replacement), hidden: entry.hidden } : entry)
      : entries.filter((entry) => !matchesEntry(entry, source));
    if (nextEntries.length !== entries.length || nextEntries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(entries[index]))) {
      await updateClashProfileSource(profile.id, await encryptSourceUrl(nextEntries));
    }
  }
}

async function setProfilesSourceHidden(source: ClashAirportSourceRow, hidden: boolean) {
  const profiles = await listClashProfiles();
  for (const profile of profiles) {
    if (!profile.encrypted_source) continue;
    let entries: ClashSourceEntry[];
    try { entries = parseSourceEntries(await decryptSourceUrl(profile.encrypted_source)); } catch { continue; }
    const nextEntries = entries.map((entry) => matchesEntry(entry, source) ? { ...entry, hidden } : entry);
    if (nextEntries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(entries[index]))) {
      await updateClashProfileSource(profile.id, await encryptSourceUrl(nextEntries));
    }
  }
}

export async function refreshClashAirportSource(id: string) {
  const source = await getClashAirportSource(id);
  if (!source) throw new Error("机场不存在");
  if (source.kind !== "url") {
    const count = getAirportProxyCount(source.content);
    await getRawDb().prepare("UPDATE clash_airport_sources SET node_count = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(count, Date.now(), id).run();
    return getClashAirportSource(id);
  }
  const fetched = await fetchAirportSubscription(source.sourceUrl);
  await saveSourceSnapshot(source.sourceUrl, fetched.content, fetched.nodeCount);
  await getRawDb().prepare("UPDATE clash_airport_sources SET content = ?, node_count = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(fetched.content, fetched.nodeCount, Date.now(), id).run();
  return getClashAirportSource(id);
}

export async function updateClashAirportSource(id: string, patch: { name?: string; sourceUrl?: string; content?: string; nodeCount?: number | null }) {
  const source = await getClashAirportSource(id);
  if (!source) throw new Error("机场不存在");
  const oldSource = source;
  const next: ClashAirportSourceRow = { ...source };
  if (typeof patch.name === "string") next.name = patch.name.trim().slice(0, 80) || "机场订阅";
  if (source.kind === "url" && typeof patch.sourceUrl === "string" && patch.sourceUrl.trim() && patch.sourceUrl.trim() !== source.sourceUrl) {
    const fetched = await fetchAirportSubscription(patch.sourceUrl.trim());
    await saveSourceSnapshot(patch.sourceUrl.trim(), fetched.content, fetched.nodeCount);
    next.sourceUrl = patch.sourceUrl.trim(); next.content = fetched.content; next.nodeCount = fetched.nodeCount;
  } else if (source.kind === "content" && typeof patch.content === "string" && patch.content) {
    const count = getAirportProxyCount(patch.content);
    if (!count) throw new Error("文件没有识别到节点");
    next.content = patch.content; next.nodeCount = patch.nodeCount ?? count;
  }
  const safeName = String(next.name || "机场订阅");
  const safeSourceUrl = String(next.sourceUrl || "");
  const safeContent = String(next.content || "");
  const safeNodeCount = typeof next.nodeCount === "number" ? next.nodeCount : null;
  await getRawDb().prepare("UPDATE clash_airport_sources SET name = ?, source_url = ?, content = ?, node_count = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(safeName, safeSourceUrl, safeContent, safeNodeCount, Date.now(), id).run();
  const updated = await getClashAirportSource(id);
  if (!updated) throw new Error("更新机场失败");
  if (oldSource.name !== updated.name || sourceValue(oldSource) !== sourceValue(updated)) await rewriteProfiles(oldSource, updated);
  return updated;
}

export async function setClashAirportSourceHidden(id: string, hidden: boolean) {
  const source = await getClashAirportSource(id);
  if (!source) throw new Error("机场不存在");
  await getRawDb().prepare("UPDATE clash_airport_sources SET hidden = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(hidden ? 1 : 0, Date.now(), id).run();
  await setProfilesSourceHidden(source, hidden);
  return getClashAirportSource(id);
}

export async function deleteClashAirportSource(id: string) {
  const source = await getClashAirportSource(id);
  if (!source) throw new Error("机场不存在");
  await rewriteProfiles(source, null);
  await getRawDb().prepare("UPDATE clash_airport_sources SET status = 'deleted', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
}
