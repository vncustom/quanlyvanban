# Quản lý văn bản

Ứng dụng web quản lý văn bản đến/đi của đơn vị: người dùng đăng nhập để **đọc và tra cứu** văn bản, người có quyền ghi **upload** văn bản kèm các thông tin để lọc. File văn bản lưu trên **Google Drive**, dữ liệu tra cứu lưu trên **Cloudflare D1**, toàn bộ app chạy trên **Cloudflare Workers** (free tier đủ cho ~100 người/ngày, ~30 văn bản/ngày).

Tài liệu liên quan:

| Tài liệu | Nội dung |
|---|---|
| [docs/system-architecture.md](docs/system-architecture.md) | Kiến trúc hệ thống, mô hình dữ liệu, luồng xử lý, bảo mật |
| [docs/van-hanh.md](docs/van-hanh.md) | Hướng dẫn triển khai và vận hành (cài đặt, backup, cập nhật, xử lý sự cố) |

## 1. Chức năng

**Đăng nhập (bắt buộc)**
- Tên đăng nhập + mật khẩu, phiên 7 ngày (cookie HttpOnly). User tự đổi được mật khẩu ở trang tài khoản.
- Danh sách user nạp từ file `Danh sách_user.csv` (mật khẩu ban đầu `654321`), `lyhan` là admin.

**Tra cứu và đọc văn bản (mọi user)**
- Lọc theo hướng (Tất cả / Văn bản đến / Văn bản đi), **loại văn bản dạng thẻ tag** (mặc định "Tất cả"), đơn vị soạn thảo, số văn bản, khoảng ngày nhận.
- Tìm từ khóa trong số văn bản, đơn vị, trích yếu, tóm tắt, ghi chú; **gõ có dấu hay không dấu đều tìm được**.
- Xem file ngay trong app: **PDF, ảnh, Word (.docx), Excel (.xlsx/.xls)**; các định dạng khác (.doc, .ppt, .pptx, .txt) tải về.

**Upload và chỉnh sửa (user có quyền ghi)**
- Form upload gồm: Hướng, Loại, Số văn bản (không bắt buộc), Đơn vị soạn thảo, Trích yếu, Tóm tắt nội dung, Ngày nhận, Ghi chú, File đính kèm (tối đa 25 MB).
- Nút **✨ Trích xuất bằng AI** (Gemini): đọc file và tự điền Trích yếu, Tóm tắt, Số văn bản, Đơn vị soạn thảo để người dùng kiểm tra lại. Hỗ trợ PDF, ảnh, .txt, .docx, .xlsx/.xls.
- File tự được đưa vào đúng thư mục `Văn bản đến|đi / <Loại>` trên Google Drive.
- Sửa/xóa văn bản do chính mình upload. Xóa văn bản sẽ chuyển file trên Drive vào thùng rác.

**Admin – mục Cấu hình**
- **Phân quyền user:** chỉ đọc / được ghi / admin; khóa tài khoản; đặt lại mật khẩu về `654321`.
- **Google Drive:** dán link folder gốc "Văn bản đến" và "Văn bản đi"; app tự tạo 9 thư mục con theo loại.
- **Nhật ký:** 200 thao tác gần nhất (upload, sửa, xóa, đổi quyền, AI…).
- Admin sửa/xóa được **mọi** văn bản và là người duy nhất đổi được **Hướng/Loại** (app tự chuyển file sang thư mục Drive tương ứng).

### Phân quyền

| Quyền | Xem/tra cứu | Upload | Sửa/xóa | Đổi Hướng/Loại | Cấu hình |
|---|---|---|---|---|---|
| `read` (mặc định) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `write` | ✅ | ✅ | văn bản của mình | ❌ | ❌ |
| `admin` | ✅ | ✅ | tất cả | ✅ | ✅ |

### 9 loại văn bản
Yêu cầu công tác · Quyết định · Quy trình · Báo cáo · Thông báo · Biên bản · Quy chế · Công văn · Khác

## 2. Công nghệ

