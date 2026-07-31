require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();

app.use(cors());
app.use(express.json());

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// Base template sheet names (cloned per-month, never written to directly)

const BASE_SUMMARY = 'Summary';
const BASE_TRANSACTIONS = 'Transactions';

// Transactions sheet: expenses in cols B–E, income in cols G–J, data from row 5+

/** Parse date string from YYYY-MM-DD, DD/MM/YYYY, or MM/DD/YYYY to epoch ms. */
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

    // Disambiguate MM/DD vs DD/MM: value >12 must be day. Default: MM/DD/YYYY.
    let month, day;
    if (p0 > 12) {
      day = p0;
      month = p1;
    } else if (p1 > 12) {
      month = p0;
      day = p1;
    } else {
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

// Summary sheet layout: starting balance L8, expense rows 28–41, income rows 28–33

const STARTING_BALANCE_CELL = 'L8';

// Categories are now loaded dynamically from the Summary sheet using loadCategories()
// Summary aggregate cells
const SUMMARY_CELLS = {
  expensesPlannedTotal: 'D26',
  expensesActualTotal: 'E26',
  incomePlannedTotal: 'J26',
  incomeActualTotal: 'K26',
  startBalance: 'L8',
};

// --- Helpers ---

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
// Dynamic Category Management
// ---------------------------------------------------------

/** Load categories dynamically from Summary sheet. Returns { expenses, income }. */
async function loadCategories(sheets, sheetName) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [`'${sheetName}'!B28:B`, `'${sheetName}'!H28:H`],
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const expRows = response.data.valueRanges[0].values || [];
  const incRows = response.data.valueRanges[1].values || [];

  const parseCat = (name, rowIndex, colOffset) => {
    const isEmptyStr = isEmpty(name);
    return {
      name: isEmptyStr ? '' : String(name),
      row: rowIndex,
      plannedCell: `${String.fromCharCode(66 + colOffset + 2)}${rowIndex}`,
      actualCell: `${String.fromCharCode(66 + colOffset + 3)}${rowIndex}`,
      diffCell: `${String.fromCharCode(66 + colOffset + 4)}${rowIndex}`,
      isEmpty: isEmptyStr,
    };
  };

  const expenses = [];
  for (let i = 0; i < expRows.length; i++) {
    expenses.push(parseCat(expRows[i][0], 28 + i, 0));
  }

  const income = [];
  for (let i = 0; i < incRows.length; i++) {
    income.push(parseCat(incRows[i][0], 28 + i, 6));
  }

  while (expenses.length > 14 && expenses[expenses.length - 1].isEmpty) expenses.pop();
  while (income.length > 6 && income[income.length - 1].isEmpty) income.pop();

  while (expenses.length < 14) expenses.push(parseCat('', 28 + expenses.length, 0));
  while (income.length < 6) income.push(parseCat('', 28 + income.length, 6));

  return { expenses, income };
}

/** Insert a blank category row dynamically inside the table bounds to expand formulas. */
async function insertCategoryRow(sheets, sheetId, type, rowIndex) {
  // 1. Insert blank row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex
          },
          inheritFromBefore: true
        }
      }]
    }
  });

  // 2. copyPaste ONLY the relevant columns from the row above to copy formulas
  const isExp = type === 'expense';
  const startCol = isExp ? 1 : 7; // B is 1, H is 7
  const endCol = isExp ? 6 : 12;  // F is 6 (exclusive), L is 12 (exclusive)

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        copyPaste: {
          source: {
            sheetId: sheetId,
            startRowIndex: rowIndex - 2, // The row above
            endRowIndex: rowIndex - 1,
            startColumnIndex: startCol,
            endColumnIndex: endCol
          },
          destination: {
            sheetId: sheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: startCol,
            endColumnIndex: endCol
          },
          pasteType: 'PASTE_NORMAL'
        }
      }]
    }
  });

  // 3. Clear the copied Name and Planned amount in the new row so it's a true blank slot
  const cellToClearName = `${isExp ? 'B' : 'H'}${rowIndex}`;
  const cellToClearPlanned = `${isExp ? 'D' : 'J'}${rowIndex}`;
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { ranges: [`'Summary'!${cellToClearName}`, `'Summary'!${cellToClearPlanned}`] }
  });
}


