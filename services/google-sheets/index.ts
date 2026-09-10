import { google } from "googleapis";
import { prisma } from "@/lib/db";
import { env } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { getAuthorizedClient, getUserConnection } from "@/services/google-drive/oauth";
import { iterateCandidates, type CandidateFilters, type CandidateRow } from "@/backend/candidates";

/**
 * Google Sheets export (real Sheets API). Uses the user's Google connection
 * (spreadsheets scope). If a spreadsheet ID is configured, a new tab is added
 * to it; otherwise a new spreadsheet is created per export.
 */
export const EXPORT_HEADERS = [
  "Candidate Name",
  "Phone Number",
  "Job Role Applied For",
  "CV File Name",
  "CV Link",
  "Source",
  "Status",
  "Confidence",
  "Processed At",
] as const;

export function candidateToRow(row: CandidateRow, appUrl: string): string[] {
  const c = row.candidate;
  const link = row.sourceType === "GOOGLE_DRIVE" && row.driveUrl ? row.driveUrl : `${appUrl.replace(/\/+$/, "")}/api/cv-files/${row.id}/download`;
  return [
    c?.candidateName ?? "Not Found",
    c?.phoneNumber ?? "Not Found",
    c?.jobRoleAppliedFor ?? "Not Found",
    row.fileName,
    link,
    row.sourceType === "GOOGLE_DRIVE" ? "Google Drive" : "Manual Upload",
    row.status.replace("_", " "),
    c ? String(Math.round(c.overallConfidence * 100) / 100) : "",
    c?.processedAt ? c.processedAt.toISOString() : "",
  ];
}

export interface ExportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheetTitle: string;
  rowCount: number;
}

export async function exportCandidatesToSheets(userId: string, filters: Omit<CandidateFilters, "page" | "pageSize">, spreadsheetIdOverride?: string): Promise<ExportResult> {
  const conn = await getUserConnection(userId);
  if (!conn) {
    throw new AppError("Connect Google Drive first – the Sheets export uses your Google account.", { status: 400, code: "GOOGLE_NOT_CONNECTED" });
  }
  const auth = await getAuthorizedClient(conn.id);
  const sheets = google.sheets({ version: "v4", auth });
  const settings = await getSettings();
  const appUrl = env().APP_URL;

  const rows: string[][] = [[...EXPORT_HEADERS]];
  for await (const row of iterateCandidates(filters)) rows.push(candidateToRow(row, appUrl));

  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const sheetTitle = `CV Export ${stamp}`.slice(0, 100);
  let spreadsheetId = spreadsheetIdOverride || settings.sheetsSpreadsheetId || "";
  let spreadsheetUrl: string;

  if (spreadsheetId) {
    // Add a new tab to the configured spreadsheet.
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "spreadsheetUrl,sheets.properties.title" });
    spreadsheetUrl = meta.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    const titles = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
    let title = sheetTitle;
    for (let i = 2; titles.has(title); i++) title = `${sheetTitle} (${i})`;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    await writeRows(sheets, spreadsheetId, title, rows);
    return finish(userId, spreadsheetId, spreadsheetUrl, title, rows.length - 1);
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `CV Parser Export ${stamp}` },
      sheets: [{ properties: { title: "Candidates", gridProperties: { frozenRowCount: 1 } } }],
    },
    fields: "spreadsheetId,spreadsheetUrl",
  });
  spreadsheetId = created.data.spreadsheetId!;
  spreadsheetUrl = created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  await writeRows(sheets, spreadsheetId, "Candidates", rows);
  return finish(userId, spreadsheetId, spreadsheetUrl, "Candidates", rows.length - 1);
}

async function writeRows(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string, sheetTitle: string, rows: string[][]) {
  // Write in chunks to stay well under request size limits for large exports.
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetTitle.replace(/'/g, "''")}'!A${i + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: chunk },
    });
  }
  // Bold header + auto-resize columns.
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
  const sheetId = meta.data.sheets?.find((s) => s.properties?.title === sheetTitle)?.properties?.sheetId;
  if (sheetId !== undefined && sheetId !== null) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: EXPORT_HEADERS.length } } },
        ],
      },
    });
  }
}

async function finish(userId: string, spreadsheetId: string, spreadsheetUrl: string, sheetTitle: string, rowCount: number): Promise<ExportResult> {
  await prisma.sheetsExport.create({ data: { userId, spreadsheetId, spreadsheetUrl, sheetTitle, rowCount } });
  return { spreadsheetId, spreadsheetUrl, sheetTitle, rowCount };
}
