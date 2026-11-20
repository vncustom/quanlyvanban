-- Upload văn bản tự động từ folder Google Drive dùng chung
INSERT OR IGNORE INTO settings(key,value) VALUES
  ('import_enabled','0'),      -- 1 = bật
  ('import_folder',''),        -- ID folder nguồn (folder chia sẻ full quyền)
  ('import_interval','1'),     -- số phút giữa 2 văn bản (tối thiểu 1, tránh rate limit API)
  ('import_user_id',''),       -- user đứng tên "người upload" (admin lưu cấu hình)
  ('import_last_start','0'),   -- ms: lần xử lý gần nhất (giãn cách giữa 2 văn bản)
  ('import_lock','0'),         -- ms: khóa chống 2 lượt chạy chồng nhau
  ('import_last_run',''),      -- ISO: lần chạy gần nhất
  ('import_last_msg','');      -- kết quả lần chạy gần nhất

-- Lỗi theo từng file (file_id = '_system' cho lỗi chung, vd không đọc được folder)
CREATE TABLE import_errors (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  stage TEXT NOT NULL,          -- validate | list | download | extract | folder | move | save
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,  -- >= 2: ngừng tự thử lại, chờ admin bấm "Thử lại"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