// --- Sheet Naming ---

/** Returns "MM/YYYY" suffix for sheet naming. */
function sheetSuffix(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
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

/** Dynamically resolve or insert a category into the Summary sheet. Returns the category object. */
async function ensureCategoryExists(sheets, summarySheet, summarySheetId, categoryName, type) {
  if (isEmpty(categoryName)) {
    categoryName = 'Other';
  }

  const { expenses, income } = await loadCategories(sheets, summarySheet);
  const catList = type === 'income' ? income : expenses;
  const searchName = String(categoryName).trim();

  const found = catList.find(c => !c.isEmpty && c.name.toLowerCase() === searchName.toLowerCase());
  if (found) {
    found.isNew = false;
    return found;
  }

  let slot = catList.find(c => c.isEmpty);

  if (!slot) {
    const lastRowIndex = catList[catList.length - 1].row;
    await insertCategoryRow(sheets, summarySheetId, type, lastRowIndex);

    const colOffset = type === 'income' ? 6 : 0;
    slot = {
      name: searchName,
      row: lastRowIndex, // The new blank row is at the lastRowIndex, pushing the old one down
      plannedCell: `${String.fromCharCode(66 + colOffset + 2)}${lastRowIndex}`,
      actualCell: `${String.fromCharCode(66 + colOffset + 3)}${lastRowIndex}`,
      diffCell: `${String.fromCharCode(66 + colOffset + 4)}${lastRowIndex}`,
      isEmpty: false
    };
  }

  const cellName = `${type === 'income' ? 'H' : 'B'}${slot.row}`;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${summarySheet}'!${cellName}`, values: [[searchName]] },
        { range: `'${summarySheet}'!${slot.plannedCell}`, values: [[0]] } // Init planned to 0
      ]
    }
  });

  slot.name = searchName;
  slot.isEmpty = false;
  slot.isNew = true;
  return slot;
}

// --- Sheet CRUD ---

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

  // Fix formula references (e.g. Transactions! → 'Transactions 07/2026'!)
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


  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });

  return newSheetId;
}

