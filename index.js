require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();

app.use(cors());
app.use(express.json());

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// ---------------------------------------------------------
// Template Sheet Names (base — never written to directly)
// ---------------------------------------------------------

const BASE_SUMMARY = 'Summary';
const BASE_TRANSACTIONS = 'Transactions';

// ---------------------------------------------------------
// Transactions Sheet Layout
// ---------------------------------------------------------
// Expenses side: cols A–D,  row 3 = header, data from row 4+
// Income   side: cols F–I,  row 3 = header, data from row 4+
//
//   A=Date  B=Amount  C=Description  D=Category   (Expenses)
//   F=Date  G=Amount  H=Description  I=Category   (Income)

/**
 * Safely parse a date string which might be in YYYY-MM-DD, DD/MM/YYYY, or MM/DD/YYYY.
 */
function parseTxDate(str) {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const ts = new Date(s).getTime();
    if (!isNaN(ts)) return ts;
  }
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3 && parts[2].length === 4) {
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);
    const p2 = parseInt(parts[2], 10);

    // p0/p1/p2 could be MM/DD/YYYY or DD/MM/YYYY — disambiguate using
    // whichever of p0/p1 is > 12 (that one MUST be the day, since months
    // only go up to 12). If neither is > 12, assume MM/DD/YYYY (matches
    // this sheet's actual format, e.g. "7/27/2026").
    let month, day;
    if (p0 > 12) {
      // p0 can't be a month → p0 is day, p1 is month (DD/MM/YYYY)
      day = p0;
      month = p1;
    } else if (p1 > 12) {
      // p1 can't be a month → p0 is month, p1 is day (MM/DD/YYYY)
      month = p0;
      day = p1;
    } else {
      // ambiguous (both ≤ 12) — default to MM/DD/YYYY
      month = p0;
      day = p1;
    }

    const ts = new Date(`${p2}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`).getTime();
    if (!isNaN(ts)) return ts;
    return 0;
  }
  return new Date(s).getTime();
}

const TX_HEADER_ROW = 4;
const TX_DATA_START_ROW = 5;

const TX_COLS = {
  expense: { date: 'B', amount: 'C', description: 'D', category: 'E', first: 'B', last: 'E' },
  income: { date: 'G', amount: 'H', description: 'I', category: 'J', first: 'G', last: 'J' },
};

// ---------------------------------------------------------
// Summary Sheet Layout — Category Cell Map
// ---------------------------------------------------------
// Starting balance: L8
//
// Expenses table: rows 24–37, cols B (name), C (planned), D (actual), E (diff)
// Income   table: rows 24–29, cols H (name), I (planned), J (actual), K (diff)

const STARTING_BALANCE_CELL = 'L8';

const EXPENSE_CATEGORIES = [
  { name: 'Food', row: 28, plannedCell: 'D28', actualCell: 'E28', diffCell: 'F28' },
  { name: 'Gifts', row: 29, plannedCell: 'D29', actualCell: 'E29', diffCell: 'F29' },
  { name: 'Health/medical', row: 30, plannedCell: 'D30', actualCell: 'E30', diffCell: 'F30' },
  { name: 'Home', row: 31, plannedCell: 'D31', actualCell: 'E31', diffCell: 'F31' },
  { name: 'Transportation', row: 32, plannedCell: 'D32', actualCell: 'E32', diffCell: 'F32' },
  { name: 'Personal', row: 33, plannedCell: 'D33', actualCell: 'E33', diffCell: 'F33' },
  { name: 'Pets', row: 34, plannedCell: 'D34', actualCell: 'E34', diffCell: 'F34' },
  { name: 'Utilities', row: 35, plannedCell: 'D35', actualCell: 'E35', diffCell: 'F35' },
  { name: 'Travel', row: 36, plannedCell: 'D36', actualCell: 'E36', diffCell: 'F36' },
  { name: 'Debt', row: 37, plannedCell: 'D37', actualCell: 'E37', diffCell: 'F37' },
  { name: 'Other', row: 38, plannedCell: 'D38', actualCell: 'E38', diffCell: 'F38' },
  { name: 'Custom category 1', row: 39, plannedCell: 'D39', actualCell: 'E39', diffCell: 'F39' },
  { name: 'Custom category 2', row: 40, plannedCell: 'D40', actualCell: 'E40', diffCell: 'F40' },
  { name: 'Custom category 3', row: 41, plannedCell: 'D41', actualCell: 'E41', diffCell: 'F41' },
];

const INCOME_CATEGORIES = [
  { name: 'Savings', row: 28, plannedCell: 'J28', actualCell: 'K28', diffCell: 'L28' },
  { name: 'Paycheck', row: 29, plannedCell: 'J29', actualCell: 'K29', diffCell: 'L29' },
  { name: 'Bonus', row: 30, plannedCell: 'J30', actualCell: 'K30', diffCell: 'L30' },
  { name: 'Interest', row: 31, plannedCell: 'J31', actualCell: 'K31', diffCell: 'L31' },
  { name: 'Other', row: 32, plannedCell: 'J32', actualCell: 'K32', diffCell: 'L32' },
  { name: 'Custom category', row: 33, plannedCell: 'J33', actualCell: 'K33', diffCell: 'L33' },
];

// Summary totals cells
const SUMMARY_CELLS = {
  expensesPlannedTotal: 'D26',
  expensesActualTotal: 'E26',
  incomePlannedTotal: 'J26',
  incomeActualTotal: 'K26',
  startBalance: 'L8',
};

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------

function unwrap(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? (parsed.length > 0 ? String(parsed[0]) : undefined)
        : value;
    } catch {
      return value;
    }
  }
  return String(value);
}

function isEmpty(value) {
  if (value == null) return true;
  const str = String(value).trim().toLowerCase();
  return (
    str === '' ||
    str === 'null' ||
    str === 'undefined' ||
    str === '[]' ||
    str === '[""]' ||
    str === 'nan'
  );
}

function nowISO() {
  return new Date().toISOString();
}

function getSheetsAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getSheetsAuth() });
}

// ---------------------------------------------------------
// Sheet Naming Helpers
// ---------------------------------------------------------

/**
 * Returns "MM/YYYY" from a date string (e.g. "2026-07-15" → "07/2026")
 */
