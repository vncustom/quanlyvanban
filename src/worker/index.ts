import { Hono, Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env, LOAI, hashPassword, verifyPassword, sha256Hex, norm, extractFolderId } from "./util";
import { ensureFolder, uploadFile, downloadFile, trashFile, moveFile } from "./drive";

type User = { id: number; username: string; full_name: string; role: "admin" | "write" | "read" };
type Ctx = Context<{ Bindings: Env; Variables: { user: User } }>;

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const SESSION_DAYS = 7;
const MAX_FILE = 25 * 1024 * 1024;
const ALLOWED_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "jpg", "jpeg", "png", "txt"];

app.onError((e, c) => {
  console.error(e);
  return c.json({ error: e.message || "Lỗi máy chủ" }, 500);
});

// Chống CSRF: request ghi phải cùng origin
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

async function audit(c: Ctx, action: string, docId: number | null, detail = "") {
  const u = c.get("user");
  await c.env.DB.prepare("INSERT INTO audit_log(user_id,action,doc_id,detail) VALUES (?,?,?,?)").bind(u?.id ?? null, action, docId, detail).run();
}

const auth = async (c: Ctx, next: () => Promise<void>) => {
  const sid = getCookie(c, "sid");
  if (!sid) return c.json({ error: "Chưa đăng nhập" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT u.id,u.username,u.full_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.active=1"
  ).bind(await sha256Hex(sid), Date.now()).first<User>();
  if (!row) return c.json({ error: "Phiên hết hạn" }, 401);
  c.set("user", row);
  await next();
};
const needWrite = async (c: Ctx, next: () => Promise<void>) =>
  c.get("user").role === "read" ? c.json({ error: "Bạn chỉ có quyền đọc" }, 403) : next();
const needAdmin = async (c: Ctx, next: () => Promise<void>) =>
  c.get("user").role !== "admin" ? c.json({ error: "Chỉ admin" }, 403) : next();

// ---------- Auth ----------
app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const u = await c.env.DB.prepare("SELECT id,username,full_name,role,password_hash,active FROM users WHERE username=?")
    .bind((username || "").trim()).first<any>();
  if (!u || !u.active || !(await verifyPassword(password || "", u.password_hash)))
    return c.json({ error: "Sai tên đăng nhập hoặc mật khẩu" }, 401);
  const token = crypto.randomUUID() + crypto.randomUUID();
  await c.env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()).run();
  await c.env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,?)")
    .bind(await sha256Hex(token), u.id, Date.now() + SESSION_DAYS * 864e5).run();
  setCookie(c, "sid", token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  return c.json({ id: u.id, username: u.username, full_name: u.full_name, role: u.role });
});

app.post("/api/logout", async (c) => {
  const sid = getCookie(c, "sid");
  if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256Hex(sid)).run();
  deleteCookie(c, "sid", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", auth, (c) => c.json(c.get("user")));

app.post("/api/change-password", auth, async (c) => {
  const { old_password, new_password } = await c.req.json<any>();
  if (!new_password || new_password.length < 6) return c.json({ error: "Mật khẩu mới tối thiểu 6 ký tự" }, 400);
  const u = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(c.get("user").id).first<any>();
  if (!(await verifyPassword(old_password || "", u.password_hash))) return c.json({ error: "Mật khẩu cũ không đúng" }, 400);
  await c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(new_password), c.get("user").id).run();
  return c.json({ ok: true });
});

app.get("/api/meta", auth, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT DISTINCT don_vi_soan_thao v FROM documents ORDER BY v").all<{ v: string }>();
  return c.json({ loai: LOAI, don_vi: results.map((r) => r.v) });
});

// ---------- Văn bản ----------
const COLS = "d.id,d.so_van_ban,d.don_vi_soan_thao,d.huong,d.loai,d.trich_yeu,d.tom_tat,d.ten_file,d.mime,d.size,d.ngay_nhan,d.ghi_chu,d.created_by,d.created_at,u.full_name AS nguoi_tao";

