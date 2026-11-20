import { Env, LOAI, MAX_FILE, ALLOWED_EXT, norm } from "./util";
import { ensureFolder, listFolderFiles, downloadFile, relocateFile, moveFile, DriveItem } from "./drive";
import { AiError, AI_MAX_FILE, aiMimeFor, extractWithAi, Extracted } from "./ai";
import { docxToText, xlsxToText } from "./zip";

// Upload văn bản tự động: mỗi lượt cron (mỗi phút) xử lý TỐI ĐA 1 file trong folder nguồn
// -> trích xuất AI -> chuyển vào "Văn bản đến / <Loại>" -> ghi vào D1. Giãn cách giữa 2 file chính là chống rate limit API.

export const MAX_ATTEMPTS = 2;      // tối đa 2 lần xử lý/file; hết lượt thì ngừng, chờ admin bấm "Thử lại"
const BACKOFF_MS = 15 * 60_000;   // sau mỗi lần lỗi, file nghỉ 15 phút mới thử lại (file khác vẫn được xử lý, tránh spam API)
const LOCK_MS = 4 * 60_000;     // khóa tối đa 4 phút phòng lượt trước bị treo
const SYSTEM = "_system";

class ImportError extends Error {
  constructor(public stage: string, msg: string, public permanent = false) { super(msg); }
}

/** Chạy một khâu; lỗi bất kỳ được gắn tên khâu để admin biết hỏng ở đâu. */
async function step<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e instanceof ImportError) throw e;
    // 400 từ AI (không có nội dung/định dạng không đọc được) thì thử lại cũng vô ích
    throw new ImportError(stage, e?.message || String(e), e instanceof AiError && e.status === 400);
  }
}

async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)").bind(key, value).run();
}

async function recordError(env: Env, fileId: string, fileName: string, stage: string, message: string, permanent: boolean) {
  await env.DB.prepare(
    `INSERT INTO import_errors(file_id,file_name,stage,message,attempts) VALUES (?,?,?,?,?)
     ON CONFLICT(file_id) DO UPDATE SET file_name=excluded.file_name, stage=excluded.stage, message=excluded.message,
       attempts=CASE WHEN excluded.attempts>=? THEN ? ELSE MIN(import_errors.attempts+1, ?) END, updated_at=datetime('now')`
  ).bind(fileId, fileName, stage, message.slice(0, 500), permanent ? MAX_ATTEMPTS : 1, MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS).run();
}

