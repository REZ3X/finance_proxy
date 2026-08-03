# Finance Proxy API Reference

This document provides a comprehensive reference of all endpoints exposed by the Finance Proxy backend, designed to interface with the Google Sheets API using the Monthly Budget template.

## Base URL
All API endpoints are prefixed with:
```
/api/finance
```
When deployed, the complete path will be:
```
https://<your-domain>/api/finance/<operation>
```

---

## Request Preprocessing & Helper Behaviors

The API applies specific input parsing and normalization rules to incoming request parameters:

### 1. Value Unwrapping (`unwrap`)
To accommodate chatbot platforms that may pass variables inside JSON arrays or as stringified arrays, all input values are automatically run through an `unwrap` function.
* **Array Input**: `["value"]` becomes `"value"`.
* **Stringified Array**: `'["value"]'` becomes `"value"`.
* **Null/Undefined**: Resolves to `undefined`.
* **Other values**: Cast to string (`String(value)`).

### 2. Emptiness Check (`isEmpty`)
Values are considered empty if they are `null`, `undefined`, or resolve to any of the following (case-insensitive, trimmed strings):
`""`, `"null"`, `"undefined"`, `"[]"`, `"[\"\"]"`, `"nan"`.

### 3. Month Resolution (`resolveMonthToDate`)
Several endpoints accept a `month` parameter. The system resolves it as follows:
* **`"MM/YYYY"` format** (e.g. `"07/2026"`): Treated as the 1st of that month → `"2026-07-01"`.
* **`"YYYY-MM-DD"` format**: Used as-is.
* **Empty / omitted**: Defaults to today's date (current month).

---

## Spreadsheet Structure

The API operates on a Google Sheets workbook using the **Monthly Budget template**. Each month gets a pair of sheets:

| Sheet | Naming Format | Example |
| :--- | :--- | :--- |
| Transactions | `Transactions MM/YYYY` | `Transactions 07/2026` |
| Summary | `Summary MM/YYYY` | `Summary 07/2026` |

Base templates `Transactions` and `Summary` are **never modified** — they are used only as clone sources.

### Auto-Provisioning
When any endpoint targets a month whose sheets don't yet exist, both `Transactions MM/YYYY` and `Summary MM/YYYY` are automatically cloned from the base templates before the operation proceeds.

---

## Standard Data Structures

### The `Transaction` Object
Transaction CRUD and search operations return transactions in this layout:

```json
{
  "row_index": 4,
  "date": "2026-07-15",
  "amount": 25000,
  "description": "Grab to office",
  "category": "Transportation",
  "type": "expense"
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `row_index` | Number | The 1-indexed row number on the Transactions sheet. Used for direct edit/delete. |
| `date` | String | Transaction date in `YYYY-MM-DD` format. |
| `amount` | Number | Transaction amount (parsed as float). |
| `description` | String | Free-text description of the transaction. |
| `category` | String | Category from the fixed template list. |
| `type` | String | `"expense"` or `"income"` — derived from which side of the sheet the row is on. |

### The `Budget` Object
Budget operations return category budget data in this layout:

```json
{
  "category": "Food",
  "type": "expense",
  "planned": 500000,
  "actual": 320000,
  "diff": 180000,
  "planned_cell": "C24"
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `category` | String | Category name from the fixed template. |
| `type` | String | `"expense"` or `"income"`. |
| `planned` | Number | The budgeted/planned amount (user-editable cell). |
| `actual` | Number | The actual amount (formula-computed from Transactions). |
| `diff` | Number | Planned minus Actual (formula-computed). |
| `planned_cell` | String | The cell reference on the Summary sheet (e.g. `"C24"`). |

### Dynamic Category Lists

The categories are now read dynamically from the Summary sheet for the requested month. When creating or editing transactions, if an unknown category is provided, the backend will automatically register it as a new category on the Summary sheet.

The default template comes with several standard categories for Expense and Income.

> [!IMPORTANT]
> Category matching is **case-insensitive**. However, the system always stores and returns the canonical cased form (e.g. `"Health/medical"`, not `"health/medical"`).

---

## Endpoints Reference

### 1. Ping Backend Status
Verify if the server is running and reachable.

* **HTTP Method**: `GET`
* **Path**: `/ping`
* **Headers**: `None`
* **Request Body**: `None`

#### Responses

##### Case 1: Successful Connection (HTTP 200)
```json
{
  "message": "Finance Express Server is running!"
}
```

---

### 2. Balance
Read or set the starting balance on a month's Summary sheet (cell `L8`).

* **HTTP Method**: `POST`
* **Path**: `/balance`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `month` | String | No | Current month | Target month as `"MM/YYYY"` or a date string. |
  | `starting_balance` | Number \| String | No | | If provided, **sets** the starting balance. If omitted, **reads** it. |

#### Responses

##### Case 1: GET — Read Starting Balance (HTTP 200)
Returned when `starting_balance` is not provided.
```json
{
  "success": true,
  "action": "get",
  "starting_balance": 5000000,
  "starting_balance_raw": "Rp5,000,000",
  "month": "07/2026",
  "summary_sheet": "Summary 07/2026"
}
```

> [!NOTE]
> `starting_balance` is the parsed numeric value. `starting_balance_raw` is the raw cell content (may contain currency formatting). If the cell is empty or unparseable, `starting_balance` will be `null`.

##### Case 2: SET — Write Starting Balance (HTTP 200)
Returned when `starting_balance` is provided.
```json
{
  "success": true,
  "action": "set",
  "starting_balance": 5000000,
  "month": "07/2026",
  "summary_sheet": "Summary 07/2026"
}
```

##### Case 3: Validation Failure — Invalid Balance Value (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid starting_balance value"
}
```

##### Case 4: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 2.5. Current Balance
Fetches the current real-time balance for the active calendar month. This endpoint ignores any passed dates and is fixed to the server's current month. It calculates the total from the active Summary sheet (`Starting Balance + Income Actual Total - Expenses Actual Total`).

* **HTTP Method**: `GET` (or `POST`)
* **Path**: `/current-balance`
* **Headers**: `None`
* **Request Body**: `None` (ignores all parameters)

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "query_type": "current_balance",
  "month": "08/2026",
  "starting_balance": 5000000,
  "income_actual": 2000000,
  "expenses_actual": 1500000,
  "current_balance": 5500000
}
```

