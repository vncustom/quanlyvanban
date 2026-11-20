-- Theo dõi trạng thái "đã đọc" của từng user đối với từng văn bản
CREATE TABLE doc_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, doc_id)
);
CREATE INDEX idx_doc_reads_doc ON doc_reads(doc_id);
