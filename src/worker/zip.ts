// Đọc chữ trong .docx/.xlsx ngay trên Worker. Dùng DecompressionStream của nền tảng (giải nén native, rất nhẹ CPU)
// thay vì thư viện JS, để một lượt chạy cron không vượt giới hạn CPU của Worker.

const dec = new TextDecoder();
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Đọc các entry (dạng text UTF-8) có tên thỏa `want` trong file zip. */
async function readZipText(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("File không phải định dạng zip/Office hợp lệ");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.subarray(start, start + csize);
    out.set(name, dec.decode(method === 0 ? raw : await inflateRaw(raw)));
  }
  return out;
}

export async function docxToText(buf: ArrayBuffer): Promise<string> {
  const xml = (await readZipText(buf, (n) => n === "word/document.xml")).get("word/document.xml") ?? "";
  return decodeXml(xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, ""));
}

/** .xlsx: ghép giá trị ô của tối đa 3 sheet đầu thành dạng CSV. (.xls cũ không hỗ trợ.) */
export async function xlsxToText(buf: ArrayBuffer): Promise<string> {
  const files = await readZipText(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const text = (x: string) => decodeXml([...x.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const sheets = [...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 3);
  return sheets.map((name, i) => {
    const rows = [...files.get(name)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
      [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const t = /\bt="(\w+)"/.exec(c[1])?.[1], inner = c[2] ?? "";
        if (t === "inlineStr") return text(inner);
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        return t === "s" ? shared[Number(v)] ?? "" : decodeXml(v);
      }).join(","));
    return `# Sheet ${i + 1}\n` + rows.join("\n");
  }).join("\n\n");
}
