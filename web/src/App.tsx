import { useEffect, useState, FormEvent } from "react";
import { api, User, Doc, LOAI, fmtDate, huongLabel } from "./api";
import Preview from "./Preview";
import { fileToText, extOf } from "./extract";

const useHash = () => {
  const [h, setH] = useState(location.hash || "#/");
  useEffect(() => {
    const f = () => setH(location.hash || "#/");
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h;
};
const go = (h: string) => { location.hash = h; };
const today = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const hash = useHash();
  useEffect(() => { api("/me").then(setUser).catch(() => setUser(null)); }, []);
  if (user === undefined) return <p style={{ padding: 20 }}>Đang tải…</p>;
  if (!user) return <Login onOk={setUser} />;

  const logout = async () => { await api("/logout", { method: "POST", body: {} }); setUser(null); go("#/"); };
  const canWrite = user.role !== "read";
  const [, route, arg] = hash.split("/");

  return (
    <>
      <header>
        <h1>📁 Quản lý văn bản</h1>
        <a href="#/">Tra cứu</a>
        {canWrite && <a href="#/new">+ Upload văn bản</a>}
        {user.role === "admin" && <a href="#/admin">Cấu hình</a>}
        <a href="#/account" className="muted">{user.full_name}</a>
        <button className="ghost" onClick={logout}>Đăng xuất</button>
      </header>
      <main>
        {route === "doc" ? <DocView id={arg} user={user} />
          : route === "new" && canWrite ? <DocForm />
          : route === "admin" && user.role === "admin" ? <Admin me={user} />
          : route === "account" ? <Account />
          : <DocList />}
      </main>
    </>
  );
}

function Login({ onOk }: { onOk: (u: User) => void }) {
  const [username, setU] = useState(""), [password, setP] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { onOk(await api("/login", { body: { username, password } })); } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>Quản lý văn bản</h1>
      <label>Tên đăng nhập</label><input value={username} onChange={(e) => setU(e.target.value)} autoFocus autoCapitalize="none" />
      <div style={{ height: 10 }} />
      <label>Mật khẩu</label><input type="password" value={password} onChange={(e) => setP(e.target.value)} />
      {err && <p className="err">{err}</p>}
      <div style={{ height: 14 }} />
      <button style={{ width: "100%" }} disabled={busy}>Đăng nhập</button>
    </form>
  );
}

function DocList() {
  const [f, setF] = useState({ huong: "", loai: "", q: "", so: "", don_vi: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: Doc[]; size: number } | null>(null);
  const [donVi, setDonVi] = useState<string[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { api("/meta").then((m) => setDonVi(m.don_vi)).catch(() => {}); }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) });
      api("/docs?" + p).then(setData).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [f, page]);
  const set = (k: string, v: string) => { setF({ ...f, [k]: v }); setPage(1); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <>
      <div className="card">
        <div className="tabs" style={{ marginBottom: 12 }}>
          {[["", "Tất cả"], ["den", "Văn bản đến"], ["di", "Văn bản đi"]].map(([v, l]) => (
            <button key={v} className={f.huong === v ? "on" : ""} onClick={() => set("huong", v)}>{l}</button>
          ))}
        </div>
        <div className="chips">
          {["", ...LOAI].map((l) => (
            <button key={l} type="button" className={"chip" + (f.loai === l ? " on" : "")} onClick={() => set("loai", l)}>{l || "Tất cả"}</button>
          ))}
        </div>
        <div className="grid">
          <div><label>Từ khóa (trích yếu, tóm tắt…)</label><input value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="Gõ có hoặc không dấu" /></div>
          <div><label>Số văn bản</label><input value={f.so} onChange={(e) => set("so", e.target.value)} /></div>
          <div><label>Đơn vị soạn thảo</label>
            <select value={f.don_vi} onChange={(e) => set("don_vi", e.target.value)}><option value="">Tất cả</option>{donVi.map((l) => <option key={l}>{l}</option>)}</select></div>
          <div><label>Từ ngày</label><input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></div>
          <div><label>Đến ngày</label><input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        {err && <p className="err" style={{ padding: 16 }}>{err}</p>}
        <table>
          <thead><tr><th>ID</th><th>Số VB</th><th>Ngày nhận</th><th>Loại</th><th>Trích yếu</th><th className="hide-m">Đơn vị soạn thảo</th></tr></thead>
          <tbody>
            {data?.items.map((d) => (
              <tr key={d.id} className="click" onClick={() => go("#/doc/" + d.id)}>
                <td>{d.id}</td><td>{d.so_van_ban}</td><td>{fmtDate(d.ngay_nhan)}</td>
                <td><span className="tag">{huongLabel(d.huong)}</span> {d.loai}</td>
                <td>{d.trich_yeu}</td><td className="hide-m">{d.don_vi_soan_thao}</td>
              </tr>
            ))}
            {data && !data.items.length && <tr><td colSpan={6} className="muted">Không có văn bản phù hợp.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Trước</button>
        <span className="muted">Trang {page}/{pages} · {data?.total ?? 0} văn bản</span>
        <button className="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau ›</button>
      </div>
    </>
  );
}