app.get("/api/docs", auth, async (c) => {
  const q = c.req.query();
  const where: string[] = [], args: any[] = [];
  if (q.huong === "den" || q.huong === "di") { where.push("d.huong=?"); args.push(q.huong); }
  if (q.loai) { where.push("d.loai=?"); args.push(q.loai); }
  if (q.don_vi) { where.push("d.don_vi_soan_thao=?"); args.push(q.don_vi); }
  if (q.so) { where.push("d.so_van_ban LIKE ?"); args.push(`%${q.so}%`); }
  if (q.from) { where.push("d.ngay_nhan>=?"); args.push(q.from); }
  if (q.to) { where.push("d.ngay_nhan<=?"); args.push(q.to); }
  if (q.q) for (const w of norm(q.q).split(/\s+/).filter(Boolean)) { where.push("d.search_text LIKE ?"); args.push(`%${w}%`); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const size = Math.min(Math.max(Number(q.size) || 20, 1), 100);
  const page = Math.max(Number(q.page) || 1, 1);
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) n FROM documents d ${w}`).bind(...args).first<{ n: number }>())!.n;
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLS} FROM documents d JOIN users u ON u.id=d.created_by ${w} ORDER BY d.ngay_nhan DESC, d.id DESC LIMIT ? OFFSET ?`
  ).bind(...args, size, (page - 1) * size).all();
  return c.json({ total, page, size, items: results });
});

app.get("/api/docs/:id", auth, async (c) => {
  const d = await c.env.DB.prepare(`SELECT ${COLS} FROM documents d JOIN users u ON u.id=d.created_by WHERE d.id=?`).bind(c.req.param("id")).first();
  return d ? c.json(d) : c.json({ error: "Không tìm thấy" }, 404);
});

app.get("/api/docs/:id/file", auth, async (c) => {
  const d = await c.env.DB.prepare("SELECT drive_file_id,ten_file,mime FROM documents WHERE id=?").bind(c.req.param("id")).first<any>();
  if (!d) return c.json({ error: "Không tìm thấy" }, 404);
  const r = await downloadFile(c.env, d.drive_file_id);
  if (!r.ok) return c.json({ error: "Không đọc được file từ Drive" }, 502);
  const inline = c.req.query("download") !== "1" && (d.mime === "application/pdf" || d.mime.startsWith("image/"));
  return new Response(r.body, {
    headers: {
      "content-type": d.mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(d.ten_file)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    },
  });
});

function buildSearch(f: any) {
  return norm([f.so_van_ban, f.don_vi_soan_thao, f.loai, f.trich_yeu, f.tom_tat, f.ghi_chu].join(" "));
}
function readFields(f: FormData | Record<string, any>) {
  const g = (k: string) => String((f instanceof FormData ? f.get(k) : f[k]) ?? "").trim();
  return {
    so_van_ban: g("so_van_ban"), don_vi_soan_thao: g("don_vi_soan_thao"), huong: g("huong"), loai: g("loai"),
    trich_yeu: g("trich_yeu"), tom_tat: g("tom_tat"), ngay_nhan: g("ngay_nhan"), ghi_chu: g("ghi_chu"),
  };
}
function validate(f: ReturnType<typeof readFields>) {
  if (!f.don_vi_soan_thao) return "Thiếu đơn vị soạn thảo";
  if (f.huong !== "den" && f.huong !== "di") return "Hướng văn bản không hợp lệ";
  if (!LOAI.includes(f.loai)) return "Loại văn bản không hợp lệ";
  if (!f.trich_yeu) return "Thiếu trích yếu";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.ngay_nhan)) return "Ngày nhận không hợp lệ";
  return null;
}

// ---------- Trích xuất bằng AI (Gemini) ----------
const GEMINI_MODEL = "gemini-flash-lite-latest";
const EXTRACT_PROMPT = `Bạn là trợ lý đọc văn bản hành chính tiếng Việt. Từ nội dung văn bản được cung cấp, trả về JSON gồm:
- trich_yeu: trích yếu của văn bản bằng tiếng Việt, tối đa 20 từ. Nếu văn bản có sẵn dòng trích yếu (thường bắt đầu bằng "V/v" hoặc nằm ngay dưới tên loại văn bản) thì rút gọn dòng đó, nếu không thì nêu ngắn gọn văn bản nói về việc gì.
- tom_tat: tóm tắt nội dung chính bằng tiếng Việt, tối đa 100 từ.
- don_vi_soan_thao: tên cơ quan/đơn vị ban hành văn bản, thường nằm ở góc trên bên trái. Nếu không có thì để chuỗi rỗng.
- so_van_ban: số/ký hiệu văn bản (ví dụ "12/QĐ-TT"), thường nằm ở góc trên bên trái ngay dưới tên đơn vị. Nếu không có thì để chuỗi rỗng.
Tuyệt đối không bịa thông tin; không thấy rõ thì để chuỗi rỗng.`;

