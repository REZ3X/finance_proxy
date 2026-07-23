require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

const TRANSACTIONS_SHEET = 'Transactions';
const BUDGETS_SHEET = 'Budgets';

const TRANSACTIONS_HEADERS = ['id', 'date', 'type', 'category', 'amount', 'description', 'created', 'updated'];
const BUDGETS_HEADERS = ['id', 'title', 'amount', 'period_start', 'period_end', 'created', 'updated'];

// ---------------------------------------------------------
// Helper Functions (carried over from reminder bot)
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

function generateId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
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
// Generic Sheet Helpers
// ---------------------------------------------------------

async function getSheetGid(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return sheet.properties.sheetId;
}

// Reads all data rows (excluding header). rowIndex is the ACTUAL 1-indexed Sheets row
// (header = row 1, so first data row = 2) — needed later for update/delete targeting.
async function readSheetRows(sheets, sheetName, headers) {
  const lastCol = String.fromCharCode(64 + headers.length);
  const range = `${sheetName}!A2:${lastCol}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  return rows
    .map((row, idx) => {
      const obj = { rowIndex: idx + 2 };
      headers.forEach((h, i) => {
        obj[h] = row[i] !== undefined ? row[i] : '';
      });
      return obj;
    })
    .filter((obj) => !isEmpty(obj.id)); // skip fully blank trailing rows
}

async function appendRow(sheets, sheetName, headers, rowObject) {
  const rowArray = headers.map((h) =>
    rowObject[h] !== undefined && rowObject[h] !== null ? String(rowObject[h]) : ''
  );
  const lastCol = String.fromCharCode(64 + headers.length);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:${lastCol}`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] },
  });
}

async function updateRowByIndex(sheets, sheetName, headers, rowIndex, rowObject) {
  const rowArray = headers.map((h) =>
    rowObject[h] !== undefined && rowObject[h] !== null ? String(rowObject[h]) : ''
  );
  const lastCol = String.fromCharCode(64 + headers.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}:${lastCol}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowArray] },
  });
}