function DocView({ id, user }: { id: string; user: User }) {
  const [d, setD] = useState<Doc | null>(null), [err, setErr] = useState(""), [edit, setEdit] = useState(false);
  const load = () => api("/docs/" + id).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (err) return <p className="err">{err}</p>;
  if (!d) return <p>Đang tải…</p>;
  const canEdit = user.role === "admin" || (user.role === "write" && d.created_by === user.id);
  const del = async () => {
    if (!confirm("Xóa văn bản này? File trên Drive sẽ được chuyển vào thùng rác.")) return;
    await api("/docs/" + id, { method: "DELETE" }); go("#/");
  };
  const row = (l: string, v: string) => <p style={{ margin: "4px 0" }}><span className="muted">{l}: </span>{v || "—"}</p>;

  return (
    <>
      <p><a href="#/">‹ Quay lại danh sách</a></p>
      <div className="card">
        {edit ? <DocForm doc={d} isAdmin={user.role === "admin"} onDone={() => { setEdit(false); load(); }} /> : (
          <>
            <h2 style={{ marginTop: 0 }}>{d.trich_yeu}</h2>
            {row("ID", String(d.id))}{row("Số văn bản", d.so_van_ban)}
            {row("Hướng / Loại", `${huongLabel(d.huong)} / ${d.loai}`)}
            {row("Đơn vị soạn thảo", d.don_vi_soan_thao)}{row("Ngày nhận", fmtDate(d.ngay_nhan))}
            {row("Tóm tắt nội dung", d.tom_tat)}{row("Ghi chú", d.ghi_chu)}{row("Người upload", d.nguoi_tao)}
            <div className="row" style={{ marginTop: 12 }}>
              <a className="btn" href={`/api/docs/${d.id}/file?download=1`}>⬇ Tải {d.ten_file}</a>
              {canEdit && <button className="ghost" onClick={() => setEdit(true)}>Sửa</button>}
              {canEdit && <button className="danger" onClick={del}>Xóa</button>}
            </div>
          </>
        )}
      </div>
      <Preview id={d.id} name={d.ten_file} mime={d.mime} />
    </>
  );
}

