import { Env, LOAI } from "./util";

// Trích xuất thông tin văn bản bằng Gemini. Dùng chung cho nút "✨ Trích xuất bằng AI" và import tự động.
export const GEMINI_MODEL = "gemini-flash-lite-latest";
export const GEMINI_BACKUP_MODEL = "gemma-4-31b-it"; // dùng khi model chính quá tải
export const AI_MAX_FILE = 15 * 1024 * 1024;

export const EXTRACT_PROMPT = `Bạn là trợ lý đọc văn bản hành chính tiếng Việt. Từ nội dung văn bản được cung cấp, trả về JSON gồm:
- trich_yeu: trích yếu của văn bản bằng tiếng Việt, tối đa 20 từ. Nếu văn bản có sẵn dòng trích yếu (thường bắt đầu bằng "V/v" hoặc nằm ngay dưới tên loại văn bản) thì rút gọn dòng đó, nếu không thì nêu ngắn gọn văn bản nói về việc gì.
- tom_tat: tóm tắt nội dung chính bằng tiếng Việt, tối đa 250 từ.
- loai: loại văn bản, chọn ĐÚNG MỘT giá trị trong danh sách: ${LOAI.join(" | ")}. Căn cứ vào tên loại in ở đầu văn bản (Quyết định, Thông báo, Biên bản, Báo cáo, Công văn...) hoặc nội dung chính. "Lịch phát sóng" dùng cho lịch/chương trình/kế hoạch phát sóng. Nếu văn bản yêu cầu đơn vị/cá nhân thực hiện một công việc cụ thể thì chọn "Yêu cầu công tác". Không khớp loại nào thì chọn "Khác".
- don_vi_soan_thao: tên cơ quan/đơn vị ban hành văn bản, thường nằm ở góc trên bên trái. Nếu không có thì để chuỗi rỗng.
- so_van_ban: số/ký hiệu văn bản (ví dụ "12/QĐ-TT"), thường nằm ở góc trên bên trái ngay dưới tên đơn vị. Nếu không có thì để chuỗi rỗng.
Tuyệt đối không bịa thông tin; không thấy rõ thì để chuỗi rỗng.`;

/** Lỗi AI: message là câu hiển thị cho người dùng, status là mã HTTP trả về. */
export class AiError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export type Extracted = { trich_yeu: string; tom_tat: string; loai: string; don_vi_soan_thao: string; so_van_ban: string };
export type AiInput = { mime?: string; data?: ArrayBuffer; text?: string };

/** Mime gửi cho Gemini theo đuôi file; "" nếu Gemini không đọc trực tiếp được. */
export function aiMimeFor(ext: string) {
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ["jpg", "jpeg"].includes(ext) ? "image/jpeg" : ext === "txt" ? "text/plain" : "";
}

export function toBase64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function extractWithAi(env: Env, input: AiInput): Promise<Extracted> {
  if (!env.GEMINI_API_KEY) throw new AiError("Chưa cấu hình GEMINI_API_KEY trên máy chủ", 500);
  const content: any[] = [];
  if (input.data && input.mime) content.push({ inline_data: { mime_type: input.mime, data: toBase64(input.data) } });
  else if (input.text?.trim()) content.push({ text: "Nội dung văn bản (trích từ file Word/Excel):\n" + input.text.slice(0, 40000) });
  else throw new AiError("Không có nội dung để trích xuất", 400);

  // Gọi qua Worker proxy đặt gần máy chủ Google (tránh lỗi "User location is not supported"); chạy local thì gọi thẳng.
  const call = env.GEMINI ? (u: string, i: RequestInit) => env.GEMINI!.fetch(u, i) : fetch;
  const callModel = async (model: string) => {
    const path = `/v1beta/models/${model}:generateContent`;
    const isGemma = model.startsWith("gemma");
    // Gemma không hỗ trợ JSON mode/schema của Gemini -> chỉ nhắc trong prompt rồi tự tách JSON ở bên dưới.
    const prompt = isGemma ? EXTRACT_PROMPT + "\nChỉ trả về đúng một đối tượng JSON thuần (khóa: trich_yeu, tom_tat, loai, don_vi_soan_thao, so_van_ban), không kèm markdown hay giải thích." : EXTRACT_PROMPT;
    const generationConfig: any = isGemma ? { temperature: 0.2 } : {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          trich_yeu: { type: "STRING" }, tom_tat: { type: "STRING" }, don_vi_soan_thao: { type: "STRING" }, so_van_ban: { type: "STRING" },
          loai: { type: "STRING", enum: LOAI },
        },
        required: ["trich_yeu", "tom_tat", "don_vi_soan_thao", "so_van_ban", "loai"],
      },
      temperature: 0.2,
    };
    const r = await call(env.GEMINI ? `https://gemini-proxy${path}` : `https://generativelanguage.googleapis.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, ...content] }], generationConfig }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false as const, status: r.status, msg: String(j?.error?.message || r.status) };
    const raw: string = (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      return { ok: true as const, out: JSON.parse(m ? m[0] : raw || "{}") };
    } catch { return { ok: false as const, status: 502, msg: "AI trả về dữ liệu không đọc được" }; }
  };

  // Model chính quá tải/lỗi tạm thời -> tự chuyển sang model dự phòng.
  let res = await callModel(GEMINI_MODEL);
  const retryable = (x: { status: number; msg: string }) => [429, 500, 502, 503, 504].includes(x.status) || /high demand|overload|unavailable|quota/i.test(x.msg);
  if (!res.ok && retryable(res)) {
    console.error("Model chính lỗi, dùng model dự phòng:", res.msg);
    const backup = await callModel(GEMINI_BACKUP_MODEL);
    if (backup.ok) res = backup;
    else res = { ...res, msg: `${res.msg} (model dự phòng ${GEMINI_BACKUP_MODEL} cũng lỗi: ${backup.msg})` };
  }
  if (!res.ok) throw new AiError("Gemini lỗi: " + res.msg);
  const out: any = res.out;
  const cut = (s: unknown, n: number) => String(s ?? "").trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
  return {
    trich_yeu: cut(out.trich_yeu, 20),
    tom_tat: cut(out.tom_tat, 250),
    loai: LOAI.includes(String(out.loai ?? "").trim()) ? String(out.loai).trim() : "",
    don_vi_soan_thao: String(out.don_vi_soan_thao ?? "").trim(),
    so_van_ban: String(out.so_van_ban ?? "").trim(),
  };
}