##### Case 2: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 3. Create Transaction
Adds a new expense or income entry to the appropriate side of the `Transactions MM/YYYY` sheet.

* **HTTP Method**: `POST`
* **Path**: `/create-transaction`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `date` | String | **Yes** | | Transaction date (`YYYY-MM-DD`). Determines the target monthly sheet. |
  | `type` | String | **Yes** | | `"expense"` or `"income"`. Determines which side of the sheet. |
  | `amount` | Number \| String | **Yes** | | Transaction amount. Must be a positive number. |
  | `category` | String | No | `"Other"` | If the category doesn't exist, it will be automatically registered on the Summary sheet. |
  | `description` | String | No | `""` | Free-text description. |

> [!NOTE]
> If the monthly sheets for the transaction's date do not yet exist, they are automatically cloned from the base templates before the row is appended.

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "transaction": {
    "row_index": 5,
    "date": "2026-07-15",
    "type": "expense",
    "category": "Food",
    "amount": 25000,
    "description": "Lunch at warung"
  },
  "sheet": "Transactions 07/2026"
}
```

##### Case 2: Validation Failure — Missing Required Fields (HTTP 400)
```json
{
  "success": false,
  "error_code": "missing_fields",
  "error": "Missing date, type, or amount"
}
```

##### Case 3: Validation Failure — Invalid Type (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_type",
  "error": "Invalid type — must be \"income\" or \"expense\""
}
```

##### Case 4: Validation Failure — Invalid Amount (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_amount",
  "error": "Invalid amount"
}
```

##### Case 5: Validation Failure — Invalid Category (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_category",
  "error": "Invalid category for expense. (Validation error)"
}
```

##### Case 6: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error_code": "server_error",
  "error": "Detailed error message"
}
```

---

### 4. Edit Transaction (By Row Reference) [COMMENTED OUT]

> [!WARNING]
> This endpoint has been commented out in the codebase. It is recommended to use `5. Search & Edit Transaction` instead.
Updates an existing transaction using its `row_index`, `type`, and `month` — values typically obtained from a prior `list-transactions` or `search-edit-transaction` response.

* **HTTP Method**: `POST`
* **Path**: `/edit-transaction`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `row_index` | Number \| String | **Yes** | | The row number on the Transactions sheet (from a prior list/search). |
  | `type` | String | **Yes** | | `"expense"` or `"income"` — which side of the sheet. |
  | `month` | String | **Yes** | | Target month as `"MM/YYYY"` or a date string. |
  | **Update Fields** | | *(At least one)* | | |
  | `new_date` | String | No | | New date (`YYYY-MM-DD`). |
  | `new_amount` | Number \| String | No | | New amount. Must be positive. |
  | `new_description` | String | No | | New description text. |
  | `new_category` | String | No | | New category. If the category doesn't exist, it will be automatically registered on the Summary sheet. |

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "transaction": {
    "row_index": 5,
    "type": "expense",
    "date": "2026-07-15",
    "amount": 30000,
    "description": "Lunch at warung (updated)",
    "category": "Food"
  },
  "fields_updated": ["amount", "description"],
  "sheet": "Transactions 07/2026"
}
```

