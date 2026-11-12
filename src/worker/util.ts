export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI?: Fetcher; // service binding tới workers/gemini-proxy
};

export const LOAI = ["Yêu cầu công tác", "Quyết định", "Quy trình", "Báo cáo", "Thông báo", "Biên bản", "Quy chế", "Công văn", "Khác"];
export const HUONG_LABEL: Record<string, string> = { den: "Văn bản đến", di: "Văn bản đi" };

const ITER = 50000; // khớp scripts/gen-seed.mjs
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function derive(pw: string, salt: Uint8Array<ArrayBuffer>, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

export async function hashPassword(pw: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await derive(pw, salt, ITER))}`;
}

export async function verifyPassword(pw: string, stored: string) {
  const [, it, salt, hash] = stored.split("$");
  const got = b64(await derive(pw, unb64(salt), Number(it)));
  if (got.length !== hash.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return d === 0;
}

export async function sha256Hex(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Bỏ dấu tiếng Việt, hạ chữ thường, để tìm kiếm không phân biệt dấu. */
export function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();
}

export function extractFolderId(input: string) {
  const s = input.trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : "";
}

