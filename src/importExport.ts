// JSON / CSV 导入导出。
// CSV 状态点列：p,t,rh,w,tdp（rh/w/tdp 三选一非空）。
import { PsychroError } from "./psychro";

export function exportJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const lines = [keys.join(",")];
  for (const r of rows) {
    lines.push(keys.map((k) => csvEscape(typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k])).join(","));
  }
  return lines.join("\n");
}

export function parseCsvStates(content: string): Record<string, unknown>[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new PsychroError("INVALID_INPUT", "CSV 至少需要表头和一行数据", "import");
  }
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== header.length) {
      throw new PsychroError(
        "INVALID_INPUT",
        `CSV 第 ${i + 2} 行列数 (${cells.length}) 与表头 (${header.length}) 不一致`,
        `import.row[${i}]`,
      );
    }
    const obj: Record<string, unknown> = {};
    header.forEach((h, j) => {
      const v = cells[j].trim();
      if (v !== "") {
        const n = Number(v);
        obj[h] = Number.isFinite(n) ? n : v;
      }
    });
    return obj;
  });
}

/** 解析导入内容，返回状态输入对象数组。 */
export function parseImport(format: string, content: string): Record<string, unknown>[] {
  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new PsychroError("INVALID_INPUT", "导入内容不是合法 JSON", "import");
    }
    const arr = Array.isArray(data) ? data : [data];
    return arr as Record<string, unknown>[];
  }
  if (format === "csv") {
    return parseCsvStates(content);
  }
  throw new PsychroError("INVALID_INPUT", `不支持的导入格式 "${format}"，仅支持 json/csv`, "import.format");
}