function DocForm({ doc, isAdmin, onDone }: { doc?: Doc; isAdmin?: boolean; onDone?: () => void }) {
  const [v, setV] = useState({
    huong: doc?.huong ?? "den", loai: doc?.loai ?? LOAI[0], so_van_ban: doc?.so_van_ban ?? "", don_vi_soan_thao: doc?.don_vi_soan_thao ?? "",
    trich_yeu: doc?.trich_yeu ?? "", tom_tat: doc?.tom_tat ?? "", ngay_nhan: doc?.ngay_nhan ?? today(), ghi_chu: doc?.ghi_chu ?? "",
  });
  const [file, setFile] = useState<File | null>(null), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const [donVi, setDonVi] = useState<string[]>([]);
  useEffect(() => { api("/meta").then((m) => setDonVi(m.don_vi)).catch(() => {}); }, []);
  const set = (k: string, x: string) => setV({ ...v, [k]: x });
  const [ai, setAi] = useState(false), [aiMsg, setAiMsg] = useState("");

  const extractAi = async () => {
    if (!file) return;
    setAi(true); setAiMsg("");
    try {
      const fd = new FormData();
      const ext = extOf(file.name);
      if (ext === "docx" || ext === "xlsx" || ext === "xls") {
        const text = await fileToText(file, file.name);
        if (!text?.trim()) throw new Error("File không có nội dung văn bản để đọc");
        fd.append("text", text);
      } else fd.append("file", file);
      const r = await api("/extract", { body: fd });
      setV((p) => ({
        ...p,
        trich_yeu: r.trich_yeu || p.trich_yeu,
        tom_tat: r.tom_tat || p.tom_tat,
        so_van_ban: r.so_van_ban || p.so_van_ban,
        don_vi_soan_thao: r.don_vi_soan_thao || p.don_vi_soan_thao,
      }));
      setAiMsg("✓ Đã điền thông tin, vui lòng kiểm tra lại.");
    } catch (x: any) { setAiMsg(x.message); }
    setAi(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr("");
    if (!doc && !file) return setErr("Chưa chọn file");
    setBusy(true);
    try {
      if (doc) { await api("/docs/" + doc.id, { method: "PUT", body: v }); onDone?.(); }
      else {
        const fd = new FormData();
        Object.entries(v).forEach(([k, x]) => fd.append(k, x));
        fd.append("file", file!);
        const r = await api("/docs", { body: fd });
        go("#/doc/" + r.id);
      }
    } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };

  return (
    <form onSubmit={submit}>
      {!doc && <h2 style={{ marginTop: 0 }}>Upload văn bản mới</h2>}
      <div className="grid">
        {(!doc || isAdmin) && <div><label>Hướng</label><select value={v.huong} onChange={(e) => set("huong", e.target.value)}><option value="den">Văn bản đến</option><option value="di">Văn bản đi</option></select></div>}
        {(!doc || isAdmin) && <div><label>Loại văn bản</label><select value={v.loai} onChange={(e) => set("loai", e.target.value)}>{LOAI.map((l) => <option key={l}>{l}</option>)}</select></div>}
        <div><label>Số văn bản</label><input value={v.so_van_ban} onChange={(e) => set("so_van_ban", e.target.value)} /></div>
        <div><label>Đơn vị soạn thảo *</label><input list="dv" value={v.don_vi_soan_thao} onChange={(e) => set("don_vi_soan_thao", e.target.value)} required /><datalist id="dv">{donVi.map((x) => <option key={x} value={x} />)}</datalist></div>
        <div><label>Ngày nhận *</label><input type="date" value={v.ngay_nhan} onChange={(e) => set("ngay_nhan", e.target.value)} required /></div>
      </div>
      <div style={{ height: 10 }} /><label>Trích yếu *</label><input value={v.trich_yeu} onChange={(e) => set("trich_yeu", e.target.value)} required />
      <div style={{ height: 10 }} /><label>Tóm tắt nội dung</label><textarea rows={4} value={v.tom_tat} onChange={(e) => set("tom_tat", e.target.value)} />
      <div style={{ height: 10 }} /><label>Ghi chú</label><input value={v.ghi_chu} onChange={(e) => set("ghi_chu", e.target.value)} />
      {!doc && <><div style={{ height: 10 }} /><label>File đính kèm * (PDF, Word, Excel, ảnh… tối đa 25MB)</label>
        <input type="file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setAiMsg(""); }} />
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="ghost" disabled={!file || ai} onClick={extractAi}>{ai ? "AI đang đọc văn bản…" : "✨ Trích xuất bằng AI"}</button>
          <span className="muted">Điền tự động Trích yếu, Tóm tắt, Số văn bản, Đơn vị soạn thảo. Bạn nên kiểm tra lại trước khi lưu.</span>
        </div>
        {aiMsg && <p className={aiMsg.startsWith("✓") ? "ok" : "err"}>{aiMsg}</p>}</>}
      {err && <p className="err">{err}</p>}
      <div className="row" style={{ marginTop: 14 }}>
        <button disabled={busy}>{busy ? "Đang lưu…" : doc ? "Lưu thay đổi" : "Upload"}</button>
        {doc && <button type="button" className="ghost" onClick={onDone}>Hủy</button>}
      </div>
    </form>
  );
}

function Account() {
  const [o, setO] = useState(""), [n, setN] = useState(""), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg(""); setErr("");
    try { await api("/change-password", { body: { old_password: o, new_password: n } }); setMsg("Đã đổi mật khẩu"); setO(""); setN(""); }
    catch (x: any) { setErr(x.message); }
  };
  return (
    <form className="card" style={{ maxWidth: 380 }} onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>Đổi mật khẩu</h2>
      <label>Mật khẩu hiện tại</label><input type="password" value={o} onChange={(e) => setO(e.target.value)} />
      <div style={{ height: 10 }} /><label>Mật khẩu mới (tối thiểu 6 ký tự)</label><input type="password" value={n} onChange={(e) => setN(e.target.value)} />
      {err && <p className="err">{err}</p>}{msg && <p className="ok">{msg}</p>}
      <div style={{ height: 12 }} /><button>Đổi mật khẩu</button>
    </form>
  );
}

