import { useEffect, useRef, useState } from "react";
import { extOf } from "./extract";

type Props = { id: number; name: string; mime: string };

/** Xem trước tài liệu: PDF/ảnh bằng iframe, Word (.docx) và Excel (.xlsx/.xls) render ngay trên trình duyệt. */
export default function Preview({ id, name, mime }: Props) {
  const ext = extOf(name);
  const url = `/api/docs/${id}/file`;
  if (mime === "application/pdf" || mime.startsWith("image/") || ext === "pdf") return <iframe src={url} title={name} />;
  if (ext === "docx") return <DocxView url={url} />;
  if (ext === "xlsx" || ext === "xls") return <XlsxView url={url} />;
  return <p className="muted">Định dạng .{ext} không xem trực tiếp được, vui lòng tải về.</p>;
}

function DocxView({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"load" | "ok" | "err">("load");
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        const { renderAsync } = await import("docx-preview");
        if (dead || !box.current) return;
        box.current.innerHTML = "";
        await renderAsync(blob, box.current, undefined, { inWrapper: true, ignoreWidth: false, breakPages: true });
        if (!dead) setState("ok");
      } catch { if (!dead) setState("err"); }
    })();
    return () => { dead = true; };
  }, [url]);
  return (
    <>
      {state === "load" && <p className="muted">Đang tải bản xem trước…</p>}
      {state === "err" && <p className="err">Không xem trước được file Word này, vui lòng tải về.</p>}
      <div ref={box} className="docx-box" />
    </>
  );
}

function XlsxView({ url }: { url: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [cur, setCur] = useState(0), [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await r.arrayBuffer());
        if (!dead) setSheets(wb.SheetNames.map((n) => ({ name: n, html: XLSX.utils.sheet_to_html(wb.Sheets[n], { header: "", footer: "" }) })));
      } catch { if (!dead) setErr(true); }
    })();
    return () => { dead = true; };
  }, [url]);
  if (err) return <p className="err">Không xem trước được file Excel này, vui lòng tải về.</p>;
  if (!sheets) return <p className="muted">Đang tải bản xem trước…</p>;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="tabs" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {sheets.map((s, i) => <button key={s.name} className={i === cur ? "on" : ""} onClick={() => setCur(i)}>{s.name}</button>)}
      </div>
      <div className="xlsx-box" dangerouslySetInnerHTML={{ __html: sheets[cur].html }} />
    </div>
  );
}