function toBase64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

app.post("/api/extract", auth, needWrite, async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ error: "Chưa cấu hình GEMINI_API_KEY trên máy chủ" }, 500);
  const form = await c.req.formData();
  const file = form.get("file");
  const text = String(form.get("text") ?? "").slice(0, 40000);
  const parts: any[] = [{ text: EXTRACT_PROMPT }];
  if (file instanceof File && file.size) {
    if (file.size > 15 * 1024 * 1024) return c.json({ error: "File quá lớn để trích xuất (tối đa 15MB)" }, 400);
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const mime = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ["jpg", "jpeg"].includes(ext) ? "image/jpeg" : ext === "txt" ? "text/plain" : "";
    if (!mime) return c.json({ error: `Định dạng .${ext} chưa hỗ trợ trích xuất bằng AI` }, 400);
    parts.push({ inline_data: { mime_type: mime, data: toBase64(await file.arrayBuffer()) } });
  } else if (text.trim()) {
    parts.push({ text: "Nội dung văn bản (trích từ file Word/Excel):\n" + text });
  } else return c.json({ error: "Không có nội dung để trích xuất" }, 400);

  // Gọi qua Worker proxy đặt gần máy chủ Google (tránh lỗi "User location is not supported"); chạy local thì gọi thẳng.
  const path = `/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const call = c.env.GEMINI ? (u: string, i: RequestInit) => c.env.GEMINI!.fetch(u, i) : fetch;
  const r = await call(c.env.GEMINI ? `https://gemini-proxy${path}` : `https://generativelanguage.googleapis.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": c.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { trich_yeu: { type: "STRING" }, tom_tat: { type: "STRING" }, don_vi_soan_thao: { type: "STRING" }, so_van_ban: { type: "STRING" } },
          required: ["trich_yeu", "tom_tat", "don_vi_soan_thao", "so_van_ban"],
        },
        temperature: 0.2,
      },
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) return c.json({ error: "Gemini lỗi: " + (j?.error?.message || r.status) }, 502);
  let out: any = {};
  try { out = JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "{}"); } catch { return c.json({ error: "AI trả về dữ liệu không đọc được, thử lại" }, 502); }
  const cut = (s: unknown, n: number) => String(s ?? "").trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
  await audit(c, "ai_extract", null);
  return c.json({
    trich_yeu: cut(out.trich_yeu, 20),
    tom_tat: cut(out.tom_tat, 100),
    don_vi_soan_thao: String(out.don_vi_soan_thao ?? "").trim(),
    so_van_ban: String(out.so_van_ban ?? "").trim(),
  });
});

