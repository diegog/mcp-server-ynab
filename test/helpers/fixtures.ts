/**
 * One plan's worth of YNAB records, shaped **as the SDK hands them over** rather
 * than as they arrive on the wire. The fake sits at the client-module boundary,
 * which is downstream of the SDK's `FromJSON` mappers, and those turn a null
 * into `undefined` for every optional field. So an absent value is written here
 * as an absent key; a literal `null` would be a shape no tool can ever see, and
 * would fail an output schema that types the field as optional-not-nullable.
 *
 * Small on purpose: enough for a tool to have something to map, few enough that
 * an assertion can name every row.
 */

export const PLAN_ID = "plan-1";

export const account = {
  id: "account-1",
  name: "Chase Checking",
  type: "checking",
  on_budget: true,
  closed: false,
  balance: 125_000,
  balance_formatted: "$125.00",
  cleared_balance: 125_000,
  cleared_balance_formatted: "$125.00",
  uncleared_balance: 0,
  uncleared_balance_formatted: "$0.00",
  transfer_payee_id: "payee-transfer-1",
  direct_import_linked: false,
  direct_import_in_error: false,
  deleted: false,
};

export const category = {
  id: "category-1",
  category_group_id: "group-1",
  category_group_name: "Immediate Obligations",
  name: "Groceries",
  hidden: false,
  internal: false,
  budgeted: 40_000,
  budgeted_formatted: "$40.00",
  activity: -15_500,
  activity_formatted: "-$15.50",
  balance: 24_500,
  balance_formatted: "$24.50",
  deleted: false,
};

export const categoryGroup = {
  id: "group-1",
  name: "Immediate Obligations",
  hidden: false,
  deleted: false,
  categories: [category],
};

export const transaction = {
  id: "transaction-1",
  date: "2026-08-14",
  amount: -15_500,
  amount_formatted: "-$15.50",
  memo: "weekly shop",
  cleared: "cleared",
  approved: true,
  account_id: account.id,
  account_name: account.name,
  payee_id: "payee-1",
  payee_name: "Local Market",
  category_id: category.id,
  category_name: category.name,
  deleted: false,
  subtransactions: [],
};

export const payee = {
  id: "payee-1",
  name: "Local Market",
  deleted: false,
};

export const month = {
  month: "2026-08-01",
  income: 500_000,
  income_formatted: "$500.00",
  budgeted: 400_000,
  budgeted_formatted: "$400.00",
  activity: -15_500,
  activity_formatted: "-$15.50",
  to_be_budgeted: 100_000,
  to_be_budgeted_formatted: "$100.00",
  age_of_money: 30,
  deleted: false,
  categories: [category],
};

export const scheduledTransaction = {
  id: "scheduled-1",
  date_first: "2026-09-01",
  date_next: "2026-09-01",
  frequency: "monthly",
  amount: -120_000,
  amount_formatted: "-$120.00",
  memo: "rent",
  account_id: account.id,
  account_name: account.name,
  payee_id: "payee-2",
  payee_name: "Landlord",
  category_id: category.id,
  category_name: category.name,
  deleted: false,
  subtransactions: [],
};