async function deleteRowByIndex(sheets, sheetName, rowIndex) {
  const sheetId = await getSheetGid(sheets, sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1, // 0-indexed for batchUpdate
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });
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
      return res.status(400).json({ success: false, error: 'Missing date, type, or amount' });
    }

    const typeLower = String(cleanType).toLowerCase();
    if (!['income', 'expense'].includes(typeLower)) {
      return res.status(400).json({ success: false, error: 'Invalid type — must be "income" or "expense"' });
    }

    const amountNum = parseFloat(cleanAmountRaw);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const finalCategory = isEmpty(cleanCategory) ? 'Lainnya' : cleanCategory;
    const finalDescription = isEmpty(cleanDescription) ? '' : cleanDescription;

    const sheets = getSheetsClient();
    const id = generateId();
    const timestamp = nowISO();

    const rowObject = {
      id,
      date: cleanDate,
      type: typeLower,
      category: finalCategory,
      amount: amountNum,
      description: finalDescription,
      created: timestamp,
      updated: timestamp,
    };

    await appendRow(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS, rowObject);

    return res.json({ success: true, transaction: rowObject });
  } catch (error) {
    console.error('Create transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/edit-transaction', async (req, res) => {
  try {
    const id = unwrap(req.body.id) || 
               unwrap(req.body.tx_transaction_id) || 
               (req.body.node_output ? (unwrap(req.body.node_output.id) || unwrap(req.body.node_output.tx_transaction_id)) : undefined);
    const newDate = unwrap(req.body.new_date);
    const newType = unwrap(req.body.new_type);
    const newCategory = unwrap(req.body.new_category);
    const newAmountRaw = unwrap(req.body.new_amount);
    const newDescription = unwrap(req.body.new_description);

    if (isEmpty(id)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid transaction id' });
    }

    if (isEmpty(newDate) && isEmpty(newType) && isEmpty(newCategory) && isEmpty(newAmountRaw) && isEmpty(newDescription)) {
      return res.status(400).json({ success: false, error: 'No changes provided — nothing to update' });
    }

    const sheets = getSheetsClient();
    const rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
    const match = rows.find((r) => r.id === id);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    const updated = { ...match };
    const fieldsUpdated = [];

    if (!isEmpty(newDate)) { updated.date = newDate; fieldsUpdated.push('date'); }

    if (!isEmpty(newType)) {
      const t = String(newType).toLowerCase();
      if (!['income', 'expense'].includes(t)) {
        return res.status(400).json({ success: false, error: 'Invalid type — must be "income" or "expense"' });
      }
      updated.type = t;
      fieldsUpdated.push('type');
    }

    if (!isEmpty(newCategory)) { updated.category = newCategory; fieldsUpdated.push('category'); }

    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }
      updated.amount = amountNum;
      fieldsUpdated.push('amount');
    }

    if (!isEmpty(newDescription)) { updated.description = newDescription; fieldsUpdated.push('description'); }

    updated.updated = nowISO();

    await updateRowByIndex(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS, match.rowIndex, updated);

    return res.json({
      success: true,
      transaction: {
        id: updated.id,
        date: updated.date,
        type: updated.type,
        category: updated.category,
        amount: updated.amount,
        description: updated.description,
        created: updated.created,
        updated: updated.updated,
      },
      fields_updated: fieldsUpdated,
    });
  } catch (error) {
    console.error('Edit transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/delete-transaction', async (req, res) => {
  try {
    const id = unwrap(req.body.id) || 
               unwrap(req.body.tx_transaction_id) || 
               (req.body.node_output ? (unwrap(req.body.node_output.id) || unwrap(req.body.node_output.tx_transaction_id)) : undefined);

    if (isEmpty(id)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid transaction id' });
    }

    const sheets = getSheetsClient();
    const rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
    const match = rows.find((r) => r.id === id);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    await deleteRowByIndex(sheets, TRANSACTIONS_SHEET, match.rowIndex);

    return res.json({ success: true, deleted_id: id });
  } catch (error) {
    console.error('Delete transaction error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/list-transactions', async (req, res) => {
  try {
    const body = req.body || {};
    const dateMin = unwrap(body.dateMin);
    const dateMax = unwrap(body.dateMax);
    const typeFilter = unwrap(body.type);
    const categoryFilter = unwrap(body.category);
    const keywordRaw = unwrap(body.keyword);
    const maxResultsRaw = unwrap(body.maxResults);

    const maxResults = isEmpty(maxResultsRaw) ? 50 : parseInt(String(maxResultsRaw), 10);
    const keyword = isEmpty(keywordRaw) ? null : String(keywordRaw).toLowerCase();

    const sheets = getSheetsClient();
    let rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);

    if (!isEmpty(dateMin)) rows = rows.filter((r) => r.date >= dateMin);
    if (!isEmpty(dateMax)) rows = rows.filter((r) => r.date <= dateMax);
    if (!isEmpty(typeFilter)) rows = rows.filter((r) => r.type === String(typeFilter).toLowerCase());
    if (!isEmpty(categoryFilter)) rows = rows.filter((r) => r.category.toLowerCase() === String(categoryFilter).toLowerCase());
    if (keyword) rows = rows.filter((r) => r.description.toLowerCase().includes(keyword));

    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // most recent first

    rows = rows.slice(0, isNaN(maxResults) ? 50 : maxResults);

    const transactions = rows.map((r) => ({
      id: r.id,
      date: r.date,
      type: r.type,
      category: r.category,
      amount: parseFloat(r.amount) || 0,
      description: r.description,
      created: r.created,
      updated: r.updated,
    }));

    return res.json({ success: true, count: transactions.length, transactions });
  } catch (error) {
    console.error('List transactions error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------
// Budget Routes
// ---------------------------------------------------------

app.post('/api/finance/set-budget', async (req, res) => {
  try {
    const title = unwrap(req.body.title);
    const amountRaw = unwrap(req.body.amount);
    const periodStart = unwrap(req.body.period_start);
    const periodEnd = unwrap(req.body.period_end);

    if (isEmpty(title) || isEmpty(amountRaw) || isEmpty(periodStart) || isEmpty(periodEnd)) {
      return res.status(400).json({ success: false, error: 'Missing title, amount, period_start, or period_end' });
    }

    const amountNum = parseFloat(amountRaw);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const sheets = getSheetsClient();
    const rows = await readSheetRows(sheets, BUDGETS_SHEET, BUDGETS_HEADERS);

    // Upsert match: same title (case-insensitive) AND overlapping period
    const existing = rows.find((r) => {
      if (r.title.toLowerCase() !== String(title).toLowerCase()) return false;
      return r.period_start <= periodEnd && r.period_end >= periodStart;
    });

    const timestamp = nowISO();

    if (existing) {
      const updated = {
        ...existing,
        title,
        amount: amountNum,
        period_start: periodStart,
        period_end: periodEnd,
        updated: timestamp,
      };
      await updateRowByIndex(sheets, BUDGETS_SHEET, BUDGETS_HEADERS, existing.rowIndex, updated);

      return res.json({
        success: true,
        action: 'updated',
        budget: {
          id: updated.id,
          title: updated.title,
          amount: updated.amount,
          period_start: updated.period_start,
          period_end: updated.period_end,
          created: updated.created,
          updated: updated.updated,
        },
      });
    }

    const id = generateId();
    const rowObject = {
      id,
      title,
      amount: amountNum,
      period_start: periodStart,
      period_end: periodEnd,
      created: timestamp,
      updated: timestamp,
    };
    await appendRow(sheets, BUDGETS_SHEET, BUDGETS_HEADERS, rowObject);

    return res.json({ success: true, action: 'created', budget: rowObject });
  } catch (error) {
    console.error('Set budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/edit-budget', async (req, res) => {
  try {
    const id = unwrap(req.body.id) ||
               unwrap(req.body.budget_id) ||
               (req.body.node_output ? (unwrap(req.body.node_output.id) || unwrap(req.body.node_output.budget_id)) : undefined);
    const newTitle = unwrap(req.body.new_title);
    const newAmountRaw = unwrap(req.body.new_amount);
    const newPeriodStart = unwrap(req.body.new_period_start);
    const newPeriodEnd = unwrap(req.body.new_period_end);

    if (isEmpty(id)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid budget id' });
    }

    if (isEmpty(newTitle) && isEmpty(newAmountRaw) && isEmpty(newPeriodStart) && isEmpty(newPeriodEnd)) {
      return res.status(400).json({ success: false, error: 'No changes provided — nothing to update' });
    }

    const sheets = getSheetsClient();
    const rows = await readSheetRows(sheets, BUDGETS_SHEET, BUDGETS_HEADERS);
    const match = rows.find((r) => r.id === id);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Budget not found' });
    }

    const updated = { ...match };
    const fieldsUpdated = [];

    if (!isEmpty(newTitle)) {
      updated.title = newTitle;
      fieldsUpdated.push('title');
    }

    if (!isEmpty(newAmountRaw)) {
      const amountNum = parseFloat(newAmountRaw);
      if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }
      updated.amount = amountNum;
      fieldsUpdated.push('amount');
    }

    if (!isEmpty(newPeriodStart)) {
      updated.period_start = newPeriodStart;
      fieldsUpdated.push('period_start');
    }

    if (!isEmpty(newPeriodEnd)) {
      updated.period_end = newPeriodEnd;
      fieldsUpdated.push('period_end');
    }

    updated.updated = nowISO();

    await updateRowByIndex(sheets, BUDGETS_SHEET, BUDGETS_HEADERS, match.rowIndex, updated);

    return res.json({
      success: true,
      budget: {
        id: updated.id,
        title: updated.title,
        amount: updated.amount,
        period_start: updated.period_start,
        period_end: updated.period_end,
        created: updated.created,
        updated: updated.updated,
      },
      fields_updated: fieldsUpdated,
    });
  } catch (error) {
    console.error('Edit budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/delete-budget', async (req, res) => {
  try {
    const id = unwrap(req.body.id) || 
               unwrap(req.body.budget_id) || 
               unwrap(req.body.tx_budget_id) || 
               (req.body.node_output ? (unwrap(req.body.node_output.id) || unwrap(req.body.node_output.budget_id) || unwrap(req.body.node_output.tx_budget_id)) : undefined);

    if (isEmpty(id)) {
      return res.status(400).json({ success: false, error: 'Missing or invalid budget id' });
    }

    const sheets = getSheetsClient();
    const rows = await readSheetRows(sheets, BUDGETS_SHEET, BUDGETS_HEADERS);
    const match = rows.find((r) => r.id === id);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Budget not found' });
    }

    await deleteRowByIndex(sheets, BUDGETS_SHEET, match.rowIndex);

    return res.json({ success: true, deleted_id: id });
  } catch (error) {
    console.error('Delete budget error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/finance/list-budgets', async (req, res) => {
  try {
    const body = req.body || {};
    const activeOnly = unwrap(body.activeOnly);
    const today = nowISO().slice(0, 10);

    const sheets = getSheetsClient();
    let rows = await readSheetRows(sheets, BUDGETS_SHEET, BUDGETS_HEADERS);

    if (!isEmpty(activeOnly) && String(activeOnly).toLowerCase() === 'true') {
      rows = rows.filter((r) => r.period_start <= today && r.period_end >= today);
    }

    const budgets = rows.map((r) => ({
      id: r.id,
      title: r.title,
      amount: parseFloat(r.amount) || 0,
      period_start: r.period_start,
      period_end: r.period_end,
      created: r.created,
      updated: r.updated,
    }));

    return res.json({ success: true, count: budgets.length, budgets });
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

    const VALID_QUERY_TYPES = ['balance', 'budget_remaining', 'breakdown', 'period_comparison'];
    const queryType = String(queryTypeRaw || '').trim();

    if (!VALID_QUERY_TYPES.includes(queryType)) {
      return res.status(400).json({
        success: false,
        error: `Missing or invalid query_type. Must be one of: ${VALID_QUERY_TYPES.join(', ')}`,
      });
    }

    const sheets = getSheetsClient();

    if (queryType === 'balance') {
      const rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
      const income = rows.filter((r) => r.type === 'income').reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
      const expense = rows.filter((r) => r.type === 'expense').reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

      return res.json({ success: true, query_type: 'balance', income, expense, balance: income - expense });
    }

    if (queryType === 'budget_remaining') {
      const budgetTitle = unwrap(body.budget_title);
      if (isEmpty(budgetTitle)) {
        return res.status(400).json({ success: false, error: 'Missing budget_title for budget_remaining query' });
      }

      const budgetRows = await readSheetRows(sheets, BUDGETS_SHEET, BUDGETS_HEADERS);
      const today = nowISO().slice(0, 10);

      const candidates = budgetRows.filter(
        (b) =>
          b.title.toLowerCase() === String(budgetTitle).toLowerCase() &&
          b.period_start <= today &&
          b.period_end >= today
      );

      if (candidates.length === 0) {
        return res.status(404).json({ success: false, error: 'No active budget found with that title' });
      }

      candidates.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
      const budget = candidates[0];

      const txRows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
      const spent = txRows
        .filter(
          (t) =>
            t.type === 'expense' &&
            t.category.toLowerCase() === budget.title.toLowerCase() &&
            t.date >= budget.period_start &&
            t.date <= budget.period_end
        )
        .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);

      const budgetAmount = parseFloat(budget.amount) || 0;

      return res.json({
        success: true,
        query_type: 'budget_remaining',
        budget: {
          id: budget.id,
          title: budget.title,
          amount: budgetAmount,
          period_start: budget.period_start,
          period_end: budget.period_end,
        },
        spent,
        remaining: budgetAmount - spent,
      });
    }

    if (queryType === 'breakdown') {
      const dateMin = unwrap(body.dateMin);
      const dateMax = unwrap(body.dateMax);
      const typeFilterRaw = unwrap(body.type);
      const typeFilter = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      const rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
      let filtered = rows.filter((r) => r.type === typeFilter);

      if (!isEmpty(dateMin)) filtered = filtered.filter((r) => r.date >= dateMin);
      if (!isEmpty(dateMax)) filtered = filtered.filter((r) => r.date <= dateMax);

      const grouped = {};
      filtered.forEach((r) => {
        const cat = r.category || 'Lainnya';
        grouped[cat] = (grouped[cat] || 0) + (parseFloat(r.amount) || 0);
      });

      const breakdown = Object.entries(grouped)
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total);

      return res.json({
        success: true,
        query_type: 'breakdown',
        type: typeFilter,
        period: { dateMin: dateMin || null, dateMax: dateMax || null },
        breakdown,
      });
    }

    if (queryType === 'period_comparison') {
      const currentMin = unwrap(body.currentMin);
      const currentMax = unwrap(body.currentMax);
      const previousMin = unwrap(body.previousMin);
      const previousMax = unwrap(body.previousMax);
      const typeFilterRaw = unwrap(body.type);
      const typeFilter = isEmpty(typeFilterRaw) ? 'expense' : String(typeFilterRaw).toLowerCase();

      if (isEmpty(currentMin) || isEmpty(currentMax) || isEmpty(previousMin) || isEmpty(previousMax)) {
        return res.status(400).json({ success: false, error: 'Missing one or more period bounds for period_comparison' });
      }

      const rows = await readSheetRows(sheets, TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS);
      const typed = rows.filter((r) => r.type === typeFilter);

      const sumInRange = (min, max) =>
        typed.filter((r) => r.date >= min && r.date <= max).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

      const currentTotal = sumInRange(currentMin, currentMax);
      const previousTotal = sumInRange(previousMin, previousMax);

      return res.json({
        success: true,
        query_type: 'period_comparison',
        type: typeFilter,
        current: { period: { dateMin: currentMin, dateMax: currentMax }, total: currentTotal },
        previous: { period: { dateMin: previousMin, dateMax: previousMax }, total: previousTotal },
        difference: currentTotal - previousTotal,
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