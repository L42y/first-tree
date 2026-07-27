export type CsvRow = Record<string, string>;
export type CsvDocument = {
  headers: string[];
  rows: CsvRow[];
};

/** Small RFC-4180 parser for pgAdmin/GA4 aggregate exports. */
export function parseCsvDocument(input: string): CsvDocument {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        closedQuote = false;
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        closedQuote = false;
      } else if (character !== "\r" || input[index + 1] !== "\n") {
        throw new Error("Unexpected character after a closing CSV quote");
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0) throw new Error("Unexpected quote inside an unquoted CSV field");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0]?.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/u, "") : header)) ?? [];
  if (headers.length === 0 || headers.some((header) => header.length === 0)) {
    throw new Error("CSV headers must not be empty");
  }
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique");

  const dataRows = rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  return { headers, rows: dataRows };
}

export function parseCsv(input: string): CsvRow[] {
  return parseCsvDocument(input).rows;
}

export function requireCsvHeaders(headers: readonly string[], requiredHeaders: readonly string[], label: string): void {
  if (headers.length === 0) {
    throw new Error(`${label} CSV is empty; expected a header row`);
  }
  const available = new Set(headers);
  const missing = requiredHeaders.filter((header) => !available.has(header));
  if (missing.length > 0) {
    throw new Error(`${label} CSV is missing required header${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
}

export function requiredColumn(row: CsvRow, column: string): string {
  const value = row[column];
  if (value === undefined || value === "") throw new Error(`Missing required CSV column: ${column}`);
  return value;
}

export function optionalColumn(row: CsvRow, column: string): string | null {
  const value = row[column];
  if (value === undefined) throw new Error(`Missing required CSV header: ${column}`);
  return value === "" || value === "NULL" ? null : value;
}
