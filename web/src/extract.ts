// Đọc text từ file Word/Excel ngay trên trình duyệt (để gửi cho AI, vì Gemini không đọc trực tiếp docx/xlsx)
export const extOf = (name: string) => name.split(".").pop()?.toLowerCase() || "";

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export async function fileToText(f: File | Blob, name: string): Promise<string | null> {
  const ext = extOf(name);
  if (ext === "docx") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(f);
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) return "";
    return decode(xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, ""));
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await f.arrayBuffer());
    return wb.SheetNames.slice(0, 3).map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n\n");
  }
  return null;
}
