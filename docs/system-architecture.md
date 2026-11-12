# Kiến trúc hệ thống

Tài liệu mô tả cách app Quản lý văn bản được tổ chức, dữ liệu lưu ở đâu, các luồng xử lý chính và các quyết định thiết kế. Chức năng xem `README.md`, vận hành xem `docs/van-hanh.md`.

Mục lục
1. [Tổng quan](#1-tổng-quan)
2. [Thành phần](#2-thành-phần)
3. [Mô hình dữ liệu](#3-mô-hình-dữ-liệu)
4. [Các luồng xử lý chính](#4-các-luồng-xử-lý-chính)
5. [Bảo mật](#5-bảo-mật)
6. [Hạn mức và khả năng chịu tải](#6-hạn-mức-và-khả-năng-chịu-tải)
7. [Quyết định thiết kế và đánh đổi](#7-quyết-định-thiết-kế-và-đánh-đổi)
8. [Hướng mở rộng](#8-hướng-mở-rộng)

---

## 1. Tổng quan

```
 Trình duyệt (React SPA)
   │  HTTPS, cookie phiên HttpOnly
   ▼
 ┌──────────────────────────── Cloudflare ────────────────────────────┐
 │  Worker "quanlyvanban" (Hono)                                      │
 │   ├─ Static assets: dist/ (React build)  ← mọi URL không phải /api │
 │   ├─ /api/*  → xác thực, phân quyền, nghiệp vụ                     │
 │   │                                                                │
 │   ├──► D1 "quanlyvanban" (SQLite)                                  │
 │   │      users · sessions · documents · settings · drive_folders · │
 │   │      audit_log                                                 │
 │   │                                                                │
 │   └──► service binding GEMINI ──► Worker "gemini-proxy"            │
 │                                     (placement gần Google, Mỹ)     │
 └───────────────┬──────────────────────────────┬─────────────────────┘
                 │ HTTPS (OAuth access token)   │ HTTPS (x-goog-api-key)
                 ▼                              ▼
          Google Drive API v3             Gemini API
     (lưu file: Văn bản đến|đi/<Loại>)   (gemini-flash-lite-latest)
```

Nguyên tắc chính:
- **Một Worker chính** vừa phục vụ giao diện vừa phục vụ API, nên không có CORS và chỉ có một địa chỉ.
- **File văn bản không nằm trên Cloudflare**: lưu ở Google Drive của tài khoản chủ app. Người xem **không cần quyền Drive**; app đọc file bằng token của chủ và **stream** về qua Worker, nên chỉ người đã đăng nhập mới xem được.
- **D1 chỉ lưu thông tin tra cứu** (metadata) và ID file trên Drive.

## 2. Thành phần

### 2.1 Frontend (`web/`)
- React 18 + Vite, build ra `dist/` và được Worker phục vụ như static assets (`not_found_handling = "single-page-application"`).
- Router tự viết theo `location.hash` (`#/`, `#/doc/:id`, `#/new`, `#/admin`, `#/account`).
- Giao diện: `App.tsx` (đăng nhập, danh sách có thẻ loại + bộ lọc, chi tiết, form upload/sửa, Cấu hình admin), `Preview.tsx` (xem PDF/ảnh/Word/Excel), `extract.ts` (đọc chữ từ Word/Excel để gửi cho AI), `api.ts` (gọi API, kiểu dữ liệu, danh sách `LOAI`).
- Thư viện nặng (`docx-preview`, `xlsx`, `jszip`) được **nạp động**, chỉ tải khi người dùng mở văn bản Word/Excel hoặc dùng AI với file Word/Excel.

### 2.2 Worker chính (`src/worker/`)
| File | Vai trò |
|---|---|
| `index.ts` | Hono app: middleware CSRF, `auth` / `needWrite` / `needAdmin`, các route API, prompt và gọi Gemini |
| `drive.ts` | Google Drive: đổi refresh token lấy access token (cache trong bộ nhớ isolate), tìm/tạo folder con, upload multipart, tải, chuyển folder, đưa vào thùng rác |
| `util.ts` | Kiểu `Env`, hằng `LOAI`, hash PBKDF2, `norm()` bỏ dấu tiếng Việt, `extractFolderId()` |

`run_worker_first = ["/api/*"]`: chỉ request `/api/*` chạy code Worker; còn lại phục vụ thẳng từ static assets.

### 2.3 Worker proxy Gemini (`workers/gemini-proxy/`)
Worker nhỏ chỉ chuyển tiếp `POST /v1beta/models/<model>:generateContent` tới Gemini. Có `[placement] hostname = "generativelanguage.googleapis.com"` nên chạy gần máy chủ Google. Lý do: Gemini API chặn theo vị trí máy chủ gọi; Worker thường chạy ở trung tâm dữ liệu gần người dùng (khu vực châu Á) và bị lỗi `User location is not supported`. Tách riêng để **Worker chính vẫn ở gần người dùng và D1**, chỉ riêng cuộc gọi AI đi đường vòng. `workers_dev = false`: không có địa chỉ công khai, chỉ Worker chính gọi được qua service binding `GEMINI`.

### 2.4 Cơ sở dữ liệu
Cloudflare D1, schema trong `migrations/` (hiện có `0001_init.sql`), áp dụng bằng `wrangler d1 migrations apply`.

## 3. Mô hình dữ liệu

```
users ──< sessions            users ──< documents (created_by)
users ──< audit_log (user_id)

settings (key/value)          drive_folders (huong, loai → folder_id)
```

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `users` | `id`, `username` (unique, không phân biệt hoa thường), `full_name`, `role` (`admin`/`write`/`read`), `password_hash`, `active`, `ban`, `phong`, `to_nhom`, `chuc_danh`, `vai_tro`, `email`, `phone` | Các cột `ban…phone` lấy từ CSV, chỉ để hiển thị/tìm user |
| `sessions` | `id` (= SHA-256 của token), `user_id`, `expires_at` (ms) | Token thô chỉ có trong cookie, DB chỉ lưu băm |
| `documents` | `id` INTEGER PRIMARY KEY AUTOINCREMENT, `so_van_ban`, `don_vi_soan_thao`, `huong` (`den`/`di`), `loai`, `trich_yeu`, `tom_tat`, `drive_file_id`, `ten_file`, `mime`, `size`, `ngay_nhan` (YYYY-MM-DD), `ghi_chu`, `search_text`, `created_by`, `created_at`, `updated_at` | `id` tăng dần, không tái sử dụng sau khi xóa; `so_van_ban` **không** unique; `search_text` là chuỗi đã bỏ dấu + hạ chữ thường để tìm kiếm |
| `settings` | `drive_folder_den`, `drive_folder_di` | ID folder gốc trên Drive |
| `drive_folders` | PK (`huong`, `loai`) → `folder_id` | Cache ID thư mục con để khỏi hỏi Drive mỗi lần upload; xóa khi admin đổi folder gốc |
| `audit_log` | `user_id`, `action`, `doc_id`, `detail`, `created_at` | Giờ UTC |

Index trên `documents`: `(ngay_nhan DESC, id DESC)`, `(huong, loai)`, `don_vi_soan_thao`, `so_van_ban`.

## 4. Các luồng xử lý chính

### 4.1 Đăng nhập và phiên
1. `POST /api/login` kiểm tra `username` + mật khẩu (PBKDF2-SHA256, 50.000 vòng, so sánh hằng thời gian).
2. Tạo token ngẫu nhiên (2 UUID), lưu **SHA-256(token)** vào `sessions` (hạn 7 ngày), trả cookie `sid` (`HttpOnly; Secure; SameSite=Lax`).
3. Mỗi request `/api/*` (trừ login/logout) qua middleware `auth`: băm cookie, tra `sessions` ⨝ `users` (còn hạn, `active=1`). Khóa user hoặc đặt lại mật khẩu sẽ xóa các phiên của họ.

### 4.2 Upload văn bản
```
Trình duyệt ──multipart──► POST /api/docs
   Worker: kiểm quyền ghi → validate field → kiểm tra đuôi file, ≤25MB
        → ensureFolder(huong, loai)   [đọc cache drive_folders; chưa có thì tìm/tạo trên Drive]
        → uploadFile(...)             [Drive multipart upload, trả drive_file_id]
        → INSERT documents (+ search_text)  → audit_log("create")
```
Nếu Drive lỗi thì **chưa ghi** vào DB (không có bản ghi "mồ côi"). Ngược lại nếu bước ghi DB lỗi sau khi upload, file có thể còn trên Drive mà không có bản ghi (hiếm; dọn tay).

### 4.3 Xem / tải file
`GET /api/docs/:id/file` → tra `drive_file_id` → Worker tải từ Drive (`alt=media`) bằng access token của chủ → **stream** body về trình duyệt với `Content-Type` đã lưu, `Content-Disposition` inline (PDF/ảnh) hoặc attachment, `nosniff`, `Cache-Control: private`. Word/Excel được trình duyệt tải về rồi tự render (docx-preview / SheetJS), Worker không xử lý nội dung.

### 4.4 Tra cứu
`GET /api/docs` ghép điều kiện từ bộ lọc, **luôn dùng tham số bind** (không nối chuỗi). Từ khóa: bỏ dấu (`norm`), tách từ, mỗi từ là một điều kiện `search_text LIKE %từ%` (AND). Phân trang `LIMIT/OFFSET`, tối đa 100 dòng/trang; sắp xếp `ngay_nhan DESC, id DESC`.

### 4.5 Trích xuất bằng AI
1. Trình duyệt: PDF/ảnh/.txt gửi nguyên file; `.docx`/`.xlsx`/`.xls` được đọc chữ tại trình duyệt rồi gửi dạng `text` (Gemini không đọc trực tiếp hai định dạng này).
2. `POST /api/extract` (quyền ghi): dựng `contents` = prompt + (file `inline_data` | text), yêu cầu `responseMimeType: application/json` kèm `responseSchema` (`trich_yeu`, `tom_tat`, `don_vi_soan_thao`, `so_van_ban`).
3. Gọi Gemini **qua service binding `GEMINI`** tới `gemini-proxy`; khi chạy local (không có binding) gọi thẳng.
4. Server cắt cứng số từ (`trich_yeu` ≤ 20, `tom_tat` ≤ 100) và trả JSON; form chỉ ghi đè ô khi AI có kết quả, người dùng kiểm tra rồi mới lưu.
Prompt và tên model nằm trong `src/worker/index.ts` (`EXTRACT_PROMPT`, `GEMINI_MODEL`).

### 4.6 Admin đổi Hướng/Loại
`PUT /api/docs/:id` với `huong`/`loai` khác bản cũ: chỉ admin → `ensureFolder` thư mục đích → `moveFile` (Drive `addParents`/`removeParents`) → mới `UPDATE` DB. Chuyển file lỗi thì DB không đổi.

### 4.7 Đổi folder gốc Drive
Admin lưu link/ID mới → ghi `settings` và **xóa cache `drive_folders`** của hướng đó. Văn bản cũ vẫn trỏ đúng file theo `drive_file_id` (không phụ thuộc folder); chỉ văn bản upload sau mới vào folder mới.

## 5. Bảo mật

| Vấn đề | Cách xử lý |
|---|---|
| Lưu mật khẩu | PBKDF2-SHA256 + salt ngẫu nhiên mỗi user; so sánh hằng thời gian |
| Phiên | Token ngẫu nhiên, DB chỉ lưu băm; cookie `HttpOnly; Secure; SameSite=Lax` |
| CSRF | Request ghi (khác GET/HEAD) có header `Origin` phải cùng host; thêm `SameSite=Lax` |
| Phân quyền | Kiểm tra ở **server** theo từng route (`auth`, `needWrite`, `needAdmin`, `canEdit`); giao diện chỉ ẩn nút cho tiện |
| SQL injection | Toàn bộ truy vấn dùng `bind()` |
| Truy cập file | File Drive không công khai; chỉ đọc qua `/api/docs/:id/file` sau khi đăng nhập |
| Bí mật | `GOOGLE_*` và `GEMINI_API_KEY` là **Worker Secret** (không nằm trong code/`wrangler.toml`/git); `.dev.vars` đã trong `.gitignore` |
| Proxy Gemini | Không có địa chỉ công khai, chỉ nhận qua service binding, chỉ cho đúng một đường dẫn `generateContent` |
| Phạm vi quyền Drive | Refresh token có scope `drive` (toàn quyền Drive của tài khoản chủ). Nên dùng tài khoản riêng cho app nếu lo ngại |
| Dữ liệu cá nhân | `Danh sách_user.csv` có SĐT/email; không đưa lên git công khai |

Rủi ro còn lại: mật khẩu ban đầu giống nhau (`654321`) và **không bắt buộc đổi**; chưa giới hạn số lần đăng nhập sai (có thể bổ sung Cloudflare WAF rate limiting).

## 6. Hạn mức và khả năng chịu tải

Với quy mô ~100 người/ngày, ~30 văn bản/ngày (khoảng 11.000 văn bản/năm), các hạn mức free tier (kiểm tra con số hiện hành trên trang giá Cloudflare) còn dư rất nhiều:

| Tài nguyên | Hạn mức free (tham khảo) | Mức dùng ước tính |
|---|---|---|
| Worker requests | 100.000/ngày | vài nghìn/ngày (mỗi lần xem file là 1 request) |
| Worker CPU | ~10 ms/request | login ~60 ms thực tế do PBKDF2 chạy bằng mã native; đã thử, không vượt |
| D1 lưu trữ | 5 GB | ~vài chục MB sau nhiều năm (chỉ metadata) |
| D1 đọc/ghi | 5 triệu hàng đọc, 100.000 hàng ghi/ngày | tìm kiếm quét bảng (`LIKE`) nên đọc nhiều hơn: ~11 nghìn hàng/lần tìm sau 1 năm |
| Drive | Dung lượng tài khoản chủ | do chủ app quản lý (15 GB free dùng chung Gmail/Photos) |
| Gemini | Free tier có hạn mức theo ngày/phút | ≤30 lần/ngày |

Điểm cần theo dõi nhất là **hàng đọc của D1** khi dữ liệu lớn và nhiều lượt tìm từ khóa (mỗi lần tìm quét cả bảng).

## 7. Quyết định thiết kế và đánh đổi

| Quyết định | Lý do | Đánh đổi |
|---|---|---|
| Một Worker + static assets, không dùng Pages riêng | Một nơi deploy, không CORS | Frontend và API deploy cùng lúc |
| File ở Google Drive, không dùng R2 | Người dùng quen Drive, sẵn dung lượng, người quản trị có thể xem/sao lưu trực tiếp | Phụ thuộc OAuth token của một tài khoản; tốc độ phụ thuộc Drive API |
| OAuth refresh token (không dùng Service Account) | Service Account không có dung lượng lưu trữ nên upload vào folder My Drive bị `storageQuotaExceeded` | Token gắn với một tài khoản, cần publish app OAuth để không hết hạn 7 ngày |
| Stream file qua Worker thay vì link Drive công khai | Bắt buộc đăng nhập, không lộ link | Mỗi lượt xem tốn 1 request Worker và băng thông qua Cloudflare |
| Tìm kiếm bằng `search_text` + `LIKE` | Đơn giản, hỗ trợ tìm không dấu, không cần FTS | Quét bảng; sẽ chậm khi dữ liệu rất lớn (chuyển FTS5 khi cần) |
| Render Word/Excel ở trình duyệt | Worker free giới hạn CPU, không có công cụ chuyển đổi | Bố cục hiển thị gần đúng; `.doc`, `.ppt` không xem được |
| AI qua `gemini-proxy` đặt vùng Mỹ | Tránh lỗi vị trí của Gemini mà không làm chậm cả app | Thêm một Worker phải deploy; thêm ~1 chặng mạng cho nút AI |
| Router theo hash | Không cần cấu hình rewrite | URL có `#` |
| `LOAI` đặt cứng trong code (cả server lẫn web) | Danh sách ít đổi, validate được ở server | Đổi phải sửa 2 file và deploy lại |

## 8. Hướng mở rộng

- **FTS5** cho D1 nếu tìm kiếm chậm hoặc cần xếp hạng kết quả.
- Trang **thêm/sửa user** trong Cấu hình (hiện chỉ nhập qua CSV + `npm run seed`).
- Bắt đổi mật khẩu lần đầu và giới hạn đăng nhập sai.
- Nhiều file đính kèm cho một văn bản (thêm bảng `attachments`).
- Đưa danh mục loại văn bản vào bảng `settings` để admin tự sửa.
- Bản sao lưu D1 và Drive tự động (Cron Trigger + `wrangler d1 export`).