app.post("/api/docs", auth, needWrite, async (c) => {
  const form = await c.req.formData();
  const f = readFields(form);
  const err = validate(f);
  if (err) return c.json({ error: err }, 400);
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return c.json({ error: "Chưa chọn file" }, 400);
  if (file.size > MAX_FILE) return c.json({ error: "File quá lớn (tối đa 25MB)" }, 400);
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXT.includes(ext)) return c.json({ error: `Định dạng .${ext} không được hỗ trợ` }, 400);

  const folder = await ensureFolder(c.env, f.huong as "den" | "di", f.loai);
  const mime = file.type || "application/octet-stream";
  const driveId = await uploadFile(c.env, folder, file.name, mime, await file.arrayBuffer());
  const r = await c.env.DB.prepare(
    `INSERT INTO documents(so_van_ban,don_vi_soan_thao,huong,loai,trich_yeu,tom_tat,drive_file_id,ten_file,mime,size,ngay_nhan,ghi_chu,search_text,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(f.so_van_ban, f.don_vi_soan_thao, f.huong, f.loai, f.trich_yeu, f.tom_tat, driveId, file.name, mime, file.size,
    f.ngay_nhan, f.ghi_chu, buildSearch(f), c.get("user").id).run();
  const id = r.meta.last_row_id as number;
  await audit(c, "create", id, f.so_van_ban);
  return c.json({ id }, 201);
});

async function canEdit(c: Ctx, id: string) {
  const d = await c.env.DB.prepare("SELECT created_by,drive_file_id,huong,loai FROM documents WHERE id=?").bind(id).first<any>();
  if (!d) return { err: c.json({ error: "Không tìm thấy" }, 404) };
  const u = c.get("user");
  if (u.role === "read" || (u.role !== "admin" && d.created_by !== u.id)) return { err: c.json({ error: "Không có quyền" }, 403) };
  return { d };
}

app.put("/api/docs/:id", auth, async (c) => {
  const { err, d } = await canEdit(c, c.req.param("id")!);
  if (err) return err;
  const f = readFields(await c.req.json());
  const v = validate(f);
  if (v) return c.json({ error: v }, 400);
  // Đổi Hướng/Loại chỉ admin được phép; khi đổi thì chuyển luôn file sang đúng folder trên Drive.
  if (f.huong !== d.huong || f.loai !== d.loai) {
    if (c.get("user").role !== "admin") return c.json({ error: "Chỉ admin được đổi Hướng/Loại văn bản" }, 403);
    const folder = await ensureFolder(c.env, f.huong as "den" | "di", f.loai);
    await moveFile(c.env, d.drive_file_id, folder);
  }
  await c.env.DB.prepare(
    `UPDATE documents SET so_van_ban=?,don_vi_soan_thao=?,huong=?,loai=?,trich_yeu=?,tom_tat=?,ngay_nhan=?,ghi_chu=?,search_text=?,updated_at=datetime('now') WHERE id=?`
  ).bind(f.so_van_ban, f.don_vi_soan_thao, f.huong, f.loai, f.trich_yeu, f.tom_tat, f.ngay_nhan, f.ghi_chu, buildSearch(f), c.req.param("id")).run();
  await audit(c, "update", Number(c.req.param("id")), f.so_van_ban);
  return c.json({ ok: true });
});

app.delete("/api/docs/:id", auth, async (c) => {
  const { err, d } = await canEdit(c, c.req.param("id")!);
  if (err) return err;
  await c.env.DB.prepare("DELETE FROM documents WHERE id=?").bind(c.req.param("id")).run();
  try { await trashFile(c.env, d.drive_file_id); } catch (e) { console.error(e); }
  await audit(c, "delete", Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---------- Admin ----------
app.get("/api/admin/users", auth, needAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id,username,full_name,role,active,ban,phong,chuc_danh FROM users ORDER BY full_name"
  ).all();
  return c.json(results);
});

app.put("/api/admin/users/:id", auth, needAdmin, async (c) => {
  const b = await c.req.json<any>();
  if (!["admin", "write", "read"].includes(b.role)) return c.json({ error: "Role không hợp lệ" }, 400);
  if (Number(c.req.param("id")) === c.get("user").id && (b.role !== "admin" || !b.active))
    return c.json({ error: "Không thể tự hạ quyền hoặc khóa chính mình" }, 400);
  await c.env.DB.prepare("UPDATE users SET role=?,active=? WHERE id=?").bind(b.role, b.active ? 1 : 0, c.req.param("id")).run();
  if (!b.active) await c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(c.req.param("id")).run();
  await audit(c, "user_update", null, `${c.req.param("id")} -> ${b.role}/${b.active}`);
  return c.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-password", auth, needAdmin, async (c) => {
  const { password } = await c.req.json<{ password?: string }>();
  const pw = password || "654321";
  await c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(pw), c.req.param("id")).run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(c.req.param("id")).run();
  await audit(c, "reset_password", null, c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/admin/settings", auth, needAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key,value FROM settings").all<{ key: string; value: string }>();
  return c.json(Object.fromEntries(results.map((r) => [r.key, r.value])));
});

app.put("/api/admin/settings", auth, needAdmin, async (c) => {
  const b = await c.req.json<any>();
  for (const [k, huong] of [["drive_folder_den", "den"], ["drive_folder_di", "di"]] as const) {
    if (b[k] === undefined) continue;
    const id = b[k] ? extractFolderId(b[k]) : "";
    if (b[k] && !id) return c.json({ error: `Link/ID folder không hợp lệ: ${k}` }, 400);
    await c.env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").bind(k, id).run();
    await c.env.DB.prepare("DELETE FROM drive_folders WHERE huong=?").bind(huong).run();
  }
  await audit(c, "settings", null);
  return c.json({ ok: true });
});

app.get("/api/admin/log", auth, needAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT l.id,l.action,l.doc_id,l.detail,l.created_at,u.username FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 200"
  ).all();
  return c.json(results);
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default app;

