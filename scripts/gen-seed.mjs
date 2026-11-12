// Đọc "Danh sách_user.csv" -> sinh seed_users.sql (mật khẩu mặc định 654321)
import { readFileSync, writeFileSync } from "node:fs";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITER = 50000; // phải khớp src/worker/util.ts
const DEFAULT_PW = process.env.DEFAULT_PW || "654321";

function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const text = readFileSync("Danh sách_user.csv", "utf8").replace(/^﻿/, "");
const [head, ...data] = parseCsv(text).filter((r) => r.some((x) => x.trim()));
const idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
const g = (r, k) => (r[idx[k]] ?? "").trim();
const esc = (s) => (s === "" ? "NULL" : `'${s.replace(/'/g, "''")}'`);

const out = [];
const seen = new Set();
for (const r of data) {
  const username = g(r, "username");
  if (!username || seen.has(username.toLowerCase())) continue;
  seen.add(username.toLowerCase());
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(DEFAULT_PW, salt, ITER, 32, "sha256");
  const stored = `pbkdf2$${ITER}$${salt.toString("base64")}$${hash.toString("base64")}`;
  const role = username.toLowerCase() === "lyhan" ? "admin" : "read";
  out.push(
    `INSERT OR IGNORE INTO users(username,full_name,role,password_hash,ban,phong,to_nhom,chuc_danh,vai_tro,email,phone) VALUES (` +
      [esc(username), esc(g(r, "full_name") || username), esc(role), esc(stored), esc(g(r, "ds_ban")),
       esc(g(r, "ds_phong")), esc(g(r, "ds_to")), esc(g(r, "JobTitles")), esc(g(r, "ds_vai_tro")),
       esc(g(r, "Email")), esc(g(r, "phone"))].join(",") + ");"
  );
}
writeFileSync("seed_users.sql", out.join("\n") + "\n", "utf8");
console.log(`Đã sinh seed_users.sql với ${out.length} user (admin: lyhan).`);
