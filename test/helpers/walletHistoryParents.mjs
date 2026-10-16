// Parent tables referenced by module particulars in the history read query.
export const walletHistoryParentsSql = `
  CREATE TABLE IF NOT EXISTS farmers(id integer PRIMARY KEY,site_id integer,name text);
  CREATE TABLE IF NOT EXISTS firms(id integer PRIMARY KEY,site_id integer,name text);
  CREATE TABLE IF NOT EXISTS cash_flow_months(id integer PRIMARY KEY,site_id integer,ledger_name text,ledger_type text);
  CREATE TABLE IF NOT EXISTS vendor_commitments(id integer PRIMARY KEY,site_id integer,vendor_name text,work_title text);
  CREATE TABLE IF NOT EXISTS vendor_inventory_orders(id integer PRIMARY KEY,site_id integer,vendor_name text,item_name text,item_category text);
  CREATE TABLE IF NOT EXISTS land_deals(id integer PRIMARY KEY,site_id integer,buyer_name text,deal_no text);
  CREATE TABLE IF NOT EXISTS plot_commissions_v2(id integer PRIMARY KEY,site_id integer,agent_id integer,plot_id integer);
  CREATE TABLE IF NOT EXISTS misc_income_categories(id integer PRIMARY KEY,name text);
`;
