CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read' CHECK (role IN ('admin','write','read')),
  password_hash TEXT NOT NULL,
  ban TEXT, phong TEXT, to_nhom TEXT, chuc_danh TEXT, vai_tro TEXT, email TEXT, phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  so_van_ban TEXT NOT NULL,
  don_vi_soan_thao TEXT NOT NULL,
  huong TEXT NOT NULL CHECK (huong IN ('den','di')),
  loai TEXT NOT NULL,
  trich_yeu TEXT NOT NULL,
  tom_tat TEXT NOT NULL DEFAULT '',
  drive_file_id TEXT NOT NULL,
  ten_file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  ngay_nhan TEXT NOT NULL,
  ghi_chu TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_docs_ngay ON documents(ngay_nhan DESC, id DESC);
CREATE INDEX idx_docs_huong_loai ON documents(huong, loai);
CREATE INDEX idx_docs_donvi ON documents(don_vi_soan_thao);
CREATE INDEX idx_docs_so ON documents(so_van_ban);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key,value) VALUES ('drive_folder_den',''),('drive_folder_di','');

CREATE TABLE drive_folders (
  huong TEXT NOT NULL, loai TEXT NOT NULL, folder_id TEXT NOT NULL,
  PRIMARY KEY (huong, loai)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT NOT NULL, doc_id INTEGER, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
