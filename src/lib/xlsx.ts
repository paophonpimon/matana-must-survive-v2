// Minimal, dependency-free .xlsx writer.
//
// An .xlsx file is a ZIP archive of XML parts. Rather than pull in a spreadsheet library (the
// npm `xlsx` package carries known advisories, and `exceljs` would roughly double this app's
// bundle for one export button), this writes the handful of parts Excel actually requires and
// packages them with STORED (uncompressed) ZIP entries. STORED is a first-class ZIP mode, so no
// DEFLATE implementation is needed and the output opens natively in Excel, Numbers and Sheets.
// Classroom exports are a few hundred rows, so skipping compression costs nothing meaningful.
//
// Values are written as either inline strings or numbers; that is all this app's exports need.

export type CellValue = string | number
export interface SheetData {
  name: string
  rows: CellValue[][]
}

// XML 1.0 forbids most C0 control characters in content; Excel refuses to open a file that
// contains them. Tab/newline/carriage-return are legal and deliberately kept. Done by code
// point rather than a regex so no control character ever appears literally in this source.
const stripInvalidXmlChars = (value: string): string => {
  let output = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    output += char
  }
  return output
}

const escapeXml = (value: string): string =>
  stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

// 0-based column index -> spreadsheet column name (0 -> A, 26 -> AA).
const columnName = (index: number): string => {
  let name = ''
  let remaining = index
  while (remaining >= 0) {
    name = String.fromCharCode(65 + (remaining % 26)) + name
    remaining = Math.floor(remaining / 26) - 1
  }
  return name
}

// Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 characters.
const safeSheetName = (name: string, index: number): string => {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31)
  return cleaned || `Sheet${index + 1}`
}

const buildSheetXml = (rows: CellValue[][]): string => {
  const rowXml = rows.map((cells, rowIndex) => {
    const cellXml = cells.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`
      }
      // Inline strings avoid needing a shared-strings part at all.
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`
    }).join('')
    return `<row r="${rowIndex + 1}">${cellXml}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface ZipEntry { path: string; data: Uint8Array }

// Builds a ZIP archive using STORED entries only (compression method 0).
const buildZip = (entries: ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.path)
    const checksum = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + nameBytes.length + size)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true) // local file header signature
    localView.setUint16(4, 20, true) // version needed
    localView.setUint16(6, 0x0800, true) // UTF-8 filename flag
    localView.setUint16(8, 0, true) // method: stored
    localView.setUint16(10, 0, true) // mod time
    localView.setUint16(12, 0, true) // mod date
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, size, true) // compressed size
    localView.setUint32(22, size, true) // uncompressed size
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    local.set(entry.data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true) // central directory signature
    centralView.setUint16(4, 20, true) // version made by
    centralView.setUint16(6, 20, true) // version needed
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint16(14, 0, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, size, true)
    centralView.setUint32(24, size, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint16(30, 0, true) // extra
    centralView.setUint16(32, 0, true) // comment
    centralView.setUint16(34, 0, true) // disk number
    centralView.setUint16(36, 0, true) // internal attrs
    centralView.setUint32(38, 0, true) // external attrs
    centralView.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  })

  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true) // end of central directory
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  const totalSize = offset + centralSize + end.length
  const output = new Uint8Array(totalSize)
  let cursor = 0
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

// Builds a complete .xlsx workbook from plain row data. Returns the raw bytes so callers can
// hand them to a Blob (browser) or assert on them directly (tests).
export const buildXlsx = (sheets: SheetData[]): Uint8Array => {
  const encoder = new TextEncoder()
  const named = sheets.map((sheet, index) => ({ ...sheet, name: safeSheetName(sheet.name, index) }))

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${named.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { path: '_rels/.rels', data: encoder.encode(rootRels) },
    { path: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { path: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    ...named.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      data: encoder.encode(buildSheetXml(sheet.rows)),
    })),
  ]

  return buildZip(entries)
}

// Reads back a STORED zip entry as text. Only used by tests to assert on generated workbooks —
// STORED entries need no inflate, so this stays a few lines.
export const readXlsxEntry = (archive: Uint8Array, path: string): string | null => {
  const decoder = new TextDecoder()
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let cursor = 0
  while (cursor + 30 <= archive.length && view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 18, true)
    const nameLength = view.getUint16(cursor + 26, true)
    const extraLength = view.getUint16(cursor + 28, true)
    const nameStart = cursor + 30
    const name = decoder.decode(archive.subarray(nameStart, nameStart + nameLength))
    const dataStart = nameStart + nameLength + extraLength
    if (name === path) return decoder.decode(archive.subarray(dataStart, dataStart + size))
    cursor = dataStart + size
  }
  return null
}