##### Case 2: Validation Failure — Missing Identifiers (HTTP 400)
```json
{
  "success": false,
  "error_code": "missing_fields",
  "error": "Missing row_index, type, or month"
}
```

##### Case 3: Validation Failure — Invalid Type (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_type",
  "error": "Invalid type — must be \"income\" or \"expense\""
}
```

##### Case 4: Validation Failure — No Fields to Update (HTTP 400)
```json
{
  "success": false,
  "error_code": "no_changes",
  "error": "No changes provided — nothing to update"
}
```

##### Case 5: Validation Failure — Invalid Row Index (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_row",
  "error": "Invalid row_index"
}
```

##### Case 6: Transaction Not Found (HTTP 404)
Returned if no data exists at the specified row.
```json
{
  "success": false,
  "error_code": "not_found",
  "error": "Transaction not found at the specified row"
}
```

##### Case 7: Validation Failure — Invalid Amount (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_amount",
  "error": "Invalid amount"
}
```

##### Case 8: Validation Failure — Invalid Category (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_category",
  "error": "Invalid category for expense. (Validation error)"
}
```

##### Case 9: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error_code": "server_error",
  "error": "Detailed error message"
}
```

---

### 5. Search & Edit Transaction
Searches for transactions matching criteria and modifies the matched transaction. This is the recommended approach when the exact `row_index` is unknown (e.g. from chatbot interaction).

* **HTTP Method**: `POST`
* **Path**: `/search-edit-transaction`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | **Search Fields** | | *(At least one)* | |
  | `search_keyword` | String | No | Case-insensitive substring match on description. |
  | `search_date` | String | No | Exact match on transaction date (`YYYY-MM-DD`). |
  | `search_category` | String | No | Case-insensitive exact match on category. |
  | `search_amount` | Number \| String | No | Exact match on amount (tolerance: ±0.01). |
  | **Context Fields** | | | |
  | `search_type` | String | No | `"expense"` or `"income"` to narrow search to one side. If omitted, both sides are searched. |
  | `month` | String | No | Target month as `"MM/YYYY"` or date string. Defaults to month derived from `search_date`, or current month. |
  | **Update Fields** | | *(At least one)* | |
  | `new_date` | String | No | New date (`YYYY-MM-DD`). |
  | `new_amount` | Number \| String | No | New amount. Must be positive. |
  | `new_description` | String | No | New description text. |
  | `new_category` | String | No | New category. If the category doesn't exist, it will be automatically registered on the Summary sheet. |

> [!NOTE]
> The search scans all data rows on the target month's Transactions sheet. If `search_type` is omitted, both the Expenses side and Income side are searched.

#### Responses

##### Case 1: Exactly One Match — Successful Update (HTTP 200)
```json
{
  "success": true,
  "found": true,
  "ambiguous": false,
  "edited": true,
  "transaction": {
    "row_index": 5,
    "date": "2026-07-15",
    "amount": 30000,
    "description": "Lunch at warung (updated)",
    "category": "Food",
    "type": "expense"
  },
  "fields_updated": ["amount", "description"],
  "sheet": "Transactions 07/2026"
}
```

##### Case 2: Ambiguous Match — Multiple Transactions Match (HTTP 200)
No changes are applied. Returns the candidate transactions for disambiguation.
```json
{
  "success": true,
  "found": false,
  "ambiguous": true,
  "edited": false,
  "candidates": [
    {
      "row_index": 5,
      "date": "2026-07-15",
      "amount": 25000,
      "description": "Lunch at warung A",
      "category": "Food",
      "type": "expense"
    },
    {
      "row_index": 8,
      "date": "2026-07-15",
      "amount": 18000,
      "description": "Lunch at warung B",
      "category": "Food",
      "type": "expense"
    }
  ]
}
```

##### Case 3: No Match Found (HTTP 200)
```json
{
  "success": true,
  "found": false,
  "ambiguous": false,
  "edited": false,
  "candidates": []
}
```

##### Case 4: Validation Failure — Missing Search Criteria (HTTP 400)
```json
{
  "success": false,
  "error": "At least one search criterion (search_keyword, search_date, search_category, or search_amount) is required"
}
```

##### Case 5: Validation Failure — No New Fields to Update (HTTP 400)
```json
{
  "success": false,
  "error": "No changes provided — nothing to update"
}
```

##### Case 6: Validation Failure — Invalid Category (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_category",
  "error": "Invalid category for expense. (Validation error)"
}
```

