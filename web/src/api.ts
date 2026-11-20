export const LOAI = ["Yêu cầu công tác", "Quyết định", "Quy trình", "Báo cáo", "Thông báo", "Biên bản", "Quy chế", "Công văn", "Lịch phát sóng", "Khác"];
export type User = { id: number; username: string; full_name: string; role: "admin" | "write" | "read" };
export type Doc = {
  id: number; so_van_ban: string; don_vi_soan_thao: string; huong: "den" | "di"; loai: string; trich_yeu: string;
  tom_tat: string; ten_file: string; mime: string; size: number; ngay_nhan: string; ghi_chu: string; created_by: number; nguoi_tao: string;
  read_at?: string | null; // thời điểm user đọc lần đầu (chỉ có ở chi tiết)
  is_read?: number; // 1 nếu user hiện tại đã đọc văn bản này
};

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  const r = await fetch("/api" + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: opts.body && !isForm ? { "content-type": "application/json" } : undefined,
    body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
    credentials: "same-origin",
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Lỗi " + r.status), { status: r.status });
  return j;
}
export const fmtDate = (s: string) => (s ? s.split("-").reverse().join("/") : "");
export const huongLabel = (h: string) => (h === "den" ? "Đến" : "Đi");