/** Tìm file cũ nhất chưa xử lý xong, chưa hết lượt thử và không đang nghỉ 15 phút chờ thử lại. */
async function pickFile(env: Env, folder: string): Promise<DriveItem | null> {
  const { results } = await env.DB.prepare("SELECT file_id,attempts,updated_at FROM import_errors").all<{ file_id: string; attempts: number; updated_at: string }>();
  const now = Date.now();
  const skip = new Set(results
    .filter((r) => r.attempts >= MAX_ATTEMPTS || now - Date.parse(r.updated_at.replace(" ", "T") + "Z") < BACKOFF_MS)
    .map((r) => r.file_id));
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { files, next } = await listFolderFiles(env, folder, token);
    const hit = files.find((f) => !skip.has(f.id));
    if (hit) return hit;
    if (!next) return null;
    token = next;
  }
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function importOne(env: Env, f: DriveItem, userId: number): Promise<string> {
  const ext = f.name.split(".").pop()?.toLowerCase() || "";
  const size = Number(f.size ?? 0);

  // 1. Kiểm tra trước khi tốn lượt gọi API
  if (f.mimeType.startsWith("application/vnd.google-apps."))
    throw new ImportError("validate", "File Google Docs/Sheets/Slides không đọc được trực tiếp, hãy tải lên dạng PDF/Word/Excel", true);
  if (!ALLOWED_EXT.includes(ext)) throw new ImportError("validate", `Định dạng .${ext} không được hỗ trợ`, true);
  if (size > MAX_FILE) throw new ImportError("validate", "File quá lớn (tối đa 25MB)", true);
  const aiMime = aiMimeFor(ext);
  const asText = ext === "docx" || ext === "xlsx";
  if (!aiMime && !asText) throw new ImportError("extract", `Định dạng .${ext} chưa hỗ trợ trích xuất bằng AI (hỗ trợ: PDF, ảnh, txt, docx, xlsx)`, true);
  if (size > AI_MAX_FILE) throw new ImportError("extract", "File quá lớn để AI trích xuất (tối đa 15MB)", true);

  // 2. Tải file từ Drive
  const data = await step("download", async () => {
    const r = await downloadFile(env, f.id);
    if (!r.ok) throw new Error(`Drive trả về ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.arrayBuffer();
  });

  // 3. Trích xuất bằng AI
  const ai: Extracted = await step("extract", async () => {
    if (aiMime) return extractWithAi(env, { mime: aiMime, data });
    const text = ext === "docx" ? await docxToText(data) : await xlsxToText(data);
    if (!text.trim()) throw new AiError("File không có nội dung văn bản để đọc", 400);
    return extractWithAi(env, { text });
  });

  // Trường AI không đọc được thì điền giá trị dự phòng để vẫn lưu được, và ghi chú lại cho người kiểm tra
  const notes: string[] = [];
  const loai = LOAI.includes(ai.loai) ? ai.loai : (notes.push("AI không xác định được loại (đặt \"Khác\")"), "Khác");
  const donVi = ai.don_vi_soan_thao || (notes.push("AI không đọc được đơn vị soạn thảo"), "Chưa xác định");
  const trichYeu = ai.trich_yeu || (notes.push("AI không đọc được trích yếu (lấy tên file)"), f.name.replace(/\.[^.]+$/, ""));
  const ghiChu = ["Tự động import từ Drive.", ...notes].join(" ");

  // 4. Tìm/tạo thư mục đích và chuyển file đi (file biến mất khỏi folder nguồn)
  const folder = await step("folder", () => ensureFolder(env, "den", loai));
  const mime = f.mimeType && f.mimeType !== "application/octet-stream" ? f.mimeType : MIME_BY_EXT[ext] || "application/octet-stream";
  const driveId = await step("move", () => relocateFile(env, f.id, folder, f.name, mime, data));

  // 5. Lưu vào D1 (lỗi thì trả file về folder nguồn để không mất dấu)
  const soVb = ai.so_van_ban;
  const search = norm([soVb, donVi, loai, trichYeu, ai.tom_tat, ghiChu].join(" "));
  try {
    const r = await env.DB.prepare(
      `INSERT INTO documents(so_van_ban,don_vi_soan_thao,huong,loai,trich_yeu,tom_tat,drive_file_id,ten_file,mime,size,ngay_nhan,ghi_chu,search_text,created_by)
       VALUES (?,?,'den',?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(soVb, donVi, loai, trichYeu, ai.tom_tat, driveId, f.name, mime, size || data.byteLength, new Date().toISOString().slice(0, 10), ghiChu, search, userId).run();
    await env.DB.prepare("INSERT INTO audit_log(user_id,action,doc_id,detail) VALUES (NULL,'auto_import',?,?)").bind(r.meta.last_row_id, f.name).run();
  } catch (e: any) {
    try { const src = (await env.DB.prepare("SELECT value FROM settings WHERE key='import_folder'").first<{ value: string }>())?.value; if (src) await moveFile(env, driveId, src); } catch { /* bỏ qua */ }
    throw new ImportError("save", e?.message || String(e));
  }
  return `Đã import "${f.name}" → Văn bản đến / ${loai}`;
}

/** Một lượt cron: xử lý tối đa 1 file. Không bao giờ ném lỗi ra ngoài (mọi lỗi ghi vào import_errors). */
export async function runImportTick(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT key,value FROM settings WHERE key LIKE 'import_%'").all<{ key: string; value: string }>();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  if (s.import_enabled !== "1" || !s.import_folder) return;

  const now = Date.now();
  const gap = Math.max(1, Number(s.import_interval) || 1) * 60_000;
  if (now - (Number(s.import_last_start) || 0) < gap - 5_000) return; // chưa đủ giãn cách giữa 2 văn bản

  // Khóa: chỉ một lượt chạy tại một thời điểm
  const lock = await env.DB.prepare("UPDATE settings SET value=? WHERE key='import_lock' AND CAST(value AS INTEGER) < ?").bind(String(now + LOCK_MS), now).run();
  if (!lock.meta.changes) return;

  let file: DriveItem | null = null;
  let msg = "";
  try {
    await setSetting(env, "import_last_start", String(now));
    try {
      file = await pickFile(env, s.import_folder);
      await env.DB.prepare("DELETE FROM import_errors WHERE file_id=?").bind(SYSTEM).run();
    } catch (e: any) {
      await recordError(env, SYSTEM, "(Hệ thống)", "list", e?.message || String(e), false);
      msg = "Lỗi đọc folder nguồn";
      return;
    }
    if (!file) { msg = "Không có file mới"; return; }

    try {
      let userId = Number(s.import_user_id);
      if (!userId) userId = (await env.DB.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").first<{ id: number }>())?.id ?? 0;
      if (!userId) throw new ImportError("save", "Không có tài khoản admin nào để đứng tên người upload", true);
      msg = await importOne(env, file, userId);
      await env.DB.prepare("DELETE FROM import_errors WHERE file_id=?").bind(file.id).run();
    } catch (e: any) {
      const ie = e instanceof ImportError ? e : new ImportError("save", e?.message || String(e));
      console.error(`Import lỗi [${ie.stage}] ${file.name}:`, ie.message);
      await recordError(env, file.id, file.name, ie.stage, ie.message, ie.permanent);
      msg = `Lỗi file "${file.name}" (khâu ${ie.stage})`;
    }
  } finally {
    try {
      await setSetting(env, "import_last_run", new Date().toISOString());
      await setSetting(env, "import_last_msg", msg);
    } finally {
      await setSetting(env, "import_lock", "0");
    }
  }
}
