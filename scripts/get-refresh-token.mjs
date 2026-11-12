// Lấy OAuth refresh token cho Google Drive (chạy 1 lần trên máy bạn).
// Cách dùng: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
// Trên Google Cloud, OAuth client loại "Web application" với redirect URI: http://localhost:53682/cb
import http from "node:http";

const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) { console.error("Thiếu GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"); process.exit(1); }
const redirect = "http://localhost:53682/cb";
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code",
  scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent",
});
console.log("Mở link này trong trình duyệt và đăng nhập tài khoản Google sở hữu folder:\n\n" + url + "\n");

http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== "/cb") { res.end(); return; }
  const code = u.searchParams.get("code");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const j = await r.json();
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(j.refresh_token ? "Xong, xem refresh token trong terminal." : "Lỗi: " + JSON.stringify(j));
  console.log(j.refresh_token ? "\nGOOGLE_REFRESH_TOKEN=" + j.refresh_token : j);
  process.exit(0);
}).listen(53682);