##### Case 7: Validation Failure — Invalid Amount (HTTP 400)
```json
{
  "success": false,
  "error_code": "invalid_amount",
  "error": "Invalid amount"
}
```

##### Case 8: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 6. Delete Transaction (By Row Reference) [COMMENTED OUT]

> [!WARNING]
> This endpoint has been commented out in the codebase. It is recommended to use `7. Search & Delete Transaction` instead.
Deletes (clears) a specific transaction row using its `row_index`, `type`, and `month`.

* **HTTP Method**: `POST`
* **Path**: `/delete-transaction`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `row_index` | Number \| String | **Yes** | Row number on the Transactions sheet. |
  | `type` | String | **Yes** | `"expense"` or `"income"`. |
  | `month` | String | **Yes** | Target month as `"MM/YYYY"` or date string. |

> [!NOTE]
> Deletion **clears** the row content rather than shifting rows, to avoid breaking the template's SUMIFS formulas that reference specific row ranges.

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "deleted": true,
  "transaction": {
    "row_index": 5,
    "date": "2026-07-15",
    "amount": 25000,
    "description": "Lunch at warung",
    "category": "Food",
    "type": "expense"
  },
  "sheet": "Transactions 07/2026"
}
```

##### Case 2: Validation Failure — Missing Identifiers (HTTP 400)
```json
{
  "success": false,
  "error": "Missing row_index, type, or month"
}
```

##### Case 3: Validation Failure — Invalid Type (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid type — must be \"income\" or \"expense\""
}
```

##### Case 4: Validation Failure — Invalid Row Index (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid row_index"
}
```

##### Case 5: Transaction Not Found (HTTP 404)
```json
{
  "success": false,
  "error": "Transaction not found at the specified row"
}
```

##### Case 6: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 7. Search & Delete Transaction
Searches for transactions matching criteria and deletes the matched transaction. This is the recommended approach when the exact `row_index` is unknown.

* **HTTP Method**: `POST`
* **Path**: `/search-delete-transaction`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | **Search Fields** | | *(At least one)* | |
  | `search_keyword` | String | No | Case-insensitive substring match on description. |
  | `search_date` | String | No | Exact match on transaction date (`YYYY-MM-DD`). |
  | `search_category` | String | No | Case-insensitive exact match on category. |
  | `search_amount` | Number \| String | No | Exact match on amount (tolerance: ±0.01). |
  | **Context Fields** | | | |
  | `search_type` | String | No | `"expense"` or `"income"`. If omitted, both sides are searched. |
  | `month` | String | No | Target month. Defaults to month from `search_date`, or current month. |

> [!IMPORTANT]
> At least one search parameter must be provided.

#### Responses

##### Case 1: Exactly One Match — Successful Deletion (HTTP 200)
```json
{
  "success": true,
  "found": true,
  "ambiguous": false,
  "deleted": true,
  "transaction": {
    "row_index": 5,
    "date": "2026-07-15",
    "amount": 25000,
    "description": "Lunch at warung",
    "category": "Food",
    "type": "expense"
  },
  "sheet": "Transactions 07/2026"
}
```

##### Case 2: Ambiguous Match — Multiple Transactions Match (HTTP 200)
No deletion is performed. Returns the candidate transactions.
```json
{
  "success": true,
  "found": false,
  "ambiguous": true,
  "deleted": false,
  "candidates": [
    {
      "row_index": 5,
      "date": "2026-07-15",
      "amount": 25000,
      "description": "Lunch at warung A",
      "category": "Food",
      "type": "expense"
    },
    {
      "row_index": 8,
      "date": "2026-07-15",
      "amount": 18000,
      "description": "Lunch at warung B",
      "category": "Food",
      "type": "expense"
    }
  ]
}
```

##### Case 3: No Match Found (HTTP 200)
```json
{
  "success": true,
  "found": false,
  "ambiguous": false,
  "deleted": false,
  "candidates": []
}
```

##### Case 4: Validation Failure — Missing Search Criteria (HTTP 400)
```json
{
  "success": false,
  "error": "At least one search criterion (search_keyword, search_date, search_category, or search_amount) is required"
}
```

##### Case 5: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 8. List Transactions
Lists and filters transactions for a given month.

* **HTTP Method**: `POST`
* **Path**: `/list-transactions`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `month` | String | No | Current month | Target month as `"MM/YYYY"` or date string. |
  | `type` | String | No | *(both)* | `"expense"`, `"income"`, or omit for both sides. |
  | `category` | String | No | | Case-insensitive exact match on category. |
  | `keyword` | String | No | | Case-insensitive substring match on description. |
  | `dateMin` | String | No | | Lower bound date filter (`YYYY-MM-DD`). |
  | `dateMax` | String | No | | Upper bound date filter (`YYYY-MM-DD`). |
  | `maxResults` | Number \| String | No | `50` | Maximum number of transactions to return. |

> [!NOTE]
> Results are sorted by date in **descending** order (newest first) and then truncated to `maxResults`.

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "count": 3,
  "month": "07/2026",
  "sheet": "Transactions 07/2026",
  "transactions": [
    {
      "row_index": 7,
      "date": "2026-07-20",
      "amount": 50000,
      "description": "Groceries",
      "category": "Food",
      "type": "expense"
    },
    {
      "row_index": 6,
      "date": "2026-07-18",
      "amount": 30000,
      "description": "Grab ride",
      "category": "Transportation",
      "type": "expense"
    },
    {
      "row_index": 5,
      "date": "2026-07-15",
      "amount": 25000,
      "description": "Lunch at warung",
      "category": "Food",
      "type": "expense"
    }
  ]
}
```

