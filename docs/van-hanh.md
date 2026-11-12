# Hướng dẫn vận hành – Quản lý văn bản

Tài liệu cho người triển khai và vận hành app trên **Cloudflare** (Worker + D1) với file lưu trên **Google Drive**. Mô tả chức năng xem `README.md`, kiến trúc xem `docs/system-architecture.md`.

Mục lục
1. [Yêu cầu](#1-yêu-cầu)
2. [Cài đặt lần đầu](#2-cài-đặt-lần-đầu)
3. [Cấu hình: secret, biến và file cấu hình](#3-cấu-hình-secret-biến-và-file-cấu-hình)
4. [Xóa dữ liệu test trước khi chạy thật](#4-xóa-dữ-liệu-test-trước-khi-chạy-thật)
5. [Chạy lần đầu và thiết lập ban đầu](#5-chạy-lần-đầu-và-thiết-lập-ban-đầu)
6. [Chạy thường trực](#6-chạy-thường-trực)
7. [Vận hành hằng ngày](#7-vận-hành-hằng-ngày)
8. [Cập nhật phiên bản mới](#8-cập-nhật-phiên-bản-mới)
9. [Xử lý sự cố thường gặp](#9-xử-lý-sự-cố-thường-gặp)

> **Lưu ý khi gõ lệnh:** các lệnh dưới đây chạy trong thư mục dự án (`D:\project\quanlyvanban`). Lệnh có `$env:...` chỉ chạy trong **PowerShell**; trong cmd dùng `set TEN=gia_tri`.

---

## 1. Yêu cầu

| Thành phần | Yêu cầu |
|---|---|
| Máy cài đặt/deploy | Windows/macOS/Linux có **Node.js 20+** và npm. Chỉ cần khi cài đặt và cập nhật; app chạy hoàn toàn trên Cloudflare, **không cần server riêng** |
| Tài khoản Cloudflare | Free tier là đủ (Workers + D1). Cần quyền tạo Worker và D1 |
| Tài khoản Google (chủ Drive) | Sở hữu hoặc có quyền **Editor** trên hai folder "Văn bản đến" và "Văn bản đi". File upload sẽ **thuộc sở hữu và chiếm dung lượng** của tài khoản này |
| Google Cloud project | Bật **Google Drive API**, có **OAuth client** loại Web application, app OAuth ở trạng thái **In production** (nếu để Testing, refresh token hết hạn sau 7 ngày) |
| Gemini API key | Tạo tại https://aistudio.google.com/apikey (chỉ cần nếu dùng nút "Trích xuất bằng AI") |
| File user | `Danh sách_user.csv` ở thư mục gốc dự án, có các cột `username, full_name, ds_ban, ds_phong, ds_to, bac_vtvl, ds_vai_tro, JobTitles, Email, phone` (UTF-8, có hoặc không BOM) |

## 2. Cài đặt lần đầu

### 2.1 Lấy source và cài thư viện
```powershell
cd D:\project\quanlyvanban
npm install
```
Source cần có: `src\`, `web\`, `workers\`, `migrations\`, `scripts\`, `docs\`, `package.json`, `wrangler.toml`, `tsconfig.json`, `vite.config.ts`, `Danh sách_user.csv`. **Không** chép `node_modules\`, `dist\`, `.wrangler\`, `.dev.vars`, `seed_users.sql`.

### 2.2 Đăng nhập Cloudflare và tạo database
```powershell
npx wrangler login
npx wrangler d1 create quanlyvanban
```
Lệnh sau in ra `database_id`. Mở `wrangler.toml`, điền vào `database_id` của khối `[[d1_databases]]`.

### 2.3 Chuẩn bị Google (làm một lần)
1. Google Cloud Console → chọn/tạo project → **APIs & Services → Library → Google Drive API → Enable**.
2. **Google Auth Platform → Branding:** điền tên app, email hỗ trợ, Application home page, Privacy policy link (dùng URL Worker, ví dụ `https://quanlyvanban.<tài-khoản>.workers.dev`), nếu được hỏi thì thêm `workers.dev` vào Authorized domains → Save.
3. **Audience → Publish app → Confirm** (chuyển sang *In production*). Nút này mờ nếu Branding chưa đủ.
4. **Clients → Create client → Web application**, thêm **Authorized redirect URI** `http://localhost:53682/cb`. Ghi lại Client ID và Client Secret.
5. Lấy refresh token, đăng nhập bằng **tài khoản chủ Drive**:
   ```powershell
   $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; npm run oauth
   ```
   Mở link in ra; nếu có cảnh báo "Google hasn't verified this app" bấm **Advanced → Go to … (unsafe)**. Terminal in ra `GOOGLE_REFRESH_TOKEN=...`.

> Nếu đã có bộ 3 giá trị từ app khác thì dùng lại được, với điều kiện token có scope `https://www.googleapis.com/auth/drive` và do đúng tài khoản chủ Drive cấp. Dùng chung token nghĩa là thu hồi ở app này cũng làm hỏng app kia.

### 2.4 Lưu secret lên Cloudflare
Mỗi lệnh sẽ hỏi giá trị, bạn dán vào rồi Enter (không dán Secret vào chat hay file):
```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GEMINI_API_KEY
```
Lần đầu Wrangler có thể hỏi tạo Worker `quanlyvanban` – chọn Y. Phải thêm secret **dạng Secret**, không phải biến text trên dashboard (xem mục 9, "cảnh báo khác cấu hình remote").

### 2.5 Tạo bảng và nạp user
```powershell
npm run db:migrate:remote
npm run seed
npm run seed:remote
```
`npm run seed` đọc CSV, sinh `seed_users.sql` (mật khẩu `654321`; `lyhan` là admin, còn lại `read`). Chạy lại nhiều lần an toàn: chỉ thêm user chưa có, **không** đổi quyền hay mật khẩu user cũ.

### 2.6 Deploy
```powershell
npm run deploy
```
Lệnh này lần lượt: build frontend → deploy `gemini-proxy` → deploy Worker chính. Cuối cùng in địa chỉ `https://quanlyvanban.<tài-khoản>.workers.dev`.

### 2.7 Kiểm tra nhanh sau khi deploy
```powershell
npx tsc --noEmit            # kiểm tra kiểu (trước khi deploy)
npx wrangler tail           # xem log trực tiếp khi thử trên web
```
Mở địa chỉ Worker, đăng nhập `lyhan` / `654321`.

## 3. Cấu hình: secret, biến và file cấu hình

| Nơi | Tên | Ý nghĩa |
|---|---|---|
| Secret (Worker `quanlyvanban`) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | OAuth để app upload/đọc file Drive |
| Secret (Worker `quanlyvanban`) | `GEMINI_API_KEY` | Key gọi Gemini (chỉ nằm ở Worker chính, truyền tới proxy qua service binding) |
| `wrangler.toml` | `database_id` | ID D1 |
| `wrangler.toml` | `[[services]] GEMINI → gemini-proxy` | Liên kết Worker chính với proxy; phải deploy `gemini-proxy` trước |
| `workers/gemini-proxy/wrangler.toml` | `[placement] hostname` | Ép proxy chạy gần Google để tránh lỗi vị trí |
| `src/worker/index.ts` | `GEMINI_MODEL`, `EXTRACT_PROMPT`, `SESSION_DAYS`, `MAX_FILE`, `ALLOWED_EXT` | Model và prompt AI, hạn phiên (7 ngày), giới hạn file (25 MB), đuôi file cho phép |
| Trang **Cấu hình** (admin) | Folder Drive "Văn bản đến/đi" | Lưu trong bảng `settings` |
| Biến môi trường khi chạy `npm run seed` | `DEFAULT_PW` | Mật khẩu ban đầu của user mới nạp (mặc định `654321`) |
| `.dev.vars` (chỉ local) | 4 biến secret ở trên | Cho `wrangler dev`; đã trong `.gitignore` |

Xem danh sách secret đã có (không hiện giá trị): `npx wrangler secret list`.

> **Lưu ý prompt AI:** giới hạn số từ nằm ở **hai chỗ** trong `src/worker/index.ts`: chữ "tối đa 20 từ" trong `EXTRACT_PROMPT` (để AI viết ngắn) và `cut(out.trich_yeu, 20)` ở cuối route `/api/extract` (cắt cứng phía server; tương tự `tom_tat` là 100 từ). Muốn đổi giới hạn thì sửa **cả hai** chỗ cho khớp, rồi deploy lại.

## 4. Xóa dữ liệu test trước khi chạy thật

Dữ liệu test nằm ở:

| Nơi | Chứa |
|---|---|
| D1 `quanlyvanban` | văn bản, phiên đăng nhập, nhật ký, user, quyền, cấu hình folder |
| **Google Drive** | các file test đã upload, trong `Văn bản đến|đi / <Loại>` |

> **Làm trước:** backup D1 (mục 7.2). Xóa là không phục hồi được (D1 có Time Travel nhưng chỉ trong thời gian ngắn).

### Cách A – xóa văn bản và nhật ký, GIỮ user và cấu hình Drive (khuyên dùng)
```powershell
npx wrangler d1 execute quanlyvanban --remote --command "DELETE FROM documents; DELETE FROM sqlite_sequence WHERE name='documents'; DELETE FROM audit_log; DELETE FROM sessions;"
```
Lệnh này xóa văn bản, nhật ký, phiên đăng nhập (mọi người phải đăng nhập lại) và **đặt lại bộ đếm ID về 1**. User, quyền, folder Drive giữ nguyên.

### Cách B – làm sạch hoàn toàn (kể cả user và quyền)
```powershell
npx wrangler d1 execute quanlyvanban --remote --command "DELETE FROM documents; DELETE FROM sqlite_sequence; DELETE FROM audit_log; DELETE FROM sessions; DELETE FROM users; DELETE FROM drive_folders; UPDATE settings SET value='';"
npm run seed:remote
```
Sau đó nạp lại user từ CSV (mật khẩu `654321`), **phải gán lại quyền ghi** và **nhập lại link folder Drive** ở trang Cấu hình.

### Xóa file test trên Drive
App không xóa hàng loạt file trên Drive. Vào Drive, mở hai folder gốc và xóa các file test. Chỉ xóa **file** thì giữ nguyên các thư mục con. Nếu xóa luôn cả thư mục con thì phải chạy thêm lệnh dưới đây (cả cách A lẫn B), nếu không app vẫn dùng ID thư mục đã xóa và upload sẽ lỗi; sau đó app tự tạo lại thư mục ở lần upload kế tiếp:
```powershell
npx wrangler d1 execute quanlyvanban --remote --command "DELETE FROM drive_folders;"
```

### Kiểm tra sau khi xóa
1. Đăng nhập admin → trang Tra cứu trống.
2. Trang Cấu hình còn đủ user và folder Drive (cách A).
3. Upload thử 1 văn bản nhỏ: **ID đầu tiên là 1**, file nằm đúng thư mục trên Drive. Xóa văn bản thử bằng nút **Xóa** (file Drive được đưa vào thùng rác).

## 5. Chạy lần đầu và thiết lập ban đầu

Đăng nhập `lyhan` / `654321` (admin). Checklist:

- [ ] Trang **Cấu hình → Google Drive**: dán link folder gốc "Văn bản đến" và "Văn bản đi" → Lưu. Folder phải thuộc hoặc được chia sẻ **Editor** cho tài khoản chủ refresh token.
- [ ] **Cấu hình → Phân quyền user:** cấp quyền **Được ghi** cho những người phụ trách upload; còn lại để **Chỉ đọc**. Cấp thêm admin nếu cần.
- [ ] Upload thử một PDF: kiểm tra 9 thư mục con được tạo trên Drive và file nằm đúng `Văn bản đến|đi / <Loại>`.
- [ ] Bấm **✨ Trích xuất bằng AI** với file thử: ba bốn ô tự điền.
- [ ] Mở thử một file `.docx` và `.xlsx` để kiểm tra xem trước.
- [ ] Thử đăng nhập bằng một tài khoản chỉ đọc: không thấy nút upload, vào `#/admin` bị từ chối.
- [ ] Thông báo cho người dùng địa chỉ app và mật khẩu ban đầu `654321`; nhắc họ **tự đổi mật khẩu** ở trang tài khoản (tên hiển thị góc trên bên phải), vì app không bắt buộc đổi.
- [ ] Dọn dữ liệu thử (mục 4).

## 6. Chạy thường trực

App chạy trên hạ tầng Cloudflare nên **không cần cài dịch vụ, không cần chạy lại sau khi khởi động máy**. Không có gì phải bật/tắt bằng tay.

- **Địa chỉ:** mặc định `https://quanlyvanban.<tài-khoản>.workers.dev`. Muốn tên miền riêng: Cloudflare Dashboard → Workers & Pages → `quanlyvanban` → Settings → Domains & Routes → Add custom domain (cần domain đã quản lý trên Cloudflare).
- **Xem log trực tiếp:** `npx wrangler tail` (hoặc Dashboard → Worker → Logs/Observability).
- **Xem trạng thái/phiên bản:** Dashboard → Worker → Deployments. Hoàn tác về bản trước: `npx wrangler rollback`.
- **Dừng khẩn cấp:** Dashboard → Worker → Settings → tắt route/`workers.dev` hoặc xóa deployment; hoặc khóa tài khoản người dùng ở trang Cấu hình.

Điều cần nhớ: **Google refresh token** là điểm hỏng thường gặp nhất. Nếu token bị thu hồi hoặc hết hạn, mọi upload/xem file sẽ báo lỗi `invalid_grant` (cách xử lý ở mục 9).

## 7. Vận hành hằng ngày

### 7.1 Quy trình sử dụng (nhắc người dùng)

1. **Người có quyền ghi:** vào **+ Upload văn bản** → chọn Hướng, Loại → chọn file → (tùy chọn) **✨ Trích xuất bằng AI** → kiểm tra lại các ô Trích yếu, Tóm tắt, Số văn bản, Đơn vị soạn thảo, Ngày nhận → **Upload**. Chờ hết thông báo "Đang lưu…", không đóng tab.
2. **Mọi người dùng:** vào **Tra cứu**, chọn thẻ loại, lọc theo hướng/ngày/đơn vị, hoặc gõ từ khóa (có dấu hay không dấu) → bấm dòng để xem file và chi tiết.
3. **Nhập sai thông tin:** người upload (hoặc admin) bấm **Sửa** ở trang chi tiết. Chỉ **admin** đổi được Hướng/Loại.
4. **Văn bản không còn cần:** bấm **Xóa** (file Drive vào thùng rác Drive của chủ, còn khôi phục được trong ~30 ngày).

Lưu ý: file tối đa **25 MB**; định dạng cho phép `pdf, doc, docx, xls, xlsx, ppt, pptx, jpg, jpeg, png, txt`. Mỗi văn bản một file; muốn nhiều file thì ghép lại thành một PDF.

### 7.2 Backup

| Cần backup | Cách làm |
|---|---|
| Dữ liệu D1 (văn bản, user, quyền, nhật ký) | `npx wrangler d1 export quanlyvanban --remote --output backup-AAAAMMDD.sql` (nên làm mỗi tuần, và trước mỗi lần xóa/ cập nhật lớn). Khôi phục: `npx wrangler d1 execute quanlyvanban --remote --file=backup-AAAAMMDD.sql` trên DB trống |
| Khôi phục theo thời điểm | D1 **Time Travel**: `npx wrangler d1 time-travel info quanlyvanban` / `restore` (thời gian lưu giữ tùy gói, xem trên dashboard) |
| File văn bản | Nằm trong Google Drive của tài khoản chủ: dựa vào lịch sử/thùng rác của Drive; muốn chắc hơn thì định kỳ tải thư mục về hoặc đồng bộ bằng Google Drive for desktop |
| Mã nguồn | Git (không commit `Danh sách_user.csv`, `.dev.vars`, `seed_users.sql`) |
| Secret | Cất bản gốc của 4 giá trị ở nơi an toàn (trình quản lý mật khẩu); Cloudflare không cho đọc lại secret |

File backup `.sql` chứa mật khẩu đã băm và thông tin cá nhân của user: bảo quản như dữ liệu nhạy cảm.

### 7.3 Theo dõi hạn mức

Vào Cloudflare Dashboard → **Workers & Pages → quanlyvanban → Metrics** (requests, lỗi) và **Storage & Databases → D1 → quanlyvanban** (dung lượng, rows read/written). Quy mô hiện tại (khoảng 100 người, 30 văn bản/ngày) dùng rất ít so với hạn mức free. Điểm cần để ý khi dữ liệu lên hàng chục nghìn văn bản: **rows read** của D1 do tìm từ khóa quét bảng. Dung lượng Drive: xem tại https://drive.google.com/settings/storage (tài khoản chủ).

### 7.4 Log

`npx wrangler tail` cho log trực tiếp. Mỗi thao tác quan trọng cũng được ghi vào bảng `audit_log`, xem ở **Cấu hình → Nhật ký** (200 dòng gần nhất, giờ UTC): `create`, `update`, `delete`, `user_update`, `reset_password`, `settings`, `ai_extract`.

### 7.5 Quản lý người dùng

- **User mới / đổi thông tin ban phòng:** thêm dòng vào `Danh sách_user.csv`, rồi chạy `npm run seed` + `npm run seed:remote`. Lệnh chỉ **thêm user chưa có**; user cũ giữ nguyên (không đổi quyền, mật khẩu, ban/phòng). Muốn sửa thông tin user cũ thì sửa trực tiếp bằng SQL, ví dụ: `npx wrangler d1 execute quanlyvanban --remote --command "UPDATE users SET phong='Phòng X' WHERE username='abc'"`.
- **Cấp/thu quyền, khóa tài khoản:** trang **Cấu hình → Phân quyền user**. Khóa tài khoản sẽ đăng xuất ngay mọi phiên của họ. Không thể tự hạ quyền/khóa chính mình.
- **Quên mật khẩu:** admin bấm **Reset mật khẩu** (về `654321`) và báo người dùng đổi lại.
- **Đổi mật khẩu mặc định cho user nạp mới:** `$env:DEFAULT_PW="matkhaumoi"; npm run seed` (chỉ ảnh hưởng user chưa có trong DB).
- **Xóa hẳn user:** chưa có trong giao diện. Nên **khóa** thay vì xóa (xóa user có văn bản sẽ vướng khóa ngoại `created_by`).

### 7.6 Thay đổi danh mục loại văn bản

Danh sách 9 loại đặt cứng ở **hai nơi**, phải sửa cả hai cho giống nhau rồi deploy lại:
- `src/worker/util.ts` → `LOAI` (server kiểm tra hợp lệ và tạo thư mục Drive).
- `web/src/api.ts` → `LOAI` (giao diện: thẻ tag, dropdown).

Thêm loại mới: không ảnh hưởng gì dữ liệu cũ; thư mục Drive tạo tự động ở lần upload đầu của loại đó. **Đổi tên** loại làm văn bản cũ vẫn mang tên loại cũ (không khớp thẻ mới) – nếu cần phải cập nhật DB: `UPDATE documents SET loai='Tên mới' WHERE loai='Tên cũ'` và đổi tên thư mục trên Drive, rồi `DELETE FROM drive_folders WHERE loai='Tên cũ'`.

### 7.7 Đổi folder Drive giữa chừng

Đổi link ở trang Cấu hình chỉ áp dụng cho văn bản upload **sau đó**. File đã upload vẫn nằm ở folder cũ nhưng app đọc bằng ID file nên **vẫn xem được bình thường** miễn là chủ token còn quyền với file đó. Không xóa hoặc thu hồi chia sẻ folder cũ nếu còn văn bản trỏ vào đó.

### 7.8 Đổi tài khoản Google hoặc xoay vòng key

- **Đổi Gemini key:** `npx wrangler secret put GEMINI_API_KEY` (có hiệu lực ngay, không cần deploy).
- **Đổi tài khoản Google/ lấy lại refresh token:** làm lại mục 2.3 bước 5, rồi `npx wrangler secret put GOOGLE_REFRESH_TOKEN` (và Client ID/Secret nếu đổi client). Tài khoản mới phải có quyền Editor trên hai folder gốc. File đang có vẫn thuộc chủ cũ: chủ cũ phải còn chia sẻ cho tài khoản mới.

## 8. Cập nhật phiên bản mới

1. Lấy code mới (`git pull` hoặc chép đè `src\`, `web\`, `workers\`, `migrations\`, `scripts\`, `package.json`…). **Không** chép đè `wrangler.toml` nếu đã điền `database_id` (hoặc điền lại), và không động tới `Danh sách_user.csv`.
2. `npm install` nếu `package.json` thay đổi.
3. Có file mới trong `migrations\` (ví dụ `0002_*.sql`) thì backup D1 (mục 7.2) rồi chạy: `npm run db:migrate:remote`. Migration chỉ chạy các file chưa áp dụng.
4. `npx tsc --noEmit` rồi `npm run deploy`. Hiệu lực ngay cho mọi người dùng; không có thời gian gián đoạn.
5. Người dùng thấy giao diện cũ thì bảo họ Ctrl+F5.
6. Có sự cố sau cập nhật: `npx wrangler rollback` về bản Worker trước (lưu ý: **không** hoàn tác migration D1).

## 9. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Upload báo `Không lấy được access token Google: invalid_grant` | Refresh token hết hạn/bị thu hồi, hoặc không khớp Client ID/Secret. Kiểm tra app OAuth đã **In production**; lấy lại token (mục 2.3 bước 5) và `wrangler secret put GOOGLE_REFRESH_TOKEN`; gõ lại cả Client ID/Secret nếu nghi nhập sai (thừa dấu cách) |
| `Google Drive API has not been used in project … or it is disabled` (403) | Chưa bật Drive API trong project Google Cloud chứa OAuth client. Bật tại APIs & Services → Library → Google Drive API → Enable, chờ 1–2 phút |
| `Access blocked … redirect_uri_mismatch` khi chạy `npm run oauth` | OAuth client chưa có redirect URI `http://localhost:53682/cb` (đúng `http`, không `/` ở cuối) hoặc client không phải loại Web application |
| `Publish app` bị mờ | Chưa điền đủ Branding (tên app, email, home page, privacy policy URL) |
| `Admin chưa cấu hình folder Drive cho …` | Chưa dán link folder ở Cấu hình → Google Drive |
| `File not found` / `insufficientPermissions` khi upload hoặc xem | Folder không thuộc/ không được chia sẻ **Editor** cho tài khoản của refresh token; hoặc token sai scope (cần `drive`) |
| `storageQuotaExceeded` | Tài khoản chủ token hết dung lượng Drive; giải phóng dung lượng hoặc dùng tài khoản khác |
| Upload dùng được nhưng nút AI báo `User location is not supported` | Cuộc gọi Gemini không đi qua `gemini-proxy`. Chạy `npm run deploy` (phải deploy proxy trước) và kiểm tra khối `[[services]]` trong `wrangler.toml`. Nếu vẫn lỗi, đổi `[placement]` của proxy sang `region = "aws:us-east-1"` rồi `npm run deploy:proxy` |
| Nút AI báo `Chưa cấu hình GEMINI_API_KEY` | Chưa có secret hoặc đặt sai Worker. `npx wrangler secret put GEMINI_API_KEY` ở thư mục dự án |
| Nút AI báo `Gemini lỗi: …` | Lỗi từ Google: key sai/bị khóa, hết hạn mức, tên model không còn. Xem thông báo chi tiết; đổi `GEMINI_MODEL` nếu cần |
| `.doc` / `.ppt` không xem trước được, AI không hỗ trợ | Chỉ hỗ trợ `.docx`, `.xlsx/.xls`, PDF, ảnh. File cũ thì tải về hoặc chuyển sang `.docx`/PDF trước khi upload |
| `wrangler secret put` báo `Required Worker name missing` | Đang không đứng trong thư mục dự án (không thấy `wrangler.toml`). `cd D:\project\quanlyvanban` |
| Deploy cảnh báo "local configuration differs from the remote configuration" có dòng `- GEMINI_API_KEY` | Key đã được thêm trên dashboard dạng **biến text** nên deploy sẽ xóa. Chọn Y, rồi `wrangler secret put GEMINI_API_KEY` để lưu lại dạng **Secret** (Secret không bị deploy xóa). Đừng chép key vào `wrangler.toml` |
| `$env:...: The filename, directory name, or volume label syntax is incorrect` | Đang ở cmd chứ không phải PowerShell (xem lưu ý đầu tài liệu) |
| Đăng nhập thành công nhưng gọi API tiếp theo bị 401 khi test bằng công cụ dòng lệnh qua `http://` | Cookie đặt cờ `Secure`: trình duyệt chấp nhận trên `localhost`, còn `curl`/PowerShell thì phải gắn tay header `Cookie` |
| Tìm kiếm chậm / D1 vượt hạn mức đọc | Dữ liệu lớn, `LIKE` quét cả bảng. Thu hẹp bằng bộ lọc, hoặc nâng cấp sang FTS5 (xem `system-architecture.md` mục 8) |
| Không ai đăng nhập được | `npx wrangler d1 execute quanlyvanban --remote --command "SELECT COUNT(*) FROM users"`: bảng trống thì chạy lại `npm run seed:remote`. Kiểm tra `database_id` trong `wrangler.toml` đúng DB |
| Người dùng báo "Phiên hết hạn" liên tục | Phiên sống 7 ngày; admin vừa khóa/reset mật khẩu cũng xóa phiên. Đăng nhập lại. Nếu xảy ra hàng loạt, kiểm tra đồng hồ/giờ của máy người dùng |
| Xóa văn bản nhưng Drive vẫn còn file | Việc đưa vào thùng rác Drive lỗi (token/quyền) nhưng bản ghi đã xóa (chỉ ghi log). Dọn tay trên Drive |
| File trên Drive bị chuyển/xóa tay, app báo `Không đọc được file từ Drive` | Bản ghi trỏ file không còn. Khôi phục file từ thùng rác Drive (giữ nguyên ID) hoặc xóa bản ghi và upload lại |