/** Ensure monthly Transactions + Summary sheets exist; clone from template if missing. */
async function ensureMonthlySheets(sheets, dateStr) {
  const txName = transactionsSheetName(dateStr);
  const sumName = summarySheetName(dateStr);

  const allSheets = await listAllSheets(sheets);
  const titles = allSheets.map((s) => s.title);

  const txExists = titles.includes(txName);
  const sumExists = titles.includes(sumName);

  let summarySheetId = null;

  if (!txExists) {
    await cloneSheet(sheets, BASE_TRANSACTIONS, txName);
  }
  if (!sumExists) {
    summarySheetId = await cloneSheet(sheets, BASE_SUMMARY, sumName, BASE_TRANSACTIONS, txName);
  } else {
    const sumSheet = allSheets.find((s) => s.title === sumName);
    if (sumSheet) summarySheetId = sumSheet.sheetId;
  }

  // Clear template placeholder data from newly created sheets
  const rangesToClear = [];
  if (!sumExists) {
    rangesToClear.push(
      `'${sumName}'!L8`,        // Starting balance
      `'${sumName}'!D28:D41`,   // Planned expenses
      `'${sumName}'!J28:J33`,   // Planned income
      `'${sumName}'!B39:B41`,   // Custom category 1, 2, 3 placeholders
      `'${sumName}'!H33`        // Custom category placeholder
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

  return { transactionsSheet: txName, summarySheet: sumName, summarySheetId, created: !txExists || !sumExists };
}

// --- Transaction Row Operations ---

/** Read all rows from one side (expense/income). Returns [{rowIndex, date, amount, description, category}]. */
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

/** Append a transaction row to the next empty row on the given side. */
async function appendTransactionRow(sheets, sheetName, side, data) {
  const cols = TX_COLS[side];


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

/** Overwrite a specific transaction row. */
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

/** Clear a transaction row (no row-shift to preserve formula references). */
async function deleteTransactionRow(sheets, sheetName, side, rowIndex) {
  const cols = TX_COLS[side];
  const range = `'${sheetName}'!${cols.first}${rowIndex}:${cols.last}${rowIndex}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
}

// --- Summary Sheet Helpers ---

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

/** Batch-read multiple cells from a Summary sheet. Returns {cell: value}. */
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

// --- Transaction Matching ---

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

// --- Budget Matching ---

function matchesBudget(categoryEntry, criteria) {
  let ok = true;

  if (!isEmpty(criteria.search_keyword)) {
    const name = (categoryEntry.name || '').toLowerCase();
    ok = ok && name.includes(String(criteria.search_keyword).toLowerCase());
  }

  return ok;
}

// --- Balance Routes ---


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


app.post('/api/finance/balance', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const newBalance = unwrap(req.body.starting_balance);


    const dateStr = resolveMonthToDate(month);
    const sheets = getSheetsClient();

    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    if (!isEmpty(newBalance)) {

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

/** Normalize month input ("MM/YYYY", "YYYY-MM-DD", or null) to a date string. */
function resolveMonthToDate(monthInput) {
  if (isEmpty(monthInput)) {
    return nowISO().slice(0, 10);
  }
  const str = String(monthInput).trim();
  const mmYYYY = str.match(/^(\d{2})\/(\d{4})$/);
  if (mmYYYY) {
    return `${mmYYYY[2]}-${mmYYYY[1]}-01`;
  }

  return str;
}

// --- Transaction Routes ---

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


    const sheets = getSheetsClient();
    const { transactionsSheet: txSheet, summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, cleanDate);

    const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, cleanCategory, typeLower);
    const finalCategory = catInfo.name;

    const finalDescription = isEmpty(cleanDescription) ? '' : cleanDescription;


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

// --- Edit Transaction (by row_index) ---

app.post('/api/finance/edit-transaction', async (req, res) => {
  try {
    const rowIndexRaw = unwrap(req.body.row_index);
    const type = unwrap(req.body.type);
    const month = unwrap(req.body.month);

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
    const { transactionsSheet: txSheet, summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);

    const allRows = await readTransactionRows(sheets, txSheet, typeLower);
    const existing = allRows.find((r) => r.rowIndex === rowIndex);

    if (!existing) {
      return res.status(404).json({ success: false, error_code: 'not_found', error: 'Transaction not found at the specified row' });
    }

    const updated = {
      date: !isEmpty(newDate) ? newDate : existing.date,
      amount: !isEmpty(newAmountRaw) ? parseFloat(newAmountRaw) : existing.amount,
      description: !isEmpty(newDescription) ? newDescription : existing.description,
      category: !isEmpty(newCategory) ? newCategory : existing.category,
    };

    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }
      updated.amount = amountNum;
    }

    if (!isEmpty(newCategory)) {
      const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, newCategory, typeLower);
      updated.category = catInfo.name;
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

// --- Search Edit Transaction (content-based match + apply changes) ---

app.post('/api/finance/search-edit-transaction', async (req, res) => {
  console.log('========== SEARCH-EDIT-TRANSACTION ==========');
  console.log('[DEBUG] RAW BODY:', JSON.stringify(req.body));

  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchDate = unwrap(req.body.search_date);
    const searchCategory = unwrap(req.body.search_category);
    const searchAmount = unwrap(req.body.search_amount);
    const searchType = unwrap(req.body.search_type);
    const month = unwrap(req.body.month);

    const newDate = unwrap(req.body.new_date);
    const newAmountRaw = unwrap(req.body.new_amount);
    const newDescription = unwrap(req.body.new_description);
    const newCategory = unwrap(req.body.new_category);

    const targetRowIndexRaw = unwrap(req.body.target_row_index);
    const targetRowIndex = !isEmpty(targetRowIndexRaw) ? parseInt(targetRowIndexRaw, 10) : null;

    console.log('[DEBUG] Parsed criteria:', {
      searchKeyword, searchDate, searchCategory, searchAmount, searchType, month, targetRowIndex,
    });
    console.log('[DEBUG] Parsed changes:', { newDate, newAmountRaw, newDescription, newCategory });

    if (isEmpty(searchKeyword) && isEmpty(searchDate) && isEmpty(searchCategory) && isEmpty(searchAmount) && targetRowIndex === null) {
      console.log('[DEBUG] REJECTED: no search criterion or target_row_index provided');
      return res.status(400).json({
        success: false,
        error: 'At least one search criterion or target_row_index is required',
      });
    }

    if (isEmpty(newDate) && isEmpty(newAmountRaw) && isEmpty(newDescription) && isEmpty(newCategory)) {
      console.log('[DEBUG] REJECTED: no change fields provided');
      return res.status(400).json({ success: false, error: 'No changes provided — nothing to update' });
    }

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month || searchDate);
    console.log('[DEBUG] resolveMonthToDate(month || searchDate) =', dateStr);

    const { transactionsSheet: txSheet, summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);
    console.log('[DEBUG] Target sheet:', txSheet);

    const sides = isEmpty(searchType)
      ? ['expense', 'income']
      : [String(searchType).toLowerCase()];
    console.log('[DEBUG] Sides being searched:', sides);

    // Pass 1: match by keyword/date/category (amount excluded — too volatile for hard match)
    const softCriteria = { search_keyword: searchKeyword, search_date: searchDate, search_category: searchCategory };
    let allMatches = [];

    for (const side of sides) {
      const rows = await readTransactionRows(sheets, txSheet, side);
      console.log(`[DEBUG] Rows read from "${txSheet}" (${side}):`, JSON.stringify(rows));

      const matches = rows.filter((r) => {
        if (targetRowIndex !== null) {
          const isMatch = r.rowIndex === targetRowIndex;
          console.log(`[DEBUG]   row ${r.rowIndex} vs target_row_index=${targetRowIndex} → ${isMatch}`);
          return isMatch;
        }
        const isMatch = matchesTransaction(r, softCriteria);
        console.log(`[DEBUG]   row ${r.rowIndex} {date:"${r.date}", amount:${r.amount}, desc:"${r.description}", category:"${r.category}"} vs soft criteria ${JSON.stringify(softCriteria)} → ${isMatch}`);
        return isMatch;
      });

      allMatches = allMatches.concat(matches);
    }

    console.log('[DEBUG] Soft-match total:', allMatches.length, JSON.stringify(allMatches));

    // Pass 2: use amount as tiebreaker only if multiple candidates remain
    if (allMatches.length > 1 && !isEmpty(searchAmount) && targetRowIndex === null) {
      const searchAmt = parseFloat(searchAmount);
      const amountNarrowed = allMatches.filter((r) => {
        const rowAmt = parseFloat(r.amount);
        const isMatch = !isNaN(searchAmt) && !isNaN(rowAmt) && Math.abs(rowAmt - searchAmt) < 0.01;
        console.log(`[DEBUG]   (amount tiebreak) row ${r.rowIndex} amount=${rowAmt} vs search_amount=${searchAmt} → ${isMatch}`);
        return isMatch;
      });
      if (amountNarrowed.length > 0) {
        console.log('[DEBUG] Amount tiebreak narrowed matches from', allMatches.length, 'to', amountNarrowed.length);
        allMatches = amountNarrowed;
      } else {
        console.log('[DEBUG] Amount tiebreak matched nothing — keeping original soft-match candidates (amount may be stale)');
      }
    }

    console.log('[DEBUG] Total matches found:', allMatches.length, JSON.stringify(allMatches));

    if (allMatches.length === 0) {
      console.log('[DEBUG] RESULT: found=false, ambiguous=false');
      return res.json({ success: true, found: false, ambiguous: false, edited: false, candidates: [] });
    }

    if (allMatches.length > 1) {
      console.log('[DEBUG] RESULT: ambiguous=true');
      return res.json({
        success: true,
        found: false,
        ambiguous: true,
        edited: false,
        candidates: allMatches.map(mapTransactionToOutput),
      });
    }

    const matched = allMatches[0];
    console.log('[DEBUG] Single match — proceeding to edit:', JSON.stringify(matched));
    const typeLower = matched.type;

    const updated = {
      date: !isEmpty(newDate) ? newDate : matched.date,
      amount: !isEmpty(newAmountRaw) ? parseFloat(newAmountRaw) : matched.amount,
      description: !isEmpty(newDescription) ? newDescription : matched.description,
      category: !isEmpty(newCategory) ? newCategory : matched.category,
    };

    if (!isEmpty(newCategory)) {
      const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, newCategory, typeLower);
      updated.category = catInfo.name;
    }

    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        console.log('[DEBUG] REJECTED: invalid new_amount', newAmountRaw);
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }
      updated.amount = amountNum;
    }

    console.log('[DEBUG] Writing update to row', matched.rowIndex, ':', JSON.stringify(updated));
    await updateTransactionRow(sheets, txSheet, typeLower, matched.rowIndex, updated);

    const fieldsUpdated = [];
    if (!isEmpty(newDate)) fieldsUpdated.push('date');
    if (!isEmpty(newAmountRaw)) fieldsUpdated.push('amount');
    if (!isEmpty(newDescription)) fieldsUpdated.push('description');
    if (!isEmpty(newCategory)) fieldsUpdated.push('category');

    console.log('[DEBUG] SUCCESS. Fields updated:', fieldsUpdated);

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
    console.error('[DEBUG] Search-edit transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --- Delete Transaction (by row_index) ---

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

// --- Search Delete Transaction (content-based match + delete) ---

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

// --- List Transactions ---

app.post('/api/finance/list-transactions', async (req, res) => {
  try {
    const body = req.body || {};
    const month = unwrap(body.month);
    const typeFilter = unwrap(body.type);
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

// --- Planned (Budget) Routes ---
// Planned amounts on per-category rows in Summary MM/YYYY.

app.post('/api/finance/set-planned', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const category = unwrap(req.body.category);
    const type = unwrap(req.body.type);
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

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);

    const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, category, typeLower);

    await writeSummaryCellValue(sheets, summarySheet, catInfo.plannedCell, amountNum);

    return res.json({
      success: true,
      action: 'set',
      is_new: catInfo.isNew,
      category: catInfo.name,
      type: typeLower,
      planned_amount: amountNum,
      cell: catInfo.plannedCell,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
    });
  } catch (error) {
    console.error('Set planned error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// edit-planned forwards to set-planned
app.post('/api/finance/edit-planned', async (req, res) => {
  req.url = '/api/finance/set-planned';
  app.handle(req, res);
});

// --- Search Edit Planned ---

app.post('/api/finance/search-edit-planned', async (req, res) => {
  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchType = unwrap(req.body.search_type); // "expense" or "income"
    const month = unwrap(req.body.month);
    const newPlannedAmountRaw = unwrap(req.body.new_planned_amount);

    if (isEmpty(searchKeyword)) {
      return res.status(400).json({
        success: false,
        error: 'search_keyword is required to identify the category',
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

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    const { expenses, income } = await loadCategories(sheets, summarySheet);

    let categoriesToSearch = [];
    if (typeLower === 'expense') {
      categoriesToSearch = expenses.map(c => ({ ...c, type: 'expense' })).filter(c => !c.isEmpty);
    } else if (typeLower === 'income') {
      categoriesToSearch = income.map(c => ({ ...c, type: 'income' })).filter(c => !c.isEmpty);
    } else {
      categoriesToSearch = [
        ...expenses.map((c) => ({ ...c, type: 'expense' })).filter(c => !c.isEmpty),
        ...income.map((c) => ({ ...c, type: 'income' })).filter(c => !c.isEmpty),
      ];
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
    console.error('Search-edit planned error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const DEFAULT_CATEGORIES = [
  'food', 'gifts', 'health/medical', 'home', 'transportation',
  'personal', 'pets', 'utilities', 'travel', 'debt', 'other',
  'savings', 'paycheck', 'bonus', 'interest'
];

async function executePlannedDeletion(sheets, summarySheet, catInfo) {
  const actualValues = await readSummaryMultipleCells(sheets, summarySheet, [catInfo.actualCell]);
  const actual = parseFloat(String(actualValues[catInfo.actualCell] || '0').replace(/[^0-9.\-]/g, '')) || 0;

  const isDefault = DEFAULT_CATEGORIES.includes(catInfo.name.toLowerCase());

  if (actual === 0 && !isDefault) {
    const nameCol = catInfo.plannedCell.startsWith('C') ? 'B' : 'H';
    const nameCell = `${nameCol}${catInfo.row}`;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${summarySheet}'!${nameCell}`, values: [['']] },
          { range: `'${summarySheet}'!${catInfo.plannedCell}`, values: [[0]] }
        ]
      }
    });
  } else {
    await executePlannedDeletion(sheets, summarySheet, catInfo);
  }
}