##### Case 2: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 9. Set Planned
Sets the **Planned** amount for a specific category on the `Summary MM/YYYY` sheet. Each category has exactly one planned-amount cell per month.

* **HTTP Method**: `POST`
* **Path**: `/set-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `month` | String | No | Current month | Target month as `"MM/YYYY"` or date string. |
  | `category` | String | **Yes** | | Category name. If the category doesn't exist, it will be automatically registered on the Summary sheet. |
  | `type` | String | No | `"expense"` | `"expense"` or `"income"`. |
  | `planned_amount` | Number \| String | **Yes** | | The budget amount. Must be ≥ 0. |

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "action": "set",
  "category": "Food",
  "type": "expense",
  "planned_amount": 500000,
  "cell": "C24",
  "month": "07/2026",
  "sheet": "Summary 07/2026"
}
```

##### Case 2: Validation Failure — Missing Category or Amount (HTTP 400)
```json
{
  "success": false,
  "error": "Missing category or planned_amount"
}
```

##### Case 3: Validation Failure — Invalid Type (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid type — must be \"income\" or \"expense\""
}
```

##### Case 4: Validation Failure — Invalid Amount (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid planned_amount"
}
```

##### Case 5: Validation Failure — Invalid Category (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid category for expense. (Validation error)"
}
```

##### Case 6: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 10. Edit Planned
Alias endpoint for `set-budget`. Accepts the same request body and returns the same responses.

* **HTTP Method**: `POST`
* **Path**: `/edit-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**: Same as [Set Planned](#9-set-budget)

> [!NOTE]
> Since each category has exactly one planned cell per month, editing a budget is identical to setting it. This endpoint exists for API naming consistency.

---

### 11. Search & Edit Planned
Searches for a budget category by keyword and updates its planned amount.

* **HTTP Method**: `POST`
* **Path**: `/search-edit-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | **Search Fields** | | | |
  | `search_keyword` | String | **Yes** | Case-insensitive substring match on category name. |
  | `search_type` | String | No | `"expense"` or `"income"` to narrow search. If omitted, both expense and income categories are searched. |
  | **Context Fields** | | | |
  | `month` | String | No | Target month. Defaults to current month. |
  | **Update Fields** | | | |
  | `new_planned_amount` | Number \| String | **Yes** | New planned amount. Must be ≥ 0. |

> [!NOTE]
> The search matches against the **category name** (e.g. searching `"food"` matches `"Food"`, searching `"custom"` may match `"Custom category 1"`, `"Custom category 2"`, `"Custom category 3"`, and `"Custom category"` — resulting in ambiguity).

#### Responses

##### Case 1: Exactly One Match — Successful Update (HTTP 200)
```json
{
  "success": true,
  "found": true,
  "ambiguous": false,
  "edited": true,
  "category": "Food",
  "type": "expense",
  "new_planned_amount": 600000,
  "cell": "C24",
  "month": "07/2026",
  "sheet": "Summary 07/2026"
}
```

##### Case 2: Ambiguous Match — Multiple Categories Match (HTTP 200)
No changes are applied. Returns the candidate categories.
```json
{
  "success": true,
  "found": false,
  "ambiguous": true,
  "edited": false,
  "candidates": [
    { "category": "Custom category 1", "type": "expense", "planned_cell": "C35" },
    { "category": "Custom category 2", "type": "expense", "planned_cell": "C36" },
    { "category": "Custom category 3", "type": "expense", "planned_cell": "C37" },
    { "category": "Custom category", "type": "income", "planned_cell": "I29" }
  ]
}
```

##### Case 3: No Match Found (HTTP 200)
```json
{
  "success": true,
  "found": false,
  "ambiguous": false,
  "edited": false,
  "candidates": []
}
```

##### Case 4: Validation Failure — Missing Search Keyword (HTTP 400)
```json
{
  "success": false,
  "error": "search_keyword is required to identify the budget category"
}
```

##### Case 5: Validation Failure — Missing New Amount (HTTP 400)
```json
{
  "success": false,
  "error": "No changes provided — new_planned_amount is required"
}
```

##### Case 6: Validation Failure — Invalid Amount (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid new_planned_amount"
}
```

##### Case 7: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 12. Delete Planned [COMMENTED OUT]

> [!WARNING]
> This endpoint has been commented out in the codebase. It is recommended to use `13. Search & Delete Planned` instead.
Clears the planned amount for a specific category (sets the cell value to `0`).

* **HTTP Method**: `POST`
* **Path**: `/delete-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `month` | String | No | Current month | Target month. |
  | `category` | String | **Yes** | | Category name. If the category doesn't exist, it will be automatically registered on the Summary sheet. |
  | `type` | String | No | `"expense"` | `"expense"` or `"income"`. |

> [!NOTE]
> "Deleting" a budget means setting the planned amount to `0`, not removing the category row (which is part of the fixed template).

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "deleted": true,
  "category": "Food",
  "type": "expense",
  "cell": "C24",
  "month": "07/2026",
  "sheet": "Summary 07/2026"
}
```

##### Case 2: Validation Failure — Missing Category (HTTP 400)
```json
{
  "success": false,
  "error": "Missing category"
}
```

##### Case 3: Validation Failure — Invalid Category (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid category for expense. (Validation error)"
}
```

##### Case 4: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 13. Search & Delete Planned
Searches for a budget category by keyword and clears its planned amount.

* **HTTP Method**: `POST`
* **Path**: `/search-delete-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `search_keyword` | String | **Yes** | Case-insensitive substring match on category name. |
  | `search_type` | String | No | `"expense"` or `"income"`. If omitted, both are searched. |
  | `month` | String | No | Target month. Defaults to current month. |

