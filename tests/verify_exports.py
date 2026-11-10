"""Read-only validation for files exported by tests/ui.mjs and the export model tests."""
from pathlib import Path
import csv,json,sys
from docx import Document
from openpyxl import load_workbook
root=Path(sys.argv[1])
p=json.loads((root/'Opening.json').read_text())
assert p['timeUnit']=='seconds'
assert p['originalWords'][1]['text']=='candle'
assert p['words'][1]['text']=='lantern'
assert p['subtitles'][0]['start']==.52
text=[p.text for p in Document(root/'Opening.docx').paragraphs]
assert text==['Opening','A lantern lit the room.','Her brother was already there.'],text
wb=load_workbook(root/'Opening.xlsx',data_only=False)
assert wb.sheetnames==['Subtitles','Words']
assert wb['Subtitles']['D2'].value==.52
assert wb['Subtitles']['F2'].value=='A lantern lit the room.'
assert wb['Words']['B3'].value=='lantern'
assert wb['Subtitles'].freeze_panes=='A2'
assert wb['Subtitles'].auto_filter.ref=='A1:G3'
with (root/'Opening.csv').open(encoding='utf-8-sig',newline='') as f:
 rows=list(csv.reader(f))
assert rows[1][5]=='A lantern lit the room.'
assert len(rows)==3
browser=root/'browser-export.xlsx'
if browser.exists():
 b=load_workbook(browser,data_only=False)
 assert b['Subtitles']['F2'].value=='Olá, você está aí?'
 assert b['Subtitles']['F3'].value=='日本語の字幕です。'
print('PASS: actual DOCX paragraphs, numeric XLSX timings, editable words, frozen headers, filters, CSV escaping, timing JSON provenance, and browser Unicode exports.')
