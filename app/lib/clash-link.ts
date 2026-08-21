const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getKey() {
  const raw = process.env.CLASH_LINK_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("尚未配置订阅地址加密密钥");
  return Uint8Array.from(raw.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}

export type ClashSourceEntry = { kind: "url"; value: string; name?: string; hidden?: boolean } | { kind: "content"; value: string; name?: string; hidden?: boolean };

export function parseSourceEntries(value: string): ClashSourceEntry[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item): ClashSourceEntry[] => {
        if (typeof item === "string") return [{ kind: "url", value: item }];
        if (item?.kind === "url" && typeof item.value === "string") return [{ kind: "url", value: item.value, name: typeof item.name === "string" ? item.name : undefined, hidden: item.hidden === true }];
        if (item?.kind === "content" && typeof item.value === "string") return [{ kind: "content", value: item.value, name: typeof item.name === "string" ? item.name : undefined, hidden: item.hidden === true }];
        return [];
      });
    }
  } catch { /* legacy single URL payload */ }
  return value.trim() ? [{ kind: "url", value: value.trim() }] : [];
}

export async function encryptSourceUrl(sourceUrl: string | string[] | ClashSourceEntry[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", getKey(), "AES-GCM", false, ["encrypt"]);
  const value = Array.isArray(sourceUrl) ? JSON.stringify(sourceUrl) : sourceUrl;
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString("base64url");
}

export async function decryptSourceUrl(value: string) {
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length < 29) throw new Error("invalid payload");
    const iv = payload.subarray(0, 12);
    const encrypted = payload.subarray(12);
    const key = await crypto.subtle.importKey("raw", getKey(), "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    return decoder.decode(decrypted);
  } catch {
    throw new Error("机场订阅参数无效，请重新生成链接");
  }
}