> [!IMPORTANT]
> At least `search_keyword` must be provided.

#### Responses

##### Case 1: Exactly One Match — Successful Deletion (HTTP 200)
```json
{
  "success": true,
  "found": true,
  "ambiguous": false,
  "deleted": true,
  "category": "Food",
  "type": "expense",
  "cell": "C24",
  "month": "07/2026",
  "sheet": "Summary 07/2026"
}
```

##### Case 2: Ambiguous Match — Multiple Categories Match (HTTP 200)
No deletion is performed.
```json
{
  "success": true,
  "found": false,
  "ambiguous": true,
  "deleted": false,
  "candidates": [
    { "category": "Custom category 1", "type": "expense", "planned_cell": "C35" },
    { "category": "Custom category 2", "type": "expense", "planned_cell": "C36" }
  ]
}
```

##### Case 3: No Match Found (HTTP 200)
```json
{
  "success": true,
  "found": false,
  "ambiguous": false,
  "deleted": false,
  "candidates": []
}
```

##### Case 4: Validation Failure — Missing Search Keyword (HTTP 400)
```json
{
  "success": false,
  "error": "search_keyword is required to identify the budget category"
}
```

##### Case 5: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 14. List Planned
Lists all category budget data (planned, actual, diff) for a given month.

* **HTTP Method**: `POST`
* **Path**: `/list-planned`
* **Headers**: `Content-Type: application/json`
* **Request Body**:
  | Parameter | Type | Required | Default | Description |
  | :--- | :--- | :--- | :--- | :--- |
  | `month` | String | No | Current month | Target month as `"MM/YYYY"` or date string. |
  | `type` | String | No | *(both)* | `"expense"`, `"income"`, or omit for both. |

