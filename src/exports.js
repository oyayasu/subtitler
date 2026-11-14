import { clock, cueText, timingExport } from "./model.js";
import { captionLines } from "./workflow.js";
import { transcriptBlocks } from './chapters.js';
const xml = (s) =>
  String(s ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const safeName = (s) =>
  String(s || "Transcript")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .slice(0, 120)
    .trim() || "Transcript";
export function textExport(p, timestamps = false) {
  return (
    transcriptBlocks(p)
      .map(c => c.kind === 'heading' ? c.title :
          (timestamps ? `[${clock(c.start)} → ${clock(c.end)}] ` : "") + c.text)
      .join("\n\n") + "\n"
  );
}
export function wrapCaption(text, limit = 42) {
  const lines = [];
  for (const para of text.split("\n")) {
    if ([...para].length <= limit) {
      lines.push(para);
      continue;
    }
    let line = "";
    for (const token of para.match(/\S+\s*|\s+/gu) || []) {
      if (line && [...(line + token)].length > limit) {
        lines.push(line.trimEnd());
        line = "";
      }
      if ([...token].length > limit) {
        for (const ch of token) {
          if ([...line].length >= limit) {
            lines.push(line.trimEnd());
            line = "";
          }
          line += ch;
        }
      } else line += token;
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
export function srtExport(p) {
  return p.cues
    .map(
      (c, i) =>
        `${i + 1}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${p.subtitleOptions ? captionLines(c.words, p.subtitleOptions).text : wrapCaption(cueText(c))}\n`,
    )
    .join("\n");
}
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export function csvExport(p) {
  return (
    "\uFEFF" +
    [
      [
        "Subtitle",
        "Start",
        "End",
        "Start seconds",
        "End seconds",
        "Text",
        "Timing",
      ],
      ...p.cues.map((c, i) => [
        i + 1,
        clock(c.start),
        clock(c.end),
        c.start.toFixed(3),
        c.end.toFixed(3),
        cueText(c),
        c.words.some((w) => w.timing === "estimated")
          ? "Review word timing"
          : "Automatic / manual",
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}
function archive() {
  if (!globalThis.JSZip)
    throw Error("The bundled document exporter could not load.");
  return new globalThis.JSZip();
}
const relationships = (entries) =>
  declaration +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  entries
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
    )
    .join("") +
  "</Relationships>";
export async function docxExport(p, timestamps = false) {
  const z = archive();
  z.file(
    "[Content_Types].xml",
    declaration +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  z.file(
    "_rels/.rels",
    relationships([["rId1", "officeDocument", "word/document.xml"]]),
  );
  z.file(
    "word/_rels/document.xml.rels",
    relationships([["rId1", "styles", "styles.xml"]]),
  );
  const paragraph = (text, style = null) =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:spacing w:after="180"/></w:pPr><w:r><w:t xml:space="preserve">${xml(text).replaceAll("\n", '</w:t><w:br/><w:t xml:space="preserve">')}</w:t></w:r></w:p>`;
  z.file(
    "word/document.xml",
    declaration +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(p.name, 'Title')}${transcriptBlocks(p).map(c => c.kind === 'heading' ? paragraph(c.title,'Heading'+c.level) : paragraph((timestamps ? `[${clock(c.start)} → ${clock(c.end)}] ` : "") + c.text)).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  );
  z.file(
    "word/styles.xml",
    declaration +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:eastAsia="Yu Mincho"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>'+Array.from({length:6},(_,i)=>`<w:style w:type="paragraph" w:styleId="Heading${i+1}"><w:name w:val="heading ${i+1}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.max(24,36-i*2)}"/></w:rPr></w:style>`).join('')+'</w:styles>',
  );
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
const colName = (i) => {
  let s = "";
  for (let n = i + 1; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
function worksheet(rows, widths) {
  return (
    declaration +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colName(widths.length - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows
      .map((row, r) => {
        const height = r
          ? Math.min(
              240,
              Math.max(
                30,
                Math.ceil(String(row[5] || "").length / 70) * 16 + 12,
              ),
            )
          : 28;
        return `<row r="${r + 1}" ht="${height}" customHeight="1">${row.map((v, c) => (typeof v === "number" ? `<c r="${colName(c)}${r + 1}" s="${r ? 1 : 2}"><v>${v}</v></c>` : `<c r="${colName(c)}${r + 1}" s="${r ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`)).join("")}</row>`;
      })
      .join(
        "",
      )}</sheetData><autoFilter ref="A1:${colName(widths.length - 1)}${rows.length}"/></worksheet>`
  );
}
export async function xlsxExport(p) {
  const z = archive(),
    captions = [
      [
        "Subtitle",
        "Start",
        "End",
        "Start seconds",
        "End seconds",
        "Text",
        "Timing",
      ],
      ...p.cues.map((c, i) => [
        i + 1,
        clock(c.start),
        clock(c.end),
        +c.start.toFixed(3),
        +c.end.toFixed(3),
        cueText(c),
        c.words.some((w) => w.timing === "estimated")
          ? "Review word timing"
          : "Automatic / manual",
      ]),
    ],
    words = [
      ["Subtitle", "Word", "Start seconds", "End seconds", "Timing", "Word ID"],
      ...p.cues.flatMap((c, i) =>
        c.words.map((w) => [
          i + 1,
          w.text,
          +w.start.toFixed(3),
          +w.end.toFixed(3),
          w.timing,
          w.id,
        ]),
      ),
    ];
  z.file(
    "[Content_Types].xml",
    declaration +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      [1, 2]
        .map(
          (i) =>
            `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      "</Types>",
  );
  z.file(
    "_rels/.rels",
    relationships([["rId1", "officeDocument", "xl/workbook.xml"]]),
  );
  z.file(
    "xl/workbook.xml",
    declaration +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Subtitles" sheetId="1" r:id="rId1"/><sheet name="Words" sheetId="2" r:id="rId2"/></sheets></workbook>',
  );
  z.file(
    "xl/_rels/workbook.xml.rels",
    relationships([
      ["rId1", "worksheet", "worksheets/sheet1.xml"],
      ["rId2", "worksheet", "worksheets/sheet2.xml"],
      ["rId3", "styles", "styles.xml"],
    ]),
  );
  z.file(
    "xl/styles.xml",
    declaration +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF27776D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  z.file(
    "xl/worksheets/sheet1.xml",
    worksheet(captions, [10, 17, 17, 17, 17, 76, 25]),
  );
  z.file(
    "xl/worksheets/sheet2.xml",
    worksheet(words, [10, 35, 17, 17, 18, 40]),
  );
  return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
export async function makeExport(p, format, options = {}) {
  let data,
    mime = "text/plain;charset=utf-8";
  if (format === "txt") data = textExport(p, options.timestamps);
  else if (format === "srt") {
    data = srtExport(p);
    mime = "application/x-subrip";
  } else if (format === "csv") {
    data = csvExport(p);
    mime = "text/csv;charset=utf-8";
  } else if (format === "docx") {
    data = await docxExport(p, options.timestamps);
    mime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else if (format === "xlsx") {
    data = await xlsxExport(p);
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (format === "json") {
    data = JSON.stringify(timingExport(p), null, 2);
    mime = "application/json";
  } else if (format === "subtitler" || format === "whisperdesk") {
    const saved = { ...p };
    delete saved.drafts;
    data = JSON.stringify(saved);
    mime = "application/json";
  } else throw Error("Unknown export format");
  return { data, mime, name: safeName(p.name) + "." + format };
}
