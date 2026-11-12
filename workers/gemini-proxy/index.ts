// Worker proxy nhỏ: chỉ chuyển tiếp request tới Gemini API.
// Chạy ở gần máy chủ Google (xem [placement] trong wrangler.toml) để tránh lỗi "User location is not supported".
// Không public ra Internet (workers_dev = false), chỉ Worker chính gọi được qua service binding.
export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (req.method !== "POST" || !/^\/v1beta\/models\/[\w.-]+:generateContent$/.test(u.pathname))
      return new Response("Not found", { status: 404 });
    return fetch("https://generativelanguage.googleapis.com" + u.pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": req.headers.get("x-goog-api-key") || "" },
      body: req.body,
    });
  },
};