#### Responses

##### Case 1: Success (HTTP 200)
```json
{
  "success": true,
  "count": 20,
  "month": "07/2026",
  "sheet": "Summary 07/2026",
  "budgets": [
    {
      "category": "Food",
      "type": "expense",
      "planned": 500000,
      "actual": 320000,
      "diff": 180000,
      "planned_cell": "C24"
    },
    {
      "category": "Gifts",
      "type": "expense",
      "planned": 0,
      "actual": 0,
      "diff": 0,
      "planned_cell": "C25"
    },
    {
      "category": "Paycheck",
      "type": "income",
      "planned": 8000000,
      "actual": 8000000,
      "diff": 0,
      "planned_cell": "I25"
    }
  ]
}
```

> [!NOTE]
> The response always includes **all** categories for the requested type(s), including those with zero values. The `actual` and `diff` values are computed by the template's SUMIFS formulas.

##### Case 2: Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```

---

### 15. Report
Multi-purpose analytics endpoint. The `query_type` parameter determines which report is generated.

* **HTTP Method**: `POST`
* **Path**: `/report`
* **Headers**: `Content-Type: application/json`

#### Query Type: `balance`
Returns the month's financial overview from the Summary sheet.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"balance"`. |
| `month` | String | No | Current month | Target month. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "balance",
  "month": "07/2026",
  "starting_balance": 5000000,
  "income_planned": 8000000,
  "income_actual": 8000000,
  "expenses_planned": 3000000,
  "expenses_actual": 2450000,
    "end_balance": 10550000,
  "savings_this_month": 5550000,
  "savings_rate": 0.69375
}
```

> [!NOTE]
> `end_balance` = `starting_balance` + `income_actual` − `expenses_actual`.
> `savings_this_month` = `income_actual` − `expenses_actual`.

---

#### Query Type: `budget_remaining`
Returns the planned vs actual for a specific category.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"budget_remaining"`. |
| `category` | String | **Yes** | | Category name. |
| `type` | String | No | `"expense"` | `"expense"` or `"income"`. |
| `month` | String | No | Current month | Target month. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "budget_remaining",
  "month": "07/2026",
  "category": "Food",
  "type": "expense",
  "planned": 500000,
  "actual": 320000,
  "remaining": 180000,
  "diff": 180000
}
```

**Error — Missing Category** (HTTP 400):
```json
{
  "success": false,
  "error": "Missing category for budget_remaining query"
}
```



---

#### Query Type: `breakdown`
Returns planned, actual, diff, and percentage for every category of the given type.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"breakdown"`. |
| `type` | String | No | `"expense"` | `"expense"` or `"income"`. |
| `month` | String | No | Current month | Target month. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "breakdown",
  "month": "07/2026",
  "type": "expense",
  "total_actual": 2450000,
  "breakdown": [
    {
      "category": "Food",
      "planned": 500000,
      "actual": 320000,
      "diff": 180000,
      "percentage": 13
    },
    {
      "category": "Transportation",
      "planned": 300000,
      "actual": 250000,
      "diff": 50000,
      "percentage": 10
    }
  ]
}
```

> [!NOTE]
> `percentage` is each category's actual as a share of `total_actual`, rounded to the nearest integer.

---

#### Query Type: `period_comparison`
Compares totals between two months.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"period_comparison"`. |
| `current_month` | String | **Yes** | | Current period as `"MM/YYYY"` or date string. |
| `previous_month` | String | **Yes** | | Previous period as `"MM/YYYY"` or date string. |
| `type` | String | No | `"expense"` | `"expense"` or `"income"`. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "period_comparison",
  "type": "expense",
  "current": {
    "month": "07/2026",
    "total": 2450000
  },
  "previous": {
    "month": "06/2026",
    "total": 3120000
  },
  "difference": -670000,
  "change_percentage": -21
}
```

> [!NOTE]
> `change_percentage` = `((current − previous) / previous) × 100`, rounded to integer. Returns `null` if `previous` total is 0.

**Error — Missing Period Parameters** (HTTP 400):
```json
{
  "success": false,
  "error": "Missing current_month or previous_month for period_comparison"
}
```

---

#### Query Type: `plan_calculate`
Checks whether a planned (not-yet-logged) transaction fits within the category's budget or balance, **without** writing anything.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"plan_calculate"`. |
| `category` | String | **Yes** | | Category to check. |
| `amount` | Number \| String | **Yes** | | The hypothetical transaction amount. |
| `type` | String | No | `"expense"` | `"expense"` or `"income"`. |
| `month` | String | No | Current month | Target month. |

