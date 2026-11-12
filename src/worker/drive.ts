import { Env, LOAI, HUONG_LABEL } from "./util";

let cached: { token: string; exp: number } | null = null;

async function accessToken(env: Env) {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await r.json();
  if (!j.access_token) throw new Error("Không lấy được access token Google: " + JSON.stringify(j));
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function gfetch(env: Env, url: string, init: RequestInit = {}) {
  const token = await accessToken(env);
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
  return r;
}

const API = "https://www.googleapis.com/drive/v3";

async function findOrCreateFolder(env: Env, parent: string, name: string) {
  const q = `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await gfetch(env, `${API}/files?${new URLSearchParams({ q, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`);
  const j: any = await r.json();
  if (j.files?.[0]) return j.files[0].id as string;
  const c = await gfetch(env, `${API}/files?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, parents: [parent], mimeType: "application/vnd.google-apps.folder" }),
  });
  const cj: any = await c.json();
  if (!cj.id) throw new Error("Không tạo được folder Drive: " + JSON.stringify(cj));
  return cj.id as string;
}

/** Lấy (hoặc tạo) folder con theo hướng + loại, cache vào D1. */
export async function ensureFolder(env: Env, huong: "den" | "di", loai: string) {
  const hit = await env.DB.prepare("SELECT folder_id FROM drive_folders WHERE huong=? AND loai=?").bind(huong, loai).first<{ folder_id: string }>();
  if (hit) return hit.folder_id;
  const root = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`drive_folder_${huong}`).first<{ value: string }>();
  if (!root?.value) throw new Error(`Admin chưa cấu hình folder Drive cho "${HUONG_LABEL[huong]}"`);
  if (!LOAI.includes(loai)) throw new Error("Loại văn bản không hợp lệ");
  const id = await findOrCreateFolder(env, root.value, loai);
  await env.DB.prepare("INSERT OR REPLACE INTO drive_folders(huong,loai,folder_id) VALUES (?,?,?)").bind(huong, loai, id).run();
  return id;
}

export async function uploadFile(env: Env, folderId: string, name: string, mime: string, data: ArrayBuffer) {
  const boundary = "qlvb" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + data.byteLength + tail.length);
  body.set(head, 0); body.set(new Uint8Array(data), head.length); body.set(tail, head.length + data.byteLength);
  const r = await gfetch(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const j: any = await r.json();
  if (!j.id) throw new Error("Upload Drive thất bại: " + JSON.stringify(j));
  return j.id as string;
}

export async function downloadFile(env: Env, fileId: string) {
  return gfetch(env, `${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
}

/** Chuyển file sang folder khác (dùng khi admin sửa Hướng/Loại văn bản). */
export async function moveFile(env: Env, fileId: string, newFolderId: string) {
  const g = await gfetch(env, `${API}/files/${fileId}?fields=parents&supportsAllDrives=true`);
  const gj: any = await g.json();
  if (!g.ok) throw new Error("Không đọc được file trên Drive: " + JSON.stringify(gj));
  const old: string[] = gj.parents ?? [];
  if (old.length === 1 && old[0] === newFolderId) return;
  const q = new URLSearchParams({ addParents: newFolderId, supportsAllDrives: "true", fields: "id" });
  if (old.length) q.set("removeParents", old.join(","));
  const r = await gfetch(env, `${API}/files/${fileId}?${q}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("Không chuyển được file sang folder mới: " + (await r.text()));
}

export async function trashFile(env: Env, fileId: string) {
  await gfetch(env, `${API}/files/${fileId}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}