function Admin({ me }: { me: User }) {
  const [tab, setTab] = useState<"users" | "drive" | "log">("users");
  return (
    <>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {([["users", "Phân quyền user"], ["drive", "Google Drive"], ["log", "Nhật ký"]] as const).map(([k, l]) =>
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "users" ? <AdminUsers me={me} /> : tab === "drive" ? <AdminDrive /> : <AdminLog />}
    </>
  );
}

function AdminUsers({ me }: { me: User }) {
  const [list, setList] = useState<any[]>([]), [q, setQ] = useState(""), [msg, setMsg] = useState("");
  const load = () => api("/admin/users").then(setList);
  useEffect(() => { load(); }, []);
  const save = async (u: any, patch: any) => {
    setMsg("");
    try { await api("/admin/users/" + u.id, { method: "PUT", body: { role: u.role, active: !!u.active, ...patch } }); load(); }
    catch (x: any) { setMsg(x.message); }
  };
  const reset = async (u: any) => {
    if (!confirm(`Đặt lại mật khẩu của ${u.full_name} về 654321?`)) return;
    await api(`/admin/users/${u.id}/reset-password`, { body: {} }); setMsg("Đã đặt lại mật khẩu " + u.username);
  };
  const shown = list.filter((u) => (u.full_name + u.username + (u.phong ?? "")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <div style={{ padding: 12 }} className="row"><input style={{ maxWidth: 300 }} placeholder="Tìm user…" value={q} onChange={(e) => setQ(e.target.value)} />{msg && <span className="err">{msg}</span>}</div>
      <table>
        <thead><tr><th>Họ tên</th><th>Username</th><th className="hide-m">Phòng</th><th>Quyền</th><th>Hoạt động</th><th></th></tr></thead>
        <tbody>
          {shown.map((u) => (
            <tr key={u.id}>
              <td>{u.full_name}</td><td>{u.username}</td><td className="hide-m">{u.phong}</td>
              <td><select value={u.role} disabled={u.id === me.id} onChange={(e) => save(u, { role: e.target.value })}>
                <option value="read">Chỉ đọc</option><option value="write">Được ghi</option><option value="admin">Admin</option></select></td>
              <td><input type="checkbox" style={{ width: "auto" }} checked={!!u.active} disabled={u.id === me.id} onChange={(e) => save(u, { active: e.target.checked })} /></td>
              <td><button className="ghost" onClick={() => reset(u)}>Reset mật khẩu</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminDrive() {
  const [s, setS] = useState({ drive_folder_den: "", drive_folder_di: "" }), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  useEffect(() => { api("/admin/settings").then(setS); }, []);
  const save = async () => {
    setMsg(""); setErr("");
    try { await api("/admin/settings", { method: "PUT", body: s }); setMsg("Đã lưu. Các thư mục con theo loại sẽ được tạo tự động ở lần upload đầu tiên."); api("/admin/settings").then(setS); }
    catch (x: any) { setErr(x.message); }
  };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <p className="muted">Dán link (hoặc ID) folder Google Drive gốc. App sẽ tạo/dùng các thư mục con: {LOAI.join(", ")}.</p>
      <label>Folder “Văn bản đến”</label><input value={s.drive_folder_den} onChange={(e) => setS({ ...s, drive_folder_den: e.target.value })} placeholder="https://drive.google.com/drive/folders/…" />
      <div style={{ height: 10 }} /><label>Folder “Văn bản đi”</label><input value={s.drive_folder_di} onChange={(e) => setS({ ...s, drive_folder_di: e.target.value })} placeholder="https://drive.google.com/drive/folders/…" />
      {err && <p className="err">{err}</p>}{msg && <p className="ok">{msg}</p>}
      <div style={{ height: 12 }} /><button onClick={save}>Lưu</button>
    </div>
  );
}

function AdminLog() {
  const [l, setL] = useState<any[]>([]);
  useEffect(() => { api("/admin/log").then(setL); }, []);
  return (
    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table><thead><tr><th>Thời gian (UTC)</th><th>User</th><th>Hành động</th><th>VB</th><th>Chi tiết</th></tr></thead>
        <tbody>{l.map((x) => <tr key={x.id}><td>{x.created_at}</td><td>{x.username}</td><td>{x.action}</td><td>{x.doc_id}</td><td>{x.detail}</td></tr>)}</tbody></table>
    </div>
  );
}