**Response — Expense (Checked against Budget)** (HTTP 200):
```json
{
  "success": true,
  "query_type": "plan_calculate",
  "checked_against": "budget",
  "budget": {
    "title": "Food",
    "amount": 500000
  },
  "spent_before": 320000,
  "projected_spent": 370000,
  "remaining_before": 180000,
  "remaining_after": 130000,
  "enough": true
}
```

**Response — Expense (Checked against Overall Balance)** (HTTP 200):
```json
{
  "success": true,
  "query_type": "plan_calculate",
  "checked_against": "balance",
  "current_balance": 5000000,
  "amount": 50000,
  "projected_balance": 4950000,
  "enough": true
}
```

**Response — Income** (HTTP 200):
```json
{
  "success": true,
  "query_type": "plan_calculate",
  "checked_against": "none",
  "type": "income",
  "amount": 50000,
  "enough": true
}
```

> [!NOTE]
> This endpoint evaluates whether the expense is affordable based on its assigned budget limit. If the budget is zero, it falls back to checking against the overall available balance instead.

**Error — Missing Fields** (HTTP 400):
```json
{
  "success": false,
  "error_code": "missing_fields",
  "error": "Missing category or amount for plan_calculate query"
}
```

**Error — Invalid Amount** (HTTP 400):
```json
{
  "success": false,
  "error_code": "invalid_amount",
  "error": "Invalid amount"
}
```

---

#### Query Type: `trend`
Returns the total income and expenses over a sequence of months.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"trend"`. |
| `month` | String | No | Current month | The ending month. |
| `count` | Number | No | `6` | Number of months to go backwards. |
| `months` | Array | No | | Optional explicit list of months. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "trend",
  "months": ["05/2026", "06/2026", "07/2026"],
  "trend": [
    {
      "month": "05/2026",
      "income_actual": 8000000,
      "expenses_actual": 2000000
    },
    {
      "month": "06/2026",
      "income_actual": 8000000,
      "expenses_actual": 3120000
    },
    {
      "month": "07/2026",
      "income_actual": 8000000,
      "expenses_actual": 2450000
    }
  ]
}
```

---

#### Query Type: `category_share`
Shows the percentage breakdown of spending over multiple months, either for all categories or filtered by one.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"category_share"`. |
| `month` | String | No | Current month | The ending month. |
| `count` | Number | No | `6` | Number of months to go backwards. |
| `months` | Array | No | | Optional explicit list of months. |
| `type` | String | No | `"expense"` | `"expense"` or `"income"`. |
| `category` | String | No | | Filter by a specific category. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "category_share",
  "type": "expense",
  "months": ["06/2026", "07/2026"],
  "share": [
    {
      "month": "06/2026",
      "category": "Food",
      "actual": 300000,
      "total_actual": 3120000,
      "percentage": 10
    },
    {
      "month": "07/2026",
      "category": "Food",
      "actual": 320000,
      "total_actual": 2450000,
      "percentage": 13
    }
  ]
}
```

---

#### Query Type: `top_transactions`
Fetches the largest transactions for a given month.

**Request Body**:
| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query_type` | String | **Yes** | | Must be `"top_transactions"`. |
| `month` | String | No | Current month | Target month. |
| `type` | String | No | `"expense"` | `"expense"`, `"income"`, or `"all"`. |
| `limit` | Number | No | `5` | Maximum number of transactions to return. |

**Response** (HTTP 200):
```json
{
  "success": true,
  "query_type": "top_transactions",
  "month": "07/2026",
  "type": "expense",
  "limit": 2,
  "transactions": [
    {
      "row_index": 7,
      "date": "2026-07-20",
      "amount": 50000,
      "description": "Groceries",
      "category": "Food",
      "type": "expense"
    },
    {
      "row_index": 6,
      "date": "2026-07-18",
      "amount": 30000,
      "description": "Grab ride",
      "category": "Transportation",
      "type": "expense"
    }
  ]
}
```

---


#### Report — General Errors

##### Invalid or Missing `query_type` (HTTP 400)
```json
{
  "success": false,
  "error": "Missing or invalid query_type. Must be one of: balance, budget_remaining, breakdown, period_comparison, plan_calculate, trend, category_share, top_transactions"
}
```

##### Google API or Runtime Error (HTTP 500)
```json
{
  "success": false,
  "error": "Detailed error message"
}
```