function sheetSuffix(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    // Try today as fallback
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `${mm}/${now.getFullYear()}`;
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${mm}/${d.getFullYear()}`;
}

function transactionsSheetName(dateStr) {
  return `Transactions ${sheetSuffix(dateStr)}`;
}

function summarySheetName(dateStr) {
  return `Summary ${sheetSuffix(dateStr)}`;
}

// ---------------------------------------------------------
// Category Resolution
// ---------------------------------------------------------

function resolveCategory(value, type) {
  if (isEmpty(value)) return null;
  const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const found = categories.find((c) => c.name.toLowerCase() === String(value).toLowerCase());
  return found ? found.name : null;
}

function getCategoryInfo(categoryName, type) {
  const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return categories.find((c) => c.name.toLowerCase() === String(categoryName).toLowerCase()) || null;
}

// ---------------------------------------------------------
// Generic Sheet Helpers
// ---------------------------------------------------------

async function listAllSheets(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return meta.data.sheets.map((s) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
  }));
}

async function getSheetGid(sheets, sheetName) {
  const allSheets = await listAllSheets(sheets);
  const sheet = allSheets.find((s) => s.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return sheet.sheetId;
}

async function cloneSheet(sheets, sourceTitle, newTitle, fixRefFrom = null, fixRefTo = null) {
  const allSheets = await listAllSheets(sheets);
  const source = allSheets.find((s) => s.title === sourceTitle);
  if (!source) throw new Error(`Source sheet "${sourceTitle}" not found for cloning`);

  // Duplicate the sheet
  const dupRes = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: SPREADSHEET_ID,
    sheetId: source.sheetId,
    requestBody: { destinationSpreadsheetId: SPREADSHEET_ID },
  });

  const newSheetId = dupRes.data.sheetId;

  const requests = [
    {
      updateSheetProperties: {
        properties: { sheetId: newSheetId, title: newTitle },
        fields: 'title',
      },
    },
  ];

  // Fix formula references if needed (e.g. Transactions! -> 'Transactions 07/2026'!)
  if (fixRefFrom && fixRefTo) {
    requests.push({
      findReplace: {
        find: `${fixRefFrom}!`,
        replacement: `'${fixRefTo}'!`,
        sheetId: newSheetId,
        matchCase: true,
        matchEntireCell: false,
        searchByRegex: false,
        includeFormulas: true,
      },
    });
  }

  // Rename the duplicate and optionally fix references
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });

  return newSheetId;
}

/**
 * Ensures both Transactions MM/YYYY and Summary MM/YYYY exist.
 * If either is missing, clones from the base template.
 */
async function ensureMonthlySheets(sheets, dateStr) {
  const txName = transactionsSheetName(dateStr);
  const sumName = summarySheetName(dateStr);

  const allSheets = await listAllSheets(sheets);
  const titles = allSheets.map((s) => s.title);

  const txExists = titles.includes(txName);
  const sumExists = titles.includes(sumName);

  if (!txExists) {
    await cloneSheet(sheets, BASE_TRANSACTIONS, txName);
  }
  if (!sumExists) {
    await cloneSheet(sheets, BASE_SUMMARY, sumName, BASE_TRANSACTIONS, txName);
  }

  // Clear dummy data from the template for whichever sheets were just created
  const rangesToClear = [];
  if (!sumExists) {
    rangesToClear.push(
      `'${sumName}'!L8`,        // Starting balance
      `'${sumName}'!D28:D41`,   // Planned expenses
      `'${sumName}'!J28:J33`    // Planned income
    );
  }
  if (!txExists) {
    rangesToClear.push(
      `'${txName}'!B5:E`,       // Expense transactions
      `'${txName}'!G5:J`        // Income transactions
    );
  }

  if (rangesToClear.length > 0) {
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { ranges: rangesToClear },
    });
  }

  return { transactionsSheet: txName, summarySheet: sumName, created: !txExists || !sumExists };
}

// ---------------------------------------------------------
// Transactions Sheet Helpers
// ---------------------------------------------------------

/**
 * Read all data rows from one side (expense or income) of Transactions sheet.
 * Returns array of { rowIndex, date, amount, description, category }
 */
async function readTransactionRows(sheets, sheetName, side) {
  const cols = TX_COLS[side];
  if (!cols) throw new Error(`Invalid side "${side}" — must be "expense" or "income"`);

  const range = `'${sheetName}'!${cols.first}${TX_DATA_START_ROW}:${cols.last}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({
      rowIndex: TX_DATA_START_ROW + idx,
      date: row[0] || '',
      amount: row[1] || '',
      description: row[2] || '',
      category: row[3] || '',
      type: side,
    }))
    .filter((r) => !isEmpty(r.date) || !isEmpty(r.amount) || !isEmpty(r.description));
}

/**
 * Append a new transaction row to the first empty row on the correct side.
 */