| Lớp | Công nghệ |
|---|---|
| Frontend | React 18 + Vite + TypeScript (SPA, hash router) |
| Backend | Cloudflare Worker + [Hono](https://hono.dev) |
| Database | Cloudflare D1 (SQLite) |
| Lưu file | Google Drive API v3 (OAuth refresh token) |
| AI | Gemini API (`gemini-flash-lite-latest`) qua Worker proxy `gemini-proxy` |
| Xem Word/Excel | `docx-preview`, SheetJS `xlsx`, `jszip` (chạy trên trình duyệt) |

## 3. Cấu trúc thư mục

```
quanlyvanban/
├─ src/worker/            Worker chính (API + phục vụ file tĩnh)
│   ├─ index.ts           Toàn bộ route /api/*, middleware, prompt AI
│   ├─ drive.ts           Gọi Google Drive (token, tạo folder, upload, tải, chuyển, xóa)
│   └─ util.ts            Kiểu Env, hằng LOAI, hash mật khẩu, chuẩn hóa tiếng Việt
├─ workers/gemini-proxy/  Worker nhỏ chuyển tiếp tới Gemini (đặt gần máy chủ Google)
├─ web/                   Frontend React (index.html, src/App.tsx, Preview.tsx, extract.ts…)
├─ migrations/            Schema D1 (0001_init.sql…)
├─ scripts/               gen-seed.mjs (CSV → SQL), get-refresh-token.mjs (OAuth)
├─ docs/                  Tài liệu kiến trúc và vận hành
├─ wrangler.toml          Cấu hình Worker chính (D1, assets, service binding)
└─ Danh sách_user.csv     Nguồn user (chứa thông tin cá nhân, KHÔNG đưa lên git công khai)
```

## 4. Chạy thử trên máy (local)

Yêu cầu: Node.js 20+.

```bash
npm install
npm run db:migrate:local
npm run seed
npm run seed:local
```

Tạo file `.dev.vars` (không commit) để dùng Drive và AI khi chạy local:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GEMINI_API_KEY=...
```

```bash
npm run dev      # build frontend + wrangler dev tại http://127.0.0.1:8787
```

Đăng nhập `lyhan` / `654321`. Chạy local nút AI gọi thẳng Gemini (không qua proxy) nên có thể gặp lỗi vùng; trên bản deploy thì đã xử lý.

## 5. Triển khai

Xem chi tiết từng bước trong [docs/van-hanh.md](docs/van-hanh.md). Tóm tắt:

```bash
npx wrangler login
npx wrangler d1 create quanlyvanban        # chép database_id vào wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GEMINI_API_KEY
npm run db:migrate:remote
npm run seed && npm run seed:remote
npm run deploy                             # build + deploy gemini-proxy + Worker chính
```

## 6. API (tóm tắt)

| Method + đường dẫn | Quyền | Mô tả |
|---|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | – | Phiên đăng nhập |
| `POST /api/change-password` | đã đăng nhập | Tự đổi mật khẩu |
| `GET /api/docs` | đã đăng nhập | Danh sách + lọc + tìm (`huong, loai, don_vi, so, from, to, q, page, size`) |
| `GET /api/docs/:id`, `GET /api/docs/:id/file` | đã đăng nhập | Chi tiết, tải/xem file (`?download=1` để tải) |
| `POST /api/docs` | ghi | Upload (multipart) |
| `PUT /api/docs/:id`, `DELETE /api/docs/:id` | chủ văn bản / admin | Sửa, xóa |
| `POST /api/extract` | ghi | Trích xuất bằng AI |
| `GET/PUT /api/admin/users…`, `POST /api/admin/users/:id/reset-password` | admin | Quản lý user |
| `GET/PUT /api/admin/settings`, `GET /api/admin/log` | admin | Cấu hình Drive, nhật ký |

## 7. Giới hạn đã biết

- File tối đa **25 MB**/lần upload (AI đọc tối đa 15 MB); mỗi văn bản **một** file đính kèm.
- Tìm từ khóa dùng `LIKE` trên cột đã bỏ dấu: ổn với vài chục nghìn văn bản; nếu chậm về sau sẽ chuyển sang FTS5.
- Chưa có giao diện thêm user mới: thêm vào CSV rồi chạy lại `npm run seed` + `npm run seed:remote` (chỉ thêm user chưa có, không đổi user cũ).
- Danh sách 9 loại văn bản đặt cứng trong code (xem mục 7.5 của `docs/van-hanh.md`).
