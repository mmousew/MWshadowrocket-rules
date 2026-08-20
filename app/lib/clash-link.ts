const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getKey() {
  const raw = process.env.CLASH_LINK_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("尚未配置订阅地址加密密钥");
  return Uint8Array.from(raw.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}

export async function encryptSourceUrl(sourceUrl: string | string[]) {
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