// --- Delete Planned (clear planned amount) ---

app.post('/api/finance/delete-planned', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const category = unwrap(req.body.category);
    const type = unwrap(req.body.type);

    if (isEmpty(category)) {
      return res.status(400).json({ success: false, error: 'Missing category' });
    }

    const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);

    const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, category, typeLower);

    await executePlannedDeletion(sheets, summarySheet, catInfo);

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
    console.error('Delete planned error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --- Search Delete Planned ---

app.post('/api/finance/search-delete-planned', async (req, res) => {
  try {
    const searchKeyword = unwrap(req.body.search_keyword);
    const searchType = unwrap(req.body.search_type);
    const month = unwrap(req.body.month);

    if (isEmpty(searchKeyword)) {
      return res.status(400).json({
        success: false,
        error: 'search_keyword is required to identify the category',
      });
    }

    const typeLower = isEmpty(searchType) ? null : String(searchType).toLowerCase();

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    const { expenses, income } = await loadCategories(sheets, summarySheet);

    let categoriesToSearch = [];
    if (typeLower === 'expense') {
      categoriesToSearch = expenses.map(c => ({ ...c, type: 'expense' })).filter(c => !c.isEmpty);
    } else if (typeLower === 'income') {
      categoriesToSearch = income.map(c => ({ ...c, type: 'income' })).filter(c => !c.isEmpty);
    } else {
      categoriesToSearch = [
        ...expenses.map((c) => ({ ...c, type: 'expense' })).filter(c => !c.isEmpty),
        ...income.map((c) => ({ ...c, type: 'income' })).filter(c => !c.isEmpty),
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

    await executePlannedDeletion(sheets, summarySheet, matched);

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
    console.error('Search-delete planned error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --- List Planned ---

app.post('/api/finance/list-planned', async (req, res) => {
  try {
    const month = unwrap(req.body.month);
    const typeFilter = unwrap(req.body.type);

    const sheets = getSheetsClient();
    const dateStr = resolveMonthToDate(month);
    const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

    const { expenses, income } = await loadCategories(sheets, summarySheet);

    const budgets = [];

    const shouldInclude = (t) => isEmpty(typeFilter) || String(typeFilter).toLowerCase() === t;

    if (shouldInclude('expense')) {
      const activeExpenses = expenses.filter(c => !c.isEmpty);
      if (activeExpenses.length > 0) {
        const cells = activeExpenses.map(c => [c.plannedCell, c.actualCell, c.diffCell]).flat();
        const values = await readSummaryMultipleCells(sheets, summarySheet, cells);

        activeExpenses.forEach((c) => {
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
    }

    if (shouldInclude('income')) {
      const activeIncome = income.filter(c => !c.isEmpty);
      if (activeIncome.length > 0) {
        const cells = activeIncome.map(c => [c.plannedCell, c.actualCell, c.diffCell]).flat();
        const values = await readSummaryMultipleCells(sheets, summarySheet, cells);

        activeIncome.forEach((c) => {
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
    }

    return res.json({
      success: true,
      count: budgets.length,
      month: sheetSuffix(dateStr),
      sheet: summarySheet,
      budgets,
    });
  } catch (error) {
    console.error('List planned error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --- Report Route ---

app.post('/api/finance/report', async (req, res) => {
  try {
    const body = req.body || {};
    const queryTypeRaw = unwrap(body.query_type);

    const VALID_QUERY_TYPES = ['balance', 'budget_remaining', 'breakdown', 'period_comparison', 'plan_calculate', 'trend', 'category_share', 'top_transactions'];
    const queryType = String(queryTypeRaw || '').trim();

    if (!VALID_QUERY_TYPES.includes(queryType)) {
      return res.status(400).json({
        success: false,
        error: `Missing or invalid query_type. Must be one of: ${VALID_QUERY_TYPES.join(', ')}`,
      });
    }

    const sheets = getSheetsClient();

    // -- balance --
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

      const savingsThisMonth = incomeActual - expenseActual;
      const savingsRate = incomeActual > 0 ? savingsThisMonth / incomeActual : 0;

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
        savings_this_month: savingsThisMonth,
        savings_rate: savingsRate,
      });
    }

    // -- budget_remaining --
    if (queryType === 'budget_remaining') {
      const month = unwrap(body.month);
      const category = unwrap(body.category);
      const type = unwrap(body.type);

      if (isEmpty(category)) {
        return res.status(400).json({ success: false, error: 'Missing category for budget_remaining query' });
      }

      const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();

      const dateStr = resolveMonthToDate(month);
      const { summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);

      const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, category, typeLower);

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

    // -- breakdown --
    if (queryType === 'breakdown') {
      const month = unwrap(body.month);
      const typeFilterRaw = unwrap(body.type);
      const typeLower = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      const dateStr = resolveMonthToDate(month);
      const { summarySheet } = await ensureMonthlySheets(sheets, dateStr);

      const { expenses, income } = await loadCategories(sheets, summarySheet);
      const categories = (typeLower === 'income' ? income : expenses).filter(c => !c.isEmpty);

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

    // -- period_comparison --
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

    // -- plan_calculate --
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

      const amountNum = parseFloat(amountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error_code: 'invalid_amount', error: 'Invalid amount' });
      }

      const typeLower = isEmpty(type) ? 'expense' : String(type).toLowerCase();

      // Income check (no funds check needed)
      if (typeLower === 'income') {
        return res.json({
          success: true,
          query_type: 'plan_calculate',
          checked_against: 'none',
          type: 'income',
          amount: amountNum,
          enough: true
        });
      }

      const dateStr = resolveMonthToDate(month);
      const { summarySheet, summarySheetId } = await ensureMonthlySheets(sheets, dateStr);

      const catInfo = await ensureCategoryExists(sheets, summarySheet, summarySheetId, category, typeLower);

      const cellValues = await readSummaryMultipleCells(sheets, summarySheet, [
        catInfo.plannedCell,
        catInfo.actualCell,
        SUMMARY_CELLS.startBalance,
        SUMMARY_CELLS.incomeActualTotal,
        SUMMARY_CELLS.expensesActualTotal
      ]);
      const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;

      const planned = parseCell(cellValues[catInfo.plannedCell]);
      const actual = parseCell(cellValues[catInfo.actualCell]);
      const projectedActual = actual + amountNum;

      if (planned > 0) {
        // Check against budget
        return res.json({
          success: true,
          query_type: 'plan_calculate',
          checked_against: 'budget',
          budget: { title: catInfo.name, amount: planned },
          spent_before: actual,
          projected_spent: projectedActual,
          remaining_before: planned - actual,
          remaining_after: planned - projectedActual,
          enough: (planned - projectedActual >= 0)
        });
      } else {
        // Check against overall balance
        const startBal = parseCell(cellValues[SUMMARY_CELLS.startBalance]);
        const incAct = parseCell(cellValues[SUMMARY_CELLS.incomeActualTotal]);
        const expAct = parseCell(cellValues[SUMMARY_CELLS.expensesActualTotal]);
        const current_balance = startBal + incAct - expAct;
        const projected_balance = current_balance - amountNum;
        
        return res.json({
          success: true,
          query_type: 'plan_calculate',
          checked_against: 'balance',
          current_balance,
          amount: amountNum,
          projected_balance,
          enough: (projected_balance >= 0)
        });
      }
    }

    // -- Helpers for trend & category_share --
    const getMonthsList = (bodyMonths, bodyCount, baseMonthStr) => {
      let mList = bodyMonths;
      if (typeof mList === 'string') {
        try { mList = JSON.parse(mList); } catch (e) {}
      }
      if (!Array.isArray(mList)) mList = null;

      if (mList && mList.length > 0) return mList.map(m => sheetSuffix(resolveMonthToDate(m)));

      const countRaw = unwrap(bodyCount);
      const count = !isEmpty(countRaw) ? parseInt(countRaw, 10) : 6;
      const baseDate = new Date(resolveMonthToDate(baseMonthStr));
      
      const result = [];
      for (let i = count - 1; i >= 0; i--) {
        const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        result.push(`${mm}/${d.getFullYear()}`);
      }
      return result;
    };

    // -- trend --
    if (queryType === 'trend') {
      const monthInput = unwrap(body.month);
      const targetMonths = getMonthsList(body.months, body.count, monthInput);

      const trendData = [];
      for (const m of targetMonths) {
        const dStr = resolveMonthToDate(m);
        const { summarySheet } = await ensureMonthlySheets(sheets, dStr);
        
        const cellValues = await readSummaryMultipleCells(sheets, summarySheet, [
          SUMMARY_CELLS.expensesActualTotal,
          SUMMARY_CELLS.incomeActualTotal,
        ]);
        const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;
        
        trendData.push({
          month: m,
          income_actual: parseCell(cellValues[SUMMARY_CELLS.incomeActualTotal]),
          expenses_actual: parseCell(cellValues[SUMMARY_CELLS.expensesActualTotal]),
        });
      }

      return res.json({
        success: true,
        query_type: 'trend',
        months: targetMonths,
        trend: trendData
      });
    }

    // -- category_share --
    if (queryType === 'category_share') {
      const monthInput = unwrap(body.month);
      const categoryFilter = unwrap(body.category);
      const typeFilterRaw = unwrap(body.type);
      const typeLower = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();
      
      const targetMonths = getMonthsList(body.months, body.count, monthInput);

      const shareData = [];
      for (const m of targetMonths) {
        const dStr = resolveMonthToDate(m);
        const { summarySheet } = await ensureMonthlySheets(sheets, dStr);
        
        const { expenses, income } = await loadCategories(sheets, summarySheet);
        const categories = (typeLower === 'income' ? income : expenses).filter(c => !c.isEmpty);
        
        const totalCell = typeLower === 'income' ? SUMMARY_CELLS.incomeActualTotal : SUMMARY_CELLS.expensesActualTotal;
        
        const cellsToRead = [totalCell];
        let targetCatInfo = null;
        if (!isEmpty(categoryFilter)) {
          const searchName = String(categoryFilter).trim().toLowerCase();
          targetCatInfo = categories.find(c => c.name.toLowerCase() === searchName);
          if (targetCatInfo) cellsToRead.push(targetCatInfo.actualCell);
        } else {
          categories.forEach(c => cellsToRead.push(c.actualCell));
        }

        const values = await readSummaryMultipleCells(sheets, summarySheet, cellsToRead);
        const parseCell = (v) => parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')) || 0;
        
        const totalActual = parseCell(values[totalCell]);
        
        if (targetCatInfo) {
          const actual = parseCell(values[targetCatInfo.actualCell]);
          shareData.push({
            month: m,
            category: targetCatInfo.name,
            actual,
            total_actual: totalActual,
            percentage: totalActual > 0 ? Math.round((actual / totalActual) * 100) : 0
          });
        } else {
          const breakdown = categories.map(c => {
            const act = parseCell(values[c.actualCell]);
            return {
              category: c.name,
              actual: act,
              percentage: totalActual > 0 ? Math.round((act / totalActual) * 100) : 0
            };
          });
          shareData.push({
            month: m,
            total_actual: totalActual,
            breakdown
          });
        }
      }

      return res.json({
        success: true,
        query_type: 'category_share',
        type: typeLower,
        months: targetMonths,
        share: shareData
      });
    }

    // -- top_transactions --
    if (queryType === 'top_transactions') {
      const month = unwrap(body.month);
      const limitRaw = unwrap(body.limit) || unwrap(body.count) || unwrap(body.n);
      const limit = !isEmpty(limitRaw) ? parseInt(limitRaw, 10) : 5;
      const typeFilterRaw = unwrap(body.type);
      const typeLower = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      const dateStr = resolveMonthToDate(month);
      await ensureMonthlySheets(sheets, dateStr);
      const txSheet = transactionsSheetName(dateStr);

      const sides = typeLower === 'all' ? ['expense', 'income'] : [typeLower];
      
      let allRows = [];
      for (const side of sides) {
        const rows = await readTransactionRows(sheets, txSheet, side);
        allRows = allRows.concat(rows);
      }

      // Sort by amount descending
      allRows.sort((a, b) => {
        const amtA = parseFloat(a.amount) || 0;
        const amtB = parseFloat(b.amount) || 0;
        return amtB - amtA;
      });

      const topRows = allRows.slice(0, limit);
      const transactions = topRows.map(mapTransactionToOutput);

      return res.json({
        success: true,
        query_type: 'top_transactions',
        month: sheetSuffix(dateStr),
        type: typeLower,
        limit,
        transactions
      });
    }

    return res.status(400).json({ success: false, error: `Unknown query_type: ${queryType}` });
  } catch (error) {
    console.error('Report error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/finance/ping', (req, res) => res.json({ message: 'Finance Express Server is running!' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;