async function appendTransactionRow(sheets, sheetName, side, data) {
  const cols = TX_COLS[side];

  // Find existing rows to determine the next empty row
  const existingRows = await readTransactionRows(sheets, sheetName, side);
  const nextRow = existingRows.length > 0
    ? Math.max(...existingRows.map((r) => r.rowIndex)) + 1
    : TX_DATA_START_ROW;

  const range = `'${sheetName}'!${cols.first}${nextRow}:${cols.last}${nextRow}`;
  const values = [[data.date || '', data.amount || '', data.description || '', data.category || '']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  return nextRow;
}

/**
 * Update a specific row on the correct side.
 */
async function updateTransactionRow(sheets, sheetName, side, rowIndex, data) {
  const cols = TX_COLS[side];
  const range = `'${sheetName}'!${cols.first}${rowIndex}:${cols.last}${rowIndex}`;
  const values = [[data.date || '', data.amount || '', data.description || '', data.category || '']];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

/**
 * Clear a specific row on the correct side (delete data without shifting rows
 * to avoid breaking formulas that reference specific row ranges).
 */
async function deleteTransactionRow(sheets, sheetName, side, rowIndex) {
  const cols = TX_COLS[side];
  const range = `'${sheetName}'!${cols.first}${rowIndex}:${cols.last}${rowIndex}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
}

// ---------------------------------------------------------
// Summary Sheet Helpers
// ---------------------------------------------------------

async function readSummaryCellValue(sheets, sheetName, cell) {
  const range = `'${sheetName}'!${cell}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const values = res.data.values;
  if (!values || values.length === 0 || values[0].length === 0) return null;
  return values[0][0];
}

async function writeSummaryCellValue(sheets, sheetName, cell, value) {
  const range = `'${sheetName}'!${cell}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

/**
 * Read multiple cells in a batch from the Summary sheet.
 */
async function readSummaryMultipleCells(sheets, sheetName, cells) {
  const ranges = cells.map((c) => `'${sheetName}'!${c}`);
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const result = {};
  (res.data.valueRanges || []).forEach((vr, idx) => {
    const val = vr.values && vr.values[0] && vr.values[0][0];
    result[cells[idx]] = val || null;
  });
  return result;
}

// ---------------------------------------------------------
// Content-Based Transaction Matching
// ---------------------------------------------------------

function matchesTransaction(row, criteria) {
  let ok = true;

  if (!isEmpty(criteria.search_keyword)) {
    const desc = (row.description || '').toLowerCase();
    ok = ok && desc.includes(String(criteria.search_keyword).toLowerCase());
  }

  if (!isEmpty(criteria.search_date)) {
    const rd = parseTxDate(row.date);
    const sd = parseTxDate(criteria.search_date);
    if (rd !== 0 && sd !== 0) {
      ok = ok && rd === sd;
    } else {
      ok = ok && row.date === criteria.search_date;
    }
  }

  if (!isEmpty(criteria.search_category)) {
    ok = ok && (row.category || '').toLowerCase() === String(criteria.search_category).toLowerCase();
  }

  if (!isEmpty(criteria.search_amount)) {
    const searchAmt = parseFloat(criteria.search_amount);
    const rowAmt = parseFloat(row.amount);
    if (!isNaN(searchAmt) && !isNaN(rowAmt)) {
      ok = ok && Math.abs(rowAmt - searchAmt) < 0.01;
    }
  }

  return ok;
}

function mapTransactionToOutput(row) {
  return {
    row_index: row.rowIndex,
    date: row.date,
    amount: parseFloat(row.amount) || 0,
    description: row.description,
    category: row.category,
    type: row.type,
  };
}

// ---------------------------------------------------------
// Content-Based Budget Matching
// ---------------------------------------------------------

function matchesBudget(categoryEntry, criteria) {
  let ok = true;

  if (!isEmpty(criteria.search_keyword)) {
    const name = (categoryEntry.name || '').toLowerCase();
    ok = ok && name.includes(String(criteria.search_keyword).toLowerCase());
  }

  return ok;
}

// ---------------------------------------------------------
// Balance Endpoint
// ---------------------------------------------------------

// GET — read-only balance check (browser-friendly)
app.get('/api/finance/balance', async (req, res) => {
  try {
    const month = req.query.month || undefined;
    const dateStr = resolveMonthToDate(month);
    const sheets = getSheetsClient();
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    const currentBalance = await readSummaryCellValue(sheets, summarySheet, STARTING_BALANCE_CELL);
    const parsed = parseFloat(String(currentBalance).replace(/[^0-9.\-]/g, ''));

    const exists = !isNaN(parsed) && parsed !== 0 && currentBalance != null;

    return res.json({
      success: true,
      action: 'get',
      exists,
      starting_balance: isNaN(parsed) ? null : parsed,
      starting_balance_raw: currentBalance,
      month: sheetSuffix(dateStr),
      summary_sheet: summarySheet,
    });
  } catch (error) {
    console.error('Balance GET error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST — read or set balance
app.post('/api/finance/balance', async (req, res) => {
  try {
    const month = unwrap(req.body.month); // "MM/YYYY" or a date string
    const newBalance = unwrap(req.body.starting_balance);

    // Determine the target month
    const dateStr = resolveMonthToDate(month);
    const sheets = getSheetsClient();

    // Ensure monthly sheets exist
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    if (!isEmpty(newBalance)) {
      // SET starting balance
      const amountNum = parseFloat(newBalance);
      if (isNaN(amountNum)) {
        return res.status(400).json({ success: false, error: 'Invalid starting_balance value' });
      }
      await writeSummaryCellValue(sheets, summarySheet, STARTING_BALANCE_CELL, amountNum);

      return res.json({
        success: true,
        action: 'set',
        starting_balance: amountNum,
        month: sheetSuffix(dateStr),
        summary_sheet: summarySheet,
      });
    }

    // GET starting balance
    const currentBalance = await readSummaryCellValue(sheets, summarySheet, STARTING_BALANCE_CELL);
    const parsed = parseFloat(String(currentBalance).replace(/[^0-9.\-]/g, ''));

    const exists = !isNaN(parsed) && parsed !== 0 && currentBalance != null;

    return res.json({
      success: true,
      action: 'get',
      exists,
      starting_balance: isNaN(parsed) ? null : parsed,
      starting_balance_raw: currentBalance,
      month: sheetSuffix(dateStr),
      summary_sheet: summarySheet,
    });
  } catch (error) {
    console.error('Balance error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Resolve a month input to a date string that sheetSuffix can parse.
 * Accepts: "MM/YYYY", "YYYY-MM-DD", or null (defaults to current month).
 */
function resolveMonthToDate(monthInput) {
  if (isEmpty(monthInput)) {
    return nowISO().slice(0, 10);
  }
  const str = String(monthInput).trim();
  // If "MM/YYYY" format
  const mmYYYY = str.match(/^(\d{2})\/(\d{4})$/);
  if (mmYYYY) {
    return `${mmYYYY[2]}-${mmYYYY[1]}-01`;
  }
  // Otherwise treat as a date string
  return str;
}

// ---------------------------------------------------------
// Transaction Routes
// ---------------------------------------------------------

app.post('/api/finance/create-transaction', async (req, res) => {
  try {
    const cleanDate = unwrap(req.body.date);
    const cleanType = unwrap(req.body.type);
    const cleanCategory = unwrap(req.body.category);
    const cleanAmountRaw = unwrap(req.body.amount);
    const cleanDescription = unwrap(req.body.description);

    if (isEmpty(cleanDate) || isEmpty(cleanType) || isEmpty(cleanAmountRaw)) {
      return res.status(400).json({ success: false, error_code: 'missing_fields', error: 'Missing date, type, or amount' });
    }

    const typeLower = String(cleanType).toLowerCase();
    if (!['income', 'expense'].includes(typeLower)) {
      return res.status(400).json({ success: false, error_code: 'invalid_type', error: 'Invalid type — must be "income" or "expense"' });
    }

    const amountNum = parseFloat(cleanAmountRaw);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
    }

    // Resolve category against the fixed list
    const defaultCategory = typeLower === 'income' ? 'Other' : 'Other';
    let finalCategory;
    if (isEmpty(cleanCategory)) {
      finalCategory = defaultCategory;
    } else {
      const resolved = resolveCategory(cleanCategory, typeLower);
      if (!resolved) {
        const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
        return res.status(400).json({
          success: false,
          error_code: 'invalid_category',
          error: `Invalid category for ${typeLower}. Must be one of: ${validList.join(', ')}`,
        });
      }
      finalCategory = resolved;
    }

    const finalDescription = isEmpty(cleanDescription) ? '' : cleanDescription;

    const sheets = getSheetsClient();

    // Ensure monthly sheets exist
    await ensureMonthlySheets(sheets, cleanDate);
    const txSheet = transactionsSheetName(cleanDate);

    // Append the row
    const rowIndex = await appendTransactionRow(sheets, txSheet, typeLower, {
      date: cleanDate,
      amount: amountNum,
      description: finalDescription,
      category: finalCategory,
    });

    return res.json({
      success: true,
      transaction: {
        row_index: rowIndex,
        date: cleanDate,
        type: typeLower,
        category: finalCategory,
        amount: amountNum,
        description: finalDescription,
      },
      sheet: txSheet,
    });
  } catch (error) {
    console.error('Create transaction error:', error);
    return res.status(500).json({ success: false, error_code: 'server_error', error: error.message });
  }
});

// ---------------------------------------------------------
// Edit Transaction (by row reference from a previous list/search)
// ---------------------------------------------------------

app.post('/api/finance/edit-transaction', async (req, res) => {
  try {
    const rowIndexRaw = unwrap(req.body.row_index);
    const type = unwrap(req.body.type);       // "expense" or "income" — which side
    const month = unwrap(req.body.month);      // "MM/YYYY" or date string

    const newDate = unwrap(req.body.new_date);
    const newAmountRaw = unwrap(req.body.new_amount);
    const newDescription = unwrap(req.body.new_description);
    const newCategory = unwrap(req.body.new_category);

    if (isEmpty(rowIndexRaw) || isEmpty(type) || isEmpty(month)) {
      return res.status(400).json({ success: false, error_code: 'missing_fields', error: 'Missing row_index, type, or month' });
    }

    const typeLower = String(type).toLowerCase();
    if (!['income', 'expense'].includes(typeLower)) {
      return res.status(400).json({ success: false, error_code: 'invalid_type', error: 'Invalid type — must be "income" or "expense"' });
    }

    if (isEmpty(newDate) && isEmpty(newAmountRaw) && isEmpty(newDescription) && isEmpty(newCategory)) {
      return res.status(400).json({ success: false, error_code: 'no_changes', error: 'No changes provided — nothing to update' });
    }

    const rowIndex = parseInt(rowIndexRaw, 10);
    if (isNaN(rowIndex) || rowIndex < TX_DATA_START_ROW) {
      return res.status(400).json({ success: false, error_code: 'invalid_row', error: 'Invalid row_index' });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const txSheet = transactionsSheetName(dateStr);

    // Read existing row
    const allRows = await readTransactionRows(sheets, txSheet, typeLower);
    const existing = allRows.find((r) => r.rowIndex === rowIndex);

    if (!existing) {
      return res.status(404).json({ success: false, error_code: 'not_found', error: 'Transaction not found at the specified row' });
    }

    // Merge changes
    const updated = {
      date: !isEmpty(newDate) ? newDate : existing.date,
      amount: !isEmpty(newAmountRaw) ? parseFloat(newAmountRaw) : existing.amount,
      description: !isEmpty(newDescription) ? newDescription : existing.description,
      category: !isEmpty(newCategory) ? newCategory : existing.category,
    };

    // Validate new amount
    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }
      updated.amount = amountNum;
    }

    // Validate new category
    if (!isEmpty(newCategory)) {
      const resolved = resolveCategory(newCategory, typeLower);
      if (!resolved) {
        const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
        return res.status(400).json({
          success: false,
          error_code: 'invalid_category',
          error: `Invalid category for ${typeLower}. Must be one of: ${validList.join(', ')}`,
        });
      }
      updated.category = resolved;
    }

    await updateTransactionRow(sheets, txSheet, typeLower, rowIndex, updated);

    const fieldsUpdated = [];
    if (!isEmpty(newDate)) fieldsUpdated.push('date');
    if (!isEmpty(newAmountRaw)) fieldsUpdated.push('amount');
    if (!isEmpty(newDescription)) fieldsUpdated.push('description');
    if (!isEmpty(newCategory)) fieldsUpdated.push('category');

    return res.json({
      success: true,
      transaction: {
        row_index: rowIndex,
        type: typeLower,
        ...updated,
        amount: parseFloat(updated.amount) || 0,
      },
      fields_updated: fieldsUpdated,
      sheet: txSheet,
    });
  } catch (error) {
    console.error('Edit transaction error:', error);
    return res.status(500).json({ success: false, error_code: 'server_error', error: error.message });
  }
});

// ---------------------------------------------------------
// Search Edit Transaction
// ---------------------------------------------------------

app.post('/api/finance/search-edit-transaction', async (req, res) => {
  console.log('[DEBUG] RAW BODY:', JSON.stringify(req.body));

  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchDate = unwrap(req.body.search_date);
    const searchCategory = unwrap(req.body.search_category);
    const searchAmount = unwrap(req.body.search_amount);
    const searchType = unwrap(req.body.search_type);  // "expense" or "income"
    const month = unwrap(req.body.month);              // "MM/YYYY" or date string

    const newDate = unwrap(req.body.new_date);
    const newAmountRaw = unwrap(req.body.new_amount);
    const newDescription = unwrap(req.body.new_description);
    const newCategory = unwrap(req.body.new_category);

    const targetRowIndexRaw = unwrap(req.body.target_row_index);
    const targetRowIndex = !isEmpty(targetRowIndexRaw) ? parseInt(targetRowIndexRaw, 10) : null;

    // Require at least one search criterion or target_row_index
    if (isEmpty(searchKeyword) && isEmpty(searchDate) && isEmpty(searchCategory) && isEmpty(searchAmount) && targetRowIndex === null) {
      return res.status(400).json({
        success: false,
        error: 'At least one search criterion or target_row_index is required',
      });
    }

    // Require at least one change
    if (isEmpty(newDate) && isEmpty(newAmountRaw) && isEmpty(newDescription) && isEmpty(newCategory)) {
      return res.status(400).json({ success: false, error: 'No changes provided — nothing to update' });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month || searchDate);
    await ensureMonthlySheets(sheets, dateStr);
    const txSheet = transactionsSheetName(dateStr);

    // Determine which sides to search
    const sides = isEmpty(searchType)
      ? ['expense', 'income']
      : [String(searchType).toLowerCase()];

    const criteria = { search_keyword: searchKeyword, search_date: searchDate, search_category: searchCategory, search_amount: searchAmount };
    let allMatches = [];

    for (const side of sides) {
      const rows = await readTransactionRows(sheets, txSheet, side);
      const matches = rows.filter((r) => {
        if (targetRowIndex !== null) return r.rowIndex === targetRowIndex;
        return matchesTransaction(r, criteria);
      });
      allMatches = allMatches.concat(matches);
    }

    if (allMatches.length === 0) {
      return res.json({ success: true, found: false, ambiguous: false, edited: false, candidates: [] });
    }

    if (allMatches.length > 1) {
      return res.json({
        success: true,
        found: false,
        ambiguous: true,
        edited: false,
        candidates: allMatches.map(mapTransactionToOutput),
      });
    }

    // Exactly one match — apply edits
    const matched = allMatches[0];
    const typeLower = matched.type;

    const updated = {
      date: !isEmpty(newDate) ? newDate : matched.date,
      amount: !isEmpty(newAmountRaw) ? parseFloat(newAmountRaw) : matched.amount,
      description: !isEmpty(newDescription) ? newDescription : matched.description,
      category: !isEmpty(newCategory) ? newCategory : matched.category,
    };

    // Validate new category if provided
    if (!isEmpty(newCategory)) {
      const resolved = resolveCategory(newCategory, typeLower);
      if (!resolved) {
        const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
        return res.status(400).json({
          success: false,
          error_code: 'invalid_category',
          error: `Invalid category for ${typeLower}. Must be one of: ${validList.join(', ')}`,
        });
      }
      updated.category = resolved;
    }

    // Validate new amount if provided
    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }
      updated.amount = amountNum;
    }

    await updateTransactionRow(sheets, txSheet, typeLower, matched.rowIndex, updated);

    const fieldsUpdated = [];
    if (!isEmpty(newDate)) fieldsUpdated.push('date');
    if (!isEmpty(newAmountRaw)) fieldsUpdated.push('amount');
    if (!isEmpty(newDescription)) fieldsUpdated.push('description');
    if (!isEmpty(newCategory)) fieldsUpdated.push('category');

    return res.json({
      success: true,
      found: true,
      ambiguous: false,
      edited: true,
      transaction: mapTransactionToOutput({ ...matched, ...updated, amount: parseFloat(updated.amount) || 0 }),
      fields_updated: fieldsUpdated,
      sheet: txSheet,
    });
  } catch (error) {
    console.error('Search-edit transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Delete Transaction (by row reference)
// ---------------------------------------------------------

app.post('/api/finance/delete-transaction', async (req, res) => {
  try {
    const rowIndexRaw = unwrap(req.body.row_index);
    const type = unwrap(req.body.type);
    const month = unwrap(req.body.month);

    if (isEmpty(rowIndexRaw) || isEmpty(type) || isEmpty(month)) {
      return res.status(400).json({ success: false, error: 'Missing row_index, type, or month' });
    }

    const typeLower = String(type).toLowerCase();
    if (!['income', 'expense'].includes(typeLower)) {
      return res.status(400).json({ success: false, error: 'Invalid type — must be "income" or "expense"' });
    }

    const rowIndex = parseInt(rowIndexRaw, 10);
    if (isNaN(rowIndex) || rowIndex < TX_DATA_START_ROW) {
      return res.status(400).json({ success: false, error: 'Invalid row_index' });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const txSheet = transactionsSheetName(dateStr);

    // Read existing to return what was deleted
    const allRows = await readTransactionRows(sheets, txSheet, typeLower);
    const existing = allRows.find((r) => r.rowIndex === rowIndex);

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Transaction not found at the specified row' });
    }

    await deleteTransactionRow(sheets, txSheet, typeLower, rowIndex);

    return res.json({
      success: true,
      deleted: true,
      transaction: mapTransactionToOutput(existing),
      sheet: txSheet,
    });
  } catch (error) {
    console.error('Delete transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Search Delete Transaction
// ---------------------------------------------------------

app.post('/api/finance/search-delete-transaction', async (req, res) => {
  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchDate = unwrap(req.body.search_date);
    const searchCategory = unwrap(req.body.search_category);
    const searchAmount = unwrap(req.body.search_amount);
    const searchType = unwrap(req.body.search_type);
    const month = unwrap(req.body.month);

    const targetRowIndexRaw = unwrap(req.body.target_row_index);
    const targetRowIndex = !isEmpty(targetRowIndexRaw) ? parseInt(targetRowIndexRaw, 10) : null;

    if (isEmpty(searchKeyword) && isEmpty(searchDate) && isEmpty(searchCategory) && isEmpty(searchAmount) && targetRowIndex === null) {
      return res.status(400).json({
        success: false,
        error: 'At least one search criterion or target_row_index is required',
      });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month || searchDate);
    await ensureMonthlySheets(sheets, dateStr);
    const txSheet = transactionsSheetName(dateStr);

    const sides = isEmpty(searchType)
      ? ['expense', 'income']
      : [String(searchType).toLowerCase()];

    const criteria = { search_keyword: searchKeyword, search_date: searchDate, search_category: searchCategory, search_amount: searchAmount };
    let allMatches = [];

    for (const side of sides) {
      const rows = await readTransactionRows(sheets, txSheet, side);
      const matches = rows.filter((r) => {
        if (targetRowIndex !== null) return r.rowIndex === targetRowIndex;
        return matchesTransaction(r, criteria);
      });
      allMatches = allMatches.concat(matches);
    }

    if (allMatches.length === 0) {
      return res.json({ success: true, found: false, ambiguous: false, deleted: false, candidates: [] });
    }

    if (allMatches.length > 1) {
      return res.json({
        success: true,
        found: false,
        ambiguous: true,
        deleted: false,
        candidates: allMatches.map(mapTransactionToOutput),
      });
    }

    const matched = allMatches[0];
    await deleteTransactionRow(sheets, txSheet, matched.type, matched.rowIndex);

    return res.json({
      success: true,
      found: true,
      ambiguous: false,
      deleted: true,
      transaction: mapTransactionToOutput(matched),
      sheet: txSheet,
    });
  } catch (error) {
    console.error('Search-delete transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// List Transactions
// ---------------------------------------------------------

app.post('/api/finance/list-transactions', async (req, res) => {
  try {
    const body = req.body || {};
    const month = unwrap(body.month);
    const typeFilter = unwrap(body.type);         // "expense", "income", or null (both)
    const categoryFilter = unwrap(body.category);
    const keywordRaw = unwrap(body.keyword);
    const dateMin = unwrap(body.dateMin);
    const dateMax = unwrap(body.dateMax);
    const maxResultsRaw = unwrap(body.maxResults);

    const maxResults = isEmpty(maxResultsRaw) ? 50 : parseInt(String(maxResultsRaw), 10);
    const keyword = isEmpty(keywordRaw) ? null : String(keywordRaw).toLowerCase();

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    await ensureMonthlySheets(sheets, dateStr);
    const txSheet = transactionsSheetName(dateStr);

    const sides = isEmpty(typeFilter)
      ? ['expense', 'income']
      : [String(typeFilter).toLowerCase()];

    let allRows = [];
    for (const side of sides) {
      const rows = await readTransactionRows(sheets, txSheet, side);
      allRows = allRows.concat(rows);
    }

    // Apply filters
    if (!isEmpty(dateMin)) {
      const dMin = parseTxDate(dateMin);
      allRows = allRows.filter((r) => {
        const rd = parseTxDate(r.date);
        return isNaN(rd) || rd === 0 ? true : rd >= dMin;
      });
    }
    if (!isEmpty(dateMax)) {
      const dMax = parseTxDate(dateMax);
      allRows = allRows.filter((r) => {
        const rd = parseTxDate(r.date);
        return isNaN(rd) || rd === 0 ? true : rd <= dMax;
      });
    }
    if (!isEmpty(categoryFilter)) allRows = allRows.filter((r) => (r.category || '').toLowerCase() === String(categoryFilter).toLowerCase());
    if (keyword) allRows = allRows.filter((r) => (r.description || '').toLowerCase().includes(keyword));

    // Sort by date descending
    allRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    allRows = allRows.slice(0, isNaN(maxResults) ? 50 : maxResults);

    const transactions = allRows.map(mapTransactionToOutput);

    return res.json({
      success: true,
      count: transactions.length,
      month: sheetSuffix(dateStr),
      sheet: txSheet,
      transactions,
    });
  } catch (error) {
    console.error('List transactions error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Budget Routes
// ---------------------------------------------------------
// In the Monthly Budget template, "budgets" are the Planned
// amounts on per-category rows in Summary MM/YYYY.

app.post('/api/finance/set-budget', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const category = unwrap(req.body.category);
    const type = unwrap(req.body.type);           // "expense" or "income"
    const plannedAmountRaw = unwrap(req.body.planned_amount);

    if (isEmpty(category) || isEmpty(plannedAmountRaw)) {
      return res.status(400).json({ success: false, error: 'Missing category or planned_amount' });
    }

    const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();
    if (!['income', 'expense'].includes(typeLower)) {
      return res.status(400).json({ success: false, error: 'Invalid type — must be "income" or "expense"' });
    }

    const amountNum = parseFloat(plannedAmountRaw);
    if (isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, error: 'Invalid planned_amount' });
    }

    const catInfo = getCategoryInfo(category, typeLower);
    if (!catInfo) {
      const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
      return res.status(400).json({
        success: false,
        error: `Invalid category for ${typeLower}. Must be one of: ${validList.join(', ')}`,
      });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    await writeSummaryCellValue(sheets, summarySheet, catInfo.plannedCell, amountNum);

    return res.json({
      success: true,
      action: 'set',
      category: catInfo.name,
      type: typeLower,
      planned_amount: amountNum,
      cell: catInfo.plannedCell,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
    });
  } catch (error) {
    console.error('Set budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// edit-budget is an alias for set-budget
app.post('/api/finance/edit-budget', async (req, res) => {
  // Forward to set-budget handler
  req.url = '/api/finance/set-budget';
  app.handle(req, res);
});

// ---------------------------------------------------------
// Search Edit Budget
// ---------------------------------------------------------

app.post('/api/finance/search-edit-budget', async (req, res) => {
  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchType = unwrap(req.body.search_type); // "expense" or "income"
    const month = unwrap(req.body.month);
    const newPlannedAmountRaw = unwrap(req.body.new_planned_amount);

    if (isEmpty(searchKeyword)) {
      return res.status(400).json({
        success: false,
        error: 'search_keyword is required to identify the budget category',
      });
    }

    if (isEmpty(newPlannedAmountRaw)) {
      return res.status(400).json({ success: false, error: 'No changes provided — new_planned_amount is required' });
    }

    const amountNum = parseFloat(newPlannedAmountRaw);
    if (isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, error: 'Invalid new_planned_amount' });
    }

    const typeLower = isEmpty(searchType) ? null : String(searchType).toLowerCase();

    // Determine which category lists to search
    let categoriesToSearch = [];
    if (typeLower === 'expense') {
      categoriesToSearch = EXPENSE_CATEGORIES;
    } else if (typeLower === 'income') {
      categoriesToSearch = INCOME_CATEGORIES;
    } else {
      categoriesToSearch = [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, type: 'expense' })),
        ...INCOME_CATEGORIES.map((c) => ({ ...c, type: 'income' })),
      ];
    }

    // Add type info if not already present
    if (typeLower) {
      categoriesToSearch = categoriesToSearch.map((c) => ({ ...c, type: typeLower }));
    }

    const criteria = { search_keyword: searchKeyword };
    const matches = categoriesToSearch.filter((c) => matchesBudget(c, criteria));

    if (matches.length === 0) {
      return res.json({ success: true, found: false, ambiguous: false, edited: false, candidates: [] });
    }

    if (matches.length > 1) {
      return res.json({
        success: true,
        found: false,
        ambiguous: true,
        edited: false,
        candidates: matches.map((c) => ({ category: c.name, type: c.type, planned_cell: c.plannedCell })),
      });
    }

    const matched = matches[0];
    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    await writeSummaryCellValue(sheets, summarySheet, matched.plannedCell, amountNum);

    return res.json({
      success: true,
      found: true,
      ambiguous: false,
      edited: true,
      category: matched.name,
      type: matched.type,
      new_planned_amount: amountNum,
      cell: matched.plannedCell,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
    });
  } catch (error) {
    console.error('Search-edit budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Delete Budget (clear planned amount)
// ---------------------------------------------------------

app.post('/api/finance/delete-budget', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const category = unwrap(req.body.category);
    const type = unwrap(req.body.type);

    if (isEmpty(category)) {
      return res.status(400).json({ success: false, error: 'Missing category' });
    }

    const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();
    const catInfo = getCategoryInfo(category, typeLower);
    if (!catInfo) {
      const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
      return res.status(400).json({
        success: false,
        error: `Invalid category for ${typeLower}. Must be one of: ${validList.join(', ')}`,
      });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    // Clear the planned cell (set to 0)
    await writeSummaryCellValue(sheets, summarySheet, catInfo.plannedCell, 0);

    return res.json({
      success: true,
      deleted: true,
      category: catInfo.name,
      type: typeLower,
      cell: catInfo.plannedCell,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
    });
  } catch (error) {
    console.error('Delete budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Search Delete Budget
// ---------------------------------------------------------

app.post('/api/finance/search-delete-budget', async (req, res) => {
  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchType = unwrap(req.body.search_type);
    const month = unwrap(req.body.month);

    if (isEmpty(searchKeyword)) {
      return res.status(400).json({
        success: false,
        error: 'search_keyword is required to identify the budget category',
      });
    }

    const typeLower = isEmpty(searchType) ? null : String(searchType).toLowerCase();

    let categoriesToSearch = [];
    if (typeLower === 'expense') {
      categoriesToSearch = EXPENSE_CATEGORIES.map((c) => ({ ...c, type: 'expense' }));
    } else if (typeLower === 'income') {
      categoriesToSearch = INCOME_CATEGORIES.map((c) => ({ ...c, type: 'income' }));
    } else {
      categoriesToSearch = [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, type: 'expense' })),
        ...INCOME_CATEGORIES.map((c) => ({ ...c, type: 'income' })),
      ];
    }

    const criteria = { search_keyword: searchKeyword };
    const matches = categoriesToSearch.filter((c) => matchesBudget(c, criteria));

    if (matches.length === 0) {
      return res.json({ success: true, found: false, ambiguous: false, deleted: false, candidates: [] });
    }

    if (matches.length > 1) {
      return res.json({
        success: true,
        found: false,
        ambiguous: true,
        deleted: false,
        candidates: matches.map((c) => ({ category: c.name, type: c.type, planned_cell: c.plannedCell })),
      });
    }

    const matched = matches[0];
    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    await writeSummaryCellValue(sheets, summarySheet, matched.plannedCell, 0);

    return res.json({
      success: true,
      found: true,
      ambiguous: false,
      deleted: true,
      category: matched.name,
      type: matched.type,
      cell: matched.plannedCell,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
    });
  } catch (error) {
    console.error('Search-delete budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// List Budgets
// ---------------------------------------------------------

app.post('/api/finance/list-budgets', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const typeFilter = unwrap(req.body.type); // "expense", "income", or null (both)

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    const budgets = [];

    const shouldInclude = (t) => isEmpty(typeFilter) || String(typeFilter).toLowerCase() === t;

    if (shouldInclude('expense')) {
      // Batch read all expense planned + actual cells
      const cells = [];
      EXPENSE_CATEGORIES.forEach((c) => {
        cells.push(c.plannedCell, c.actualCell, c.diffCell);
      });
      const values = await readSummaryMultipleCells(sheets, summarySheet, cells);

      EXPENSE_CATEGORIES.forEach((c) => {
        const planned = parseFloat(String(values[c.plannedCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;
        const actual = parseFloat(String(values[c.actualCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;
        const diff = parseFloat(String(values[c.diffCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;

        budgets.push({
          category: c.name,
          type: 'expense',
          planned,
          actual,
          diff,
          planned_cell: c.plannedCell,
        });
      });
    }

    if (shouldInclude('income')) {
      const cells = [];
      INCOME_CATEGORIES.forEach((c) => {
        cells.push(c.plannedCell, c.actualCell, c.diffCell);
      });
      const values = await readSummaryMultipleCells(sheets, summarySheet, cells);

      INCOME_CATEGORIES.forEach((c) => {
        const planned = parseFloat(String(values[c.plannedCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;
        const actual = parseFloat(String(values[c.actualCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;
        const diff = parseFloat(String(values[c.diffCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;

        budgets.push({
          category: c.name,
          type: 'income',
          planned,
          actual,
          diff,
          planned_cell: c.plannedCell,
        });
      });
    }

    return res.json({
      success: true,
      count: budgets.length,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
      budgets,
    });
  } catch (error) {
    console.error('List budgets error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Report Route
// ---------------------------------------------------------

app.post('/api/finance/report', async (req, res) => {
  try {
    const body = req.body || {};
    const queryTypeRaw = unwrap(body.query_type);

    const VALID_QUERY_TYPES = ['balance', 'budget_remaining', 'breakdown', 'period_comparison', 'plan_calculate'];
    const queryType = String(queryTypeRaw || '').trim();

    if (!VALID_QUERY_TYPES.includes(queryType)) {
      return res.status(400).json({
        success: false,
        error: `Missing or invalid query_type. Must be one of: ${VALID_QUERY_TYPES.join(', ')}`,
      });
    }

    const sheets = getSheetsClient();

    // -------------------------------------------------------
    // balance
    // -------------------------------------------------------
    if (queryType === 'balance') {
      const month = unwrap(body.month);
      const dateStr = resolveMonthToDate(month);
      const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

      const cellValues = await readSummaryMultipleCells(sheets, summarySheet, [
        SUMMARY_CELLS.startBalance,
        SUMMARY_CELLS.expensesActualTotal,
        SUMMARY_CELLS.incomeActualTotal,
        SUMMARY_CELLS.expensesPlannedTotal,
        SUMMARY_CELLS.incomePlannedTotal,
      ]);

      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;

      const startBalance = parseCell(cellValues[SUMMARY_CELLS.startBalance]);
      const incomeActual = parseCell(cellValues[SUMMARY_CELLS.incomeActualTotal]);
      const expenseActual = parseCell(cellValues[SUMMARY_CELLS.expensesActualTotal]);
      const incomePlanned = parseCell(cellValues[SUMMARY_CELLS.incomePlannedTotal]);
      const expensePlanned = parseCell(cellValues[SUMMARY_CELLS.expensesPlannedTotal]);

      return res.json({
        success: true,
        query_type: 'balance',
        month: sheetSuffix(dateStr),
        starting_balance: startBalance,
        income_planned: incomePlanned,
        income_actual: incomeActual,
        expenses_planned: expensePlanned,
        expenses_actual: expenseActual,
        end_balance: startBalance + incomeActual - expenseActual,
        savings_this_month: incomeActual - expenseActual,
      });
    }

    // -------------------------------------------------------
    // budget_remaining
    // -------------------------------------------------------
    if (queryType === 'budget_remaining') {
      const month = unwrap(body.month);
      const category = unwrap(body.category);
      const type = unwrap(body.type);

      if (isEmpty(category)) {
        return res.status(400).json({ success: false, error: 'Missing category for budget_remaining query' });
      }

      const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();
      const catInfo = getCategoryInfo(category, typeLower);
      if (!catInfo) {
        return res.status(400).json({ success: false, error: `Category "${category}" not found for type "${typeLower}"` });
      }

      const dateStr = resolveMonthToDate(month);
      const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

      const cellValues = await readSummaryMultipleCells(sheets, summarySheet, [catInfo.plannedCell, catInfo.actualCell, catInfo.diffCell]);
      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;

      const planned = parseCell(cellValues[catInfo.plannedCell]);
      const actual = parseCell(cellValues[catInfo.actualCell]);
      const diff = parseCell(cellValues[catInfo.diffCell]);

      return res.json({
        success: true,
        query_type: 'budget_remaining',
        month: sheetSuffix(dateStr),
        category: catInfo.name,
        type: typeLower,
        planned,
        actual,
        remaining: planned - actual,
        diff,
      });
    }

    // -------------------------------------------------------
    // breakdown
    // -------------------------------------------------------
    if (queryType === 'breakdown') {
      const month = unwrap(body.month);
      const typeFilterRaw = unwrap(body.type);
      const typeLower = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      const dateStr = resolveMonthToDate(month);
      const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

      const categories = typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
      const cells = [];
      categories.forEach((c) => {
        cells.push(c.plannedCell, c.actualCell, c.diffCell);
      });

      const values = await readSummaryMultipleCells(sheets, summarySheet, cells);
      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;

      const breakdown = categories.map((c) => ({
        category: c.name,
        planned: parseCell(values[c.plannedCell]),
        actual: parseCell(values[c.actualCell]),
        diff: parseCell(values[c.diffCell]),
      }));

      const totalActual = breakdown.reduce((sum, b) => sum + b.actual, 0);
      const breakdownWithPct = breakdown.map((b) => ({
        ...b,
        percentage: totalActual > 0 ? Math.round((b.actual / totalActual) * 100) : 0,
      }));

      return res.json({
        success: true,
        query_type: 'breakdown',
        month: sheetSuffix(dateStr),
        type: typeLower,
        total_actual: totalActual,
        breakdown: breakdownWithPct,
      });
    }

    // -------------------------------------------------------
    // period_comparison
    // -------------------------------------------------------
    if (queryType === 'period_comparison') {
      const currentMonth = unwrap(body.current_month);
      const previousMonth = unwrap(body.previous_month);
      const typeFilterRaw = unwrap(body.type);
      const typeLower = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      if (isEmpty(currentMonth) || isEmpty(previousMonth)) {
        return res.status(400).json({ success: false, error: 'Missing current_month or previous_month for period_comparison' });
      }

      const currentDateStr = resolveMonthToDate(currentMonth);
      const previousDateStr = resolveMonthToDate(previousMonth);

      const { summarySheet: currentSummary } = await ensureMonthlySheets(sheets, currentDateStr);
      const { summarySheet: previousSummary } = await ensureMonthlySheets(sheets, previousDateStr);

      const totalCell = typeLower === 'income' ? SUMMARY_CELLS.incomeActualTotal : SUMMARY_CELLS.expensesActualTotal;

      const currentVal = await readSummaryCellValue(sheets, currentSummary, totalCell);
      const previousVal = await readSummaryCellValue(sheets, previousSummary, totalCell);

      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;
      const currentTotal = parseCell(currentVal);
      const previousTotal = parseCell(previousVal);

      return res.json({
        success: true,
        query_type: 'period_comparison',
        type: typeLower,
        current: { month: sheetSuffix(currentDateStr), total: currentTotal },
        previous: { month: sheetSuffix(previousDateStr), total: previousTotal },
        difference: currentTotal - previousTotal,
        change_percentage: previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 100) : null,
      });
    }

    // -------------------------------------------------------
    // plan_calculate
    // -------------------------------------------------------
    if (queryType === 'plan_calculate') {
      const category = unwrap(body.category);
      const amountRaw = unwrap(body.amount);
      const type = unwrap(body.type);
      const month = unwrap(body.month);

      if (isEmpty(category) || isEmpty(amountRaw)) {
        return res.status(400).json({
          success: false,
          error_code: 'missing_fields',
          error: 'Missing category or amount for plan_calculate query',
        });
      }

      const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();
      const catInfo = getCategoryInfo(category, typeLower);
      if (!catInfo) {
        const validList = (typeLower === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => c.name);
        return res.status(400).json({
          success: false,
          error_code: 'invalid_category',
          error: `Invalid category. Must be one of: ${validList.join(', ')}`,
        });
      }

      const amountNum = parseFloat(amountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }

      const dateStr = resolveMonthToDate(month);
      const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

      const cellValues = await readSummaryMultipleCells(sheets, summarySheet, [catInfo.plannedCell, catInfo.actualCell]);
      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;

      const planned = parseCell(cellValues[catInfo.plannedCell]);
      const actual = parseCell(cellValues[catInfo.actualCell]);
      const projectedActual = actual + amountNum;
      const enough = projectedActual <= planned;

      return res.json({
        success: true,
        query_type: 'plan_calculate',
        type: typeLower,
        category: catInfo.name,
        amount: amountNum,
        month: sheetSuffix(dateStr),
        planned,
        actual_before: actual,
        projected_actual: projectedActual,
        remaining_before: planned - actual,
        remaining_after: planned - projectedActual,
        within_budget: enough,
      });
    }

    return res.status(400).json({ success: false, error: `Unknown query_type: ${queryType}` });
  } catch (error) {
    console.error('Report error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Fallback
app.get('/api/finance/ping', (req, res) => res.json({ message: 'Finance Express Server is running!' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;