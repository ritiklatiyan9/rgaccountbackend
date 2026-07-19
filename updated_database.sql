-- ============================================================================
-- RGAccount — Real Estate Accountancy SaaS
-- CONSOLIDATED PostgreSQL Schema (database.sql + all migrations 001–058)
-- ============================================================================
--
-- Purpose:
--   Single, dependency-ordered, idempotent setup script for spinning up a
--   brand-new client database from scratch. Running this on an empty
--   PostgreSQL database produces the full current schema — every table,
--   column, index, function, trigger and seed row that the running
--   application expects.
--
-- How it was built:
--   This file folds the base database.sql together with every JS migration
--   under src/migrations/ (001..058) plus the standalone excel_files / S3
--   migrations. All ALTER-added columns and constraints have been merged
--   directly into their CREATE TABLE definitions. The cash-flow sync trigger
--   function reflects its FINAL version (migration 041).
--
-- Conventions:
--   * Everything uses IF NOT EXISTS / CREATE OR REPLACE so it is safe to
--     re-run. Triggers are guarded with DROP TRIGGER IF EXISTS first.
--   * Tables are ordered by foreign-key dependency.
--   * No DROP TABLE statements — this script never destroys data.
--
-- Usage:
--   psql "<connection-string>" -f updated_database.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. SHARED FUNCTIONS
-- ============================================================================

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. USERS  (login accounts: super_admin / admin / sub_admin)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password        VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  photo           VARCHAR(500),
  role            VARCHAR(20) NOT NULL DEFAULT 'sub_admin'
                    CHECK (role IN ('super_admin', 'admin', 'sub_admin')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active       BOOLEAN DEFAULT TRUE,
  refresh_token   VARCHAR(500),
  token_version   INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role       ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 2. SITES  (real-estate projects / properties)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sites (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(50) UNIQUE,
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(100),
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'completed')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sites_status     ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_created_by ON sites(created_by);

DROP TRIGGER IF EXISTS trg_sites_updated_at ON sites;
CREATE TRIGGER trg_sites_updated_at
  BEFORE UPDATE ON sites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 3. MEMBERS  (clients / farmers / brokers / vendors / employees — NOT logins)
-- ============================================================================
CREATE TABLE IF NOT EXISTS members (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  member_type     VARCHAR(30) NOT NULL DEFAULT 'CLIENT'
                    CHECK (member_type IN ('CLIENT','FARMER','MEMBER','BROKER','PARTNER','VENDOR','EMPLOYEE','OTHER')),
  -- Personal
  full_name       VARCHAR(255) NOT NULL,
  father_name     VARCHAR(255),
  photo           VARCHAR(500),
  gender          VARCHAR(10) CHECK (gender IN ('MALE','FEMALE','OTHER')),
  date_of_birth   DATE,
  blood_group     VARCHAR(5),
  mother_name     VARCHAR(255),
  spouse_name     VARCHAR(255),
  nationality     VARCHAR(50) DEFAULT 'INDIAN',
  religion        VARCHAR(50),
  caste           VARCHAR(100),
  marital_status  VARCHAR(20),
  anniversary_date DATE,
  qualification   VARCHAR(100),
  -- Contact
  phone           VARCHAR(20),
  alt_phone       VARCHAR(20),
  email           VARCHAR(255),
  whatsapp        VARCHAR(20),
  -- Address
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(100),
  pincode         VARCHAR(10),
  -- Identity
  aadhar_no       VARCHAR(20),
  pan_no          VARCHAR(15),
  voter_id        VARCHAR(30),
  passport_no     VARCHAR(20),
  driving_license_no VARCHAR(30),
  gst_no          VARCHAR(20),
  tin_no          VARCHAR(20),
  -- Bank
  bank_name       VARCHAR(100),
  account_no      VARCHAR(30),
  ifsc_code       VARCHAR(15),
  branch          VARCHAR(100),
  -- Emergency Contact
  emergency_contact_name  VARCHAR(255),
  emergency_contact_phone VARCHAR(20),
  emergency_contact_relation VARCHAR(50),
  -- Nominee
  nominee_name    VARCHAR(255),
  nominee_relation VARCHAR(50),
  nominee_phone   VARCHAR(20),
  -- Employee-specific
  employee_id     VARCHAR(50),
  designation     VARCHAR(100),
  department      VARCHAR(100),
  date_of_joining DATE,
  salary          NUMERIC(15,2),
  employment_type VARCHAR(30),
  -- Employee Document URLs (Cloudinary)
  resume_url      VARCHAR(500),
  marksheet_10th_url VARCHAR(500),
  marksheet_12th_url VARCHAR(500),
  degree_certificate_url VARCHAR(500),
  experience_certificate_url VARCHAR(500),
  offer_letter_url VARCHAR(500),
  other_certificate_url VARCHAR(500),
  -- KYC Document Photo URLs (Cloudinary)
  aadhar_front_url VARCHAR(500),
  aadhar_back_url VARCHAR(500),
  pan_card_url    VARCHAR(500),
  voter_id_url    VARCHAR(500),
  passport_url    VARCHAR(500),
  driving_license_url VARCHAR(500),
  cheque_url      VARCHAR(500),
  other_kyc_url   VARCHAR(500),
  -- Extra
  occupation      VARCHAR(100),
  company_name    VARCHAR(255),
  reference       VARCHAR(255),
  notes           TEXT,
  team            VARCHAR(50),
  -- Type-specific fields (migration 003)
  land_area       VARCHAR(100),
  crop_type       VARCHAR(200),
  farm_location   VARCHAR(200),
  irrigation_type VARCHAR(100),
  farming_experience VARCHAR(50),
  license_number  VARCHAR(100),
  commission_rate VARCHAR(50),
  operating_areas TEXT,
  business_name   VARCHAR(200),
  service_type    VARCHAR(200),
  payment_terms   VARCHAR(200),
  status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','INACTIVE','BLOCKED')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_site ON members(site_id);
CREATE INDEX IF NOT EXISTS idx_members_type ON members(member_type);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(site_id, full_name);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
CREATE INDEX IF NOT EXISTS idx_members_site_phone_lookup     ON members(site_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_site_type_status      ON members(site_id, member_type, status);
CREATE INDEX IF NOT EXISTS idx_members_site_status           ON members(site_id, status);
CREATE INDEX IF NOT EXISTS idx_members_site_created_at       ON members(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_site_full_name_upper  ON members(site_id, UPPER(full_name));

DROP TRIGGER IF EXISTS trg_members_updated_at ON members;
CREATE TRIGGER trg_members_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 4. USER ACCESS / PERMISSIONS / SESSIONS
-- ============================================================================

-- Which sub-admins can access which sites (admins implicitly access all)
CREATE TABLE IF NOT EXISTS user_sites (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assigned_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_user_sites_user ON user_sites(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sites_site ON user_sites(site_id);

-- Per-module CRUD permissions (migration 002)
CREATE TABLE IF NOT EXISTS user_permissions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      VARCHAR(50) NOT NULL,
  can_read    BOOLEAN DEFAULT true,
  can_write   BOOLEAN DEFAULT true,
  can_update  BOOLEAN DEFAULT true,
  can_delete  BOOLEAN DEFAULT false,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, module)
);

-- Which approval modules each sub-admin can access (migration 042)
CREATE TABLE IF NOT EXISTS user_approval_modules (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      VARCHAR(50) NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, module)
);

-- Login session tracking (migration 006)
CREATE TABLE IF NOT EXISTS user_sessions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  login_time  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  logout_time TIMESTAMP WITH TIME ZONE,
  ip_address  VARCHAR(45)
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);

-- Per-user dashboard component visibility (migration 045)
CREATE TABLE IF NOT EXISTS dashboard_component_permissions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  component   VARCHAR(60) NOT NULL,
  allowed     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, component)
);
CREATE INDEX IF NOT EXISTS idx_dcp_user_id ON dashboard_component_permissions(user_id);

-- ============================================================================
-- 5. LOOKUP / CATEGORY TABLES
-- ============================================================================

-- Member categories (migration 003) + predefined seed rows
CREATE TABLE IF NOT EXISTS member_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  description   TEXT,
  is_predefined BOOLEAN DEFAULT false,
  icon          VARCHAR(50),
  color         VARCHAR(50),
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_categories_slug ON member_categories(slug);

INSERT INTO member_categories (name, slug, description, is_predefined, icon, color) VALUES
  ('Client',   'CLIENT',   'Clients who purchase plots or properties', true, 'UserCheck',  'blue'),
  ('Farmer',   'FARMER',   'Farmers who sell land',                    true, 'Tractor',    'emerald'),
  ('Member',   'MEMBER',   'General registered members',               true, 'Users',      'purple'),
  ('Broker',   'BROKER',   'Real estate brokers and agents',           true, 'Handshake',  'amber'),
  ('Partner',  'PARTNER',  'Business partners',                        true, 'Users',      'cyan'),
  ('Vendor',   'VENDOR',   'Vendors and service providers',            true, 'Store',      'orange'),
  ('Employee', 'EMPLOYEE', 'Company employees and staff',              true, 'UserCog',    'indigo'),
  ('Other',    'OTHER',    'Other category',                           true, 'HelpCircle', 'slate')
ON CONFLICT (slug) DO NOTHING;

-- Expense categories (migration 004)
CREATE TABLE IF NOT EXISTS expense_categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  icon        VARCHAR(50) DEFAULT 'Tag',
  color       VARCHAR(30) DEFAULT 'slate',
  grp         VARCHAR(80) DEFAULT 'Custom',
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 6. FILE MANAGER  (folders + uploaded files, migration 007 + S3 migration)
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_folders (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  parent_id   INTEGER REFERENCES file_folders(id) ON DELETE CASCADE,
  site_id     INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_file_folders_parent     ON file_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_file_folders_created_by ON file_folders(created_by);
CREATE INDEX IF NOT EXISTS idx_file_folders_site       ON file_folders(site_id);

DROP TRIGGER IF EXISTS trg_file_folders_updated_at ON file_folders;
CREATE TRIGGER trg_file_folders_updated_at
  BEFORE UPDATE ON file_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- excel_files: spreadsheets / docs / pdfs stored on S3
CREATE TABLE IF NOT EXISTS excel_files (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL DEFAULT 'Untitled Spreadsheet',
  s3_key      VARCHAR(255),
  size_bytes  INTEGER,
  file_type   VARCHAR(20) DEFAULT 'excel',
  folder_id   INTEGER REFERENCES file_folders(id) ON DELETE SET NULL,
  site_id     INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_excel_files_created_by ON excel_files(created_by);
CREATE INDEX IF NOT EXISTS idx_excel_files_updated_at ON excel_files(updated_at);
CREATE INDEX IF NOT EXISTS idx_excel_files_folder     ON excel_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_excel_files_site       ON excel_files(site_id);

DROP TRIGGER IF EXISTS trg_excel_files_updated_at ON excel_files;
CREATE TRIGGER trg_excel_files_updated_at
  BEFORE UPDATE ON excel_files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 7. FARMERS  (land owners who receive payments)
-- ============================================================================
CREATE TABLE IF NOT EXISTS farmers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  address         TEXT,
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  interest_rate   NUMERIC(5,2) NOT NULL DEFAULT 0,
  site_id         INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'inactive')),
  member_id       INTEGER REFERENCES members(id) ON DELETE SET NULL,
  -- Land / commission fields (migration 046)
  land_size_bigha       NUMERIC(10,2),
  land_rate             NUMERIC(15,2),
  commission_percentage NUMERIC(5,2),
  commission_amount     NUMERIC(15,2),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farmers_site            ON farmers(site_id);
CREATE INDEX IF NOT EXISTS idx_farmers_status          ON farmers(status);
CREATE INDEX IF NOT EXISTS idx_farmers_created         ON farmers(created_by);
CREATE INDEX IF NOT EXISTS idx_farmers_site_status     ON farmers(site_id, status);
CREATE INDEX IF NOT EXISTS idx_farmers_site_created_at ON farmers(site_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_farmers_updated_at ON farmers;
CREATE TRIGGER trg_farmers_updated_at
  BEFORE UPDATE ON farmers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- FARMER PAYMENTS (installments paid to farmers)
CREATE TABLE IF NOT EXISTS farmer_payments (
  id              SERIAL PRIMARY KEY,
  farmer_id       INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(255) NOT NULL,
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  by_note         VARCHAR(500),
  interest_rate   NUMERIC(5,2) DEFAULT 0,
  interest_amount NUMERIC(15,2) DEFAULT 0,
  remarks         TEXT,
  payment_mode    VARCHAR(20) DEFAULT 'CASH',        -- CASH, BANK, CHEQUE, SPLIT
  cash_amount     NUMERIC(15,2) DEFAULT 0,
  bank_amount     NUMERIC(15,2) DEFAULT 0,
  bank_name       VARCHAR(255),
  bank_account_no VARCHAR(100),
  bank_reference  VARCHAR(255),
  bank_ifsc       VARCHAR(20),
  -- Approval workflow (migration 009)
  voucher_url     VARCHAR(1000),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  -- Assigned-admin workflow (migration 020)
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Cheque tracking (migration 031)
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer      ON farmer_payments(farmer_id);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_date        ON farmer_payments(date);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_status      ON farmer_payments(status);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_site_date   ON farmer_payments(farmer_id, date);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_farmer_date ON farmer_payments(farmer_id, date);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_assigned_admin_id ON farmer_payments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_farmer_payments_active      ON farmer_payments(farmer_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_fp_active_for_unified       ON farmer_payments(farmer_id, date DESC)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')) AND status != 'rejected';

DROP TRIGGER IF EXISTS trg_farmer_payments_updated_at ON farmer_payments;
CREATE TRIGGER trg_farmer_payments_updated_at
  BEFORE UPDATE ON farmer_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 8. PLOTS  (plot sales / bookings per site)
-- ============================================================================
CREATE TABLE IF NOT EXISTS plots (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_no         VARCHAR(20) NOT NULL,
  block           VARCHAR(10),
  buyer_name      VARCHAR(255),
  plot_size       NUMERIC(10,2),
  plot_size_mtr   NUMERIC(10,2),
  plot_rate       NUMERIC(15,2),
  sale_price      NUMERIC(15,2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(15,2) DEFAULT 0,
  plot_commission NUMERIC(15,2) DEFAULT 0,
  original_plot_rate NUMERIC(15,2) DEFAULT 0,
  discount_rate   NUMERIC(15,2) DEFAULT 0,
  registry_area   NUMERIC(10,2) DEFAULT 0,
  circle_rate     NUMERIC(15,2) DEFAULT 0,
  to_receive_bank NUMERIC(15,2) DEFAULT 0,
  first_installment NUMERIC(15,2) DEFAULT 0,
  booking_by      VARCHAR(255),
  booking_date    DATE,
  status          VARCHAR(50) DEFAULT 'BOOKED',
  plot_tag        VARCHAR(20),
  notes           TEXT,
  -- Installments & interest (migration 010)
  installments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interest_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  interest_rate        NUMERIC(8,4) DEFAULT 0,
  interest_type        VARCHAR(20) DEFAULT 'per_month'
                         CHECK (interest_type IN ('per_day', 'per_month', 'per_quarter', 'per_year')),
  -- Grace period (migration 026)
  grace_period_days    INTEGER NOT NULL DEFAULT 15 CHECK (grace_period_days >= 0),
  -- Commission config (migration 027)
  commission_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  commission_type      VARCHAR(20) NOT NULL DEFAULT 'PERCENTAGE'
                         CHECK (commission_type IN ('PERCENTAGE', 'FIXED')),
  commission_value     NUMERIC(15,2) NOT NULL DEFAULT 0,
  -- Penalty config (migration 033)
  penalty_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  penalty_rate         NUMERIC(10,4) DEFAULT 0,
  penalty_type         VARCHAR(20) DEFAULT 'per_day',
  free_to_sale_days    INTEGER DEFAULT 0,
  -- PLC / team (add_plot_plc_team)
  plc_charges          NUMERIC(15,2) DEFAULT 0,
  team                 VARCHAR(10),
  -- Assigned-admin workflow (migration 022)
  assigned_admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plots_site                ON plots(site_id);
CREATE INDEX IF NOT EXISTS idx_plots_status              ON plots(status);
CREATE INDEX IF NOT EXISTS idx_plots_plot_no             ON plots(plot_no);
CREATE INDEX IF NOT EXISTS idx_plots_assigned_admin_id   ON plots(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_plots_site_plot_no_upper  ON plots(site_id, UPPER(plot_no));
CREATE INDEX IF NOT EXISTS idx_plots_site_status         ON plots(site_id, status);
CREATE INDEX IF NOT EXISTS idx_plots_fts_candidates      ON plots(site_id)
  WHERE installments_enabled = TRUE AND free_to_sale_days > 0
    AND status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY');

DROP TRIGGER IF EXISTS trg_plots_updated_at ON plots;
CREATE TRIGGER trg_plots_updated_at
  BEFORE UPDATE ON plots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- PLOT INSTALLMENTS schedule (migration 010)
CREATE TABLE IF NOT EXISTS plot_installments (
  id                SERIAL PRIMARY KEY,
  plot_id           INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  installment_name  VARCHAR(255),
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
  due_date          DATE NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'partially_paid', 'paid', 'overdue')),
  paid_amount       NUMERIC(15,2) NOT NULL DEFAULT 0,
  interest_amount   NUMERIC(15,2) NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pi_plot     ON plot_installments(plot_id);
CREATE INDEX IF NOT EXISTS idx_pi_status   ON plot_installments(status);
CREATE INDEX IF NOT EXISTS idx_pi_due_date ON plot_installments(due_date);
CREATE INDEX IF NOT EXISTS idx_plot_installments_plot ON plot_installments(plot_id, sort_order, due_date);

DROP TRIGGER IF EXISTS trg_plot_installments_updated_at ON plot_installments;
CREATE TRIGGER trg_plot_installments_updated_at
  BEFORE UPDATE ON plot_installments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- PLOT INSTALLMENT PAYMENTS (migration 010 + cheque fields migration 039)
CREATE TABLE IF NOT EXISTS plot_installment_payments (
  id                SERIAL PRIMARY KEY,
  installment_id    INTEGER NOT NULL REFERENCES plot_installments(id) ON DELETE CASCADE,
  plot_id           INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_mode      VARCHAR(50),
  reference         VARCHAR(255),
  notes             TEXT,
  cheque_status     VARCHAR(20),
  cheque_no         VARCHAR(50),
  -- assigned_admin_id is required by the sync_cashflow_from_modules() trigger,
  -- which writes NEW.assigned_admin_id into cash_flow_entries for every source row.
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pip_installment ON plot_installment_payments(installment_id);
CREATE INDEX IF NOT EXISTS idx_pip_plot        ON plot_installment_payments(plot_id);

-- PLOT CIRCLE RATE HISTORY (migration 028)
CREATE TABLE IF NOT EXISTS plot_circle_rate_history (
  id                   SERIAL PRIMARY KEY,
  plot_id              INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  previous_circle_rate NUMERIC(15,2) NOT NULL DEFAULT 0,
  new_circle_rate      NUMERIC(15,2) NOT NULL DEFAULT 0,
  changed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pcrh_plot_id    ON plot_circle_rate_history(plot_id);
CREATE INDEX IF NOT EXISTS idx_pcrh_changed_at ON plot_circle_rate_history(changed_at DESC);

-- ============================================================================
-- 9. PLOT COMMISSIONS
-- ============================================================================

-- Legacy / simple commission ledger (base schema)
CREATE TABLE IF NOT EXISTS plot_commissions (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(255) NOT NULL,
  father_name     VARCHAR(255),
  plot_no         VARCHAR(50),
  plot_size       VARCHAR(50),
  plot_rate       VARCHAR(50),
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  by_note         VARCHAR(500),
  remarks         TEXT,
  voucher_url     VARCHAR(1000),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_site      ON plot_commissions(site_id);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_date      ON plot_commissions(date);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_plot      ON plot_commissions(plot_no);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_status    ON plot_commissions(status);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_site_date ON plot_commissions(site_id, date);
CREATE INDEX IF NOT EXISTS idx_plot_commissions_assigned_admin_id ON plot_commissions(assigned_admin_id);

DROP TRIGGER IF EXISTS trg_plot_commissions_updated_at ON plot_commissions;
CREATE TRIGGER trg_plot_commissions_updated_at
  BEFORE UPDATE ON plot_commissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Agent commission master (migration 013)
CREATE TABLE IF NOT EXISTS plot_commissions_v2 (
  id               SERIAL PRIMARY KEY,
  site_id          INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  plot_id          INTEGER REFERENCES plots(id) ON DELETE RESTRICT,
  agent_id         INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  total_commission DECIMAL(12, 2) NOT NULL DEFAULT 0,
  remarks          TEXT,
  status           VARCHAR(20) DEFAULT 'Pending',
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pcv2_site_id         ON plot_commissions_v2(site_id);
CREATE INDEX IF NOT EXISTS idx_pcv2_plot_id         ON plot_commissions_v2(plot_id);
CREATE INDEX IF NOT EXISTS idx_pcv2_agent_id        ON plot_commissions_v2(agent_id);
CREATE INDEX IF NOT EXISTS idx_pcv2_plot_site       ON plot_commissions_v2(plot_id, site_id);
CREATE INDEX IF NOT EXISTS idx_pcv2_site_created_at ON plot_commissions_v2(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcv2_plot_agent      ON plot_commissions_v2(plot_id, agent_id);

-- Agent commission payments (migration 013 + 020 + 031)
CREATE TABLE IF NOT EXISTS plot_commission_payments (
  id                    SERIAL PRIMARY KEY,
  site_id               INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  plot_commission_id    INTEGER REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,
  date                  DATE NOT NULL DEFAULT CURRENT_DATE,
  amount                DECIMAL(12, 2) NOT NULL DEFAULT 0,
  balance_after_payment DECIMAL(12, 2) NOT NULL DEFAULT 0,
  payment_mode          VARCHAR(20) DEFAULT 'CASH',
  bank_name             VARCHAR(100),
  transaction_id        VARCHAR(100),
  remarks               TEXT,
  status                VARCHAR(20) DEFAULT 'pending',
  voucher_number        VARCHAR(50) UNIQUE,
  voucher_url           TEXT,
  assigned_admin_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status         VARCHAR(20),
  cheque_no             VARCHAR(50),
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMP,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pcp_site_id       ON plot_commission_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_pcp_master_id     ON plot_commission_payments(plot_commission_id);
CREATE INDEX IF NOT EXISTS idx_pcp_status        ON plot_commission_payments(status);
CREATE INDEX IF NOT EXISTS idx_pcp_master_status ON plot_commission_payments(plot_commission_id, status);
CREATE INDEX IF NOT EXISTS idx_pcp_master_date   ON plot_commission_payments(plot_commission_id, date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcp_assigned_admin_id ON plot_commission_payments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_pcp_active_approved ON plot_commission_payments(plot_commission_id)
  WHERE status = 'approved' AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'));
CREATE INDEX IF NOT EXISTS idx_pcp_active_for_unified ON plot_commission_payments(site_id, date DESC)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')) AND status != 'rejected';

-- ============================================================================
-- 10. FIRMS  (bank accounts / entities per site)
-- ============================================================================
CREATE TABLE IF NOT EXISTS firms (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  account_number  VARCHAR(50),
  bank_name       VARCHAR(255),
  ifsc_code       VARCHAR(20),
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, name)
);
CREATE INDEX IF NOT EXISTS idx_firms_site            ON firms(site_id);
CREATE INDEX IF NOT EXISTS idx_firms_site_name_upper ON firms(site_id, UPPER(name));

DROP TRIGGER IF EXISTS trg_firms_updated_at ON firms;
CREATE TRIGGER trg_firms_updated_at
  BEFORE UPDATE ON firms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 11. CASH FLOW  (monthly periods + debit/credit entries — the central ledger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cash_flow_months (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year            INTEGER NOT NULL,
  ledger_name     VARCHAR(255) NOT NULL DEFAULT '',
  ledger_type     VARCHAR(20) NOT NULL DEFAULT 'site',
  linked_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  linked_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  is_locked       BOOLEAN DEFAULT FALSE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, month, year, ledger_name)
);
CREATE INDEX IF NOT EXISTS idx_cfm_site   ON cash_flow_months(site_id);
CREATE INDEX IF NOT EXISTS idx_cfm_period ON cash_flow_months(year, month);
CREATE INDEX IF NOT EXISTS idx_cfm_linked_user_id ON cash_flow_months(linked_user_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfm_linked_member_id ON cash_flow_months(linked_member_id)
  WHERE linked_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cfm_site_ledger_period
  ON cash_flow_months(site_id, ledger_name, year DESC, month DESC);

DROP TRIGGER IF EXISTS trg_cash_flow_months_updated_at ON cash_flow_months;
CREATE TRIGGER trg_cash_flow_months_updated_at
  BEFORE UPDATE ON cash_flow_months
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS cash_flow_entries (
  id                  SERIAL PRIMARY KEY,
  cash_flow_month_id  INTEGER NOT NULL REFERENCES cash_flow_months(id) ON DELETE CASCADE,
  site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  particular          VARCHAR(500) NOT NULL,
  debit               NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit              NUMERIC(15,2) NOT NULL DEFAULT 0,
  cash_type           VARCHAR(20) NOT NULL DEFAULT 'bank'
                        CHECK (cash_type IN ('cash', 'bank', 'cheque')),
  is_firm_transaction BOOLEAN NOT NULL DEFAULT FALSE,
  from_firm_id        INTEGER REFERENCES firms(id) ON DELETE SET NULL,
  to_firm_id          INTEGER REFERENCES firms(id) ON DELETE SET NULL,
  to_name             VARCHAR(255),
  source_module       VARCHAR(50),
  source_id           INTEGER,
  remarks             TEXT,
  -- Approval workflow (migration 009)
  voucher_url         VARCHAR(1000),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  -- Assigned-admin workflow (migration 020)
  assigned_admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Cheque tracking (migration 031)
  cheque_status       VARCHAR(20),
  cheque_no           VARCHAR(50),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cfe_month ON cash_flow_entries(cash_flow_month_id);
CREATE INDEX IF NOT EXISTS idx_cfe_site  ON cash_flow_entries(site_id);
CREATE INDEX IF NOT EXISTS idx_cfe_date  ON cash_flow_entries(date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cfe_source_module_source_id ON cash_flow_entries(source_module, source_id);
CREATE INDEX IF NOT EXISTS idx_cfe_from_firm_id        ON cash_flow_entries(from_firm_id);
CREATE INDEX IF NOT EXISTS idx_cfe_to_firm_id          ON cash_flow_entries(to_firm_id);
CREATE INDEX IF NOT EXISTS idx_cfe_is_firm_transaction ON cash_flow_entries(is_firm_transaction);
CREATE INDEX IF NOT EXISTS idx_cfe_status              ON cash_flow_entries(status);
CREATE INDEX IF NOT EXISTS idx_cfe_assigned_admin_id   ON cash_flow_entries(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_cf_entries_site_date    ON cash_flow_entries(site_id, date);
CREATE INDEX IF NOT EXISTS idx_cfe_month_cash_type     ON cash_flow_entries(cash_flow_month_id, cash_type);
CREATE INDEX IF NOT EXISTS idx_cfe_month_date          ON cash_flow_entries(cash_flow_month_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_cfe_site_particular     ON cash_flow_entries(site_id, particular);
CREATE INDEX IF NOT EXISTS idx_cfe_active_month
  ON cash_flow_entries(cash_flow_month_id)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND (status IS NULL OR status != 'rejected');
CREATE INDEX IF NOT EXISTS idx_cfe_firm_active ON cash_flow_entries(from_firm_id, to_firm_id)
  WHERE is_firm_transaction = TRUE
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND (status IS NULL OR status != 'rejected');
CREATE INDEX IF NOT EXISTS idx_cfe_unified_debit ON cash_flow_entries(site_id, date DESC)
  WHERE debit > 0
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND (status IS NULL OR status != 'rejected');

DROP TRIGGER IF EXISTS trg_cash_flow_entries_updated_at ON cash_flow_entries;
CREATE TRIGGER trg_cash_flow_entries_updated_at
  BEFORE UPDATE ON cash_flow_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 12. FIRM TRANSACTIONS  (bank statement rows; can be firm-to-firm transfers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS firm_transactions (
  id              SERIAL PRIMARY KEY,
  firm_id         INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  description     TEXT NOT NULL,
  payment_mode    VARCHAR(20) NOT NULL DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash', 'bank', 'cheque')),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  name            VARCHAR(255),
  purpose         VARCHAR(500),
  remark          VARCHAR(100),
  remark2         VARCHAR(255),
  cheque_no       VARCHAR(50),
  cheque_status   VARCHAR(20),
  cash_flow_entry_id INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL,
  -- Firm-to-firm transfer linkage (migration 021)
  is_firm_to_firm_transfer BOOLEAN NOT NULL DEFAULT false,
  transfer_to_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  transfer_to_firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
  transfer_group_id   VARCHAR(80),
  transfer_direction  VARCHAR(10) CHECK (transfer_direction IS NULL OR transfer_direction IN ('OUT', 'IN')),
  -- Approval workflow (migration 009)
  voucher_url     VARCHAR(1000),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ft_firm         ON firm_transactions(firm_id);
CREATE INDEX IF NOT EXISTS idx_ft_site         ON firm_transactions(site_id);
CREATE INDEX IF NOT EXISTS idx_ft_date         ON firm_transactions(date);
CREATE INDEX IF NOT EXISTS idx_ft_remark       ON firm_transactions(remark);
CREATE INDEX IF NOT EXISTS idx_ft_payment_mode ON firm_transactions(payment_mode);
CREATE INDEX IF NOT EXISTS idx_ft_status       ON firm_transactions(status);
CREATE INDEX IF NOT EXISTS idx_ft_cash_flow_entry_id      ON firm_transactions(cash_flow_entry_id);
CREATE INDEX IF NOT EXISTS idx_ft_transfer_group_id       ON firm_transactions(transfer_group_id);
CREATE INDEX IF NOT EXISTS idx_ft_transfer_to_firm_id     ON firm_transactions(transfer_to_firm_id);
CREATE INDEX IF NOT EXISTS idx_ft_is_firm_to_firm_transfer ON firm_transactions(is_firm_to_firm_transfer);
CREATE INDEX IF NOT EXISTS idx_ft_assigned_admin_id       ON firm_transactions(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_firm_txn_site_date         ON firm_transactions(site_id, date);
CREATE INDEX IF NOT EXISTS idx_ft_firm_date  ON firm_transactions(firm_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_ft_site_date  ON firm_transactions(site_id, date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ft_active_firm ON firm_transactions(firm_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_ft_site_name    ON firm_transactions(site_id, name)    WHERE name IS NOT NULL AND name != '';
CREATE INDEX IF NOT EXISTS idx_ft_site_purpose ON firm_transactions(site_id, purpose) WHERE purpose IS NOT NULL AND purpose != '';
CREATE INDEX IF NOT EXISTS idx_ft_site_remark  ON firm_transactions(site_id, remark)  WHERE remark IS NOT NULL AND remark != '';

DROP TRIGGER IF EXISTS trg_firm_transactions_updated_at ON firm_transactions;
CREATE TRIGGER trg_firm_transactions_updated_at
  BEFORE UPDATE ON firm_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 13. PLOT PAYMENTS  (payments received against plot sales)
-- ============================================================================
CREATE TABLE IF NOT EXISTS plot_payments (
  id              SERIAL PRIMARY KEY,
  plot_id         INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_from    VARCHAR(100),
  payment_type    VARCHAR(20) DEFAULT 'CASH' CHECK (payment_type IN ('BANK', 'CASH')),
  bank_name       VARCHAR(150),
  branch          VARCHAR(150),
  bank_details    VARCHAR(255),
  narration       TEXT,
  received_by     VARCHAR(255),
  buyer_name      VARCHAR(255),
  booked_by       VARCHAR(255),
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  -- Approval workflow (migration 009)
  voucher_url     VARCHAR(1000),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pp_plot      ON plot_payments(plot_id);
CREATE INDEX IF NOT EXISTS idx_pp_site      ON plot_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_pp_date      ON plot_payments(date);
CREATE INDEX IF NOT EXISTS idx_pp_status    ON plot_payments(status);
CREATE INDEX IF NOT EXISTS idx_plot_payments_site_date ON plot_payments(site_id, date);
CREATE INDEX IF NOT EXISTS idx_pp_assigned_admin_id ON plot_payments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_pp_active_plot ON plot_payments(plot_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_pp_plot_type ON plot_payments(plot_id, payment_type);
CREATE INDEX IF NOT EXISTS idx_pp_plot_date ON plot_payments(plot_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_pp_site_payment_from ON plot_payments(site_id, payment_from)
  WHERE payment_from IS NOT NULL AND payment_from != '';
CREATE INDEX IF NOT EXISTS idx_pp_site_received_by  ON plot_payments(site_id, received_by)
  WHERE received_by IS NOT NULL AND received_by != '';
CREATE INDEX IF NOT EXISTS idx_pp_site_booked_by    ON plot_payments(site_id, booked_by)
  WHERE booked_by IS NOT NULL AND booked_by != '';

DROP TRIGGER IF EXISTS trg_plot_payments_updated_at ON plot_payments;
CREATE TRIGGER trg_plot_payments_updated_at
  BEFORE UPDATE ON plot_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 14. PLOT REGISTRIES  (registry / sale-deed tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS plot_registries (
  id                SERIAL PRIMARY KEY,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  plot_id           INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  plot_no           VARCHAR(50) NOT NULL,
  customer_name     VARCHAR(255),
  size_meter        NUMERIC(10,2),
  size_sqyard       NUMERIC(10,2),
  circle_rate       NUMERIC(15,2),
  registry_date     DATE,
  created_entry_date DATE,
  farmer_name       VARCHAR(255),
  seller_name       VARCHAR(255),
  firm_name         VARCHAR(255),
  bank_amount       NUMERIC(15,2),
  registry_payment  NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, plot_no)
);
CREATE INDEX IF NOT EXISTS idx_pr_site    ON plot_registries(site_id);
CREATE INDEX IF NOT EXISTS idx_pr_plot_id ON plot_registries(plot_id);
CREATE INDEX IF NOT EXISTS idx_pr_plot_no ON plot_registries(plot_no);
CREATE INDEX IF NOT EXISTS idx_plot_registries_created_entry_date ON plot_registries(created_entry_date);
CREATE INDEX IF NOT EXISTS idx_plot_registries_assigned_admin_id  ON plot_registries(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_pr_site_plot_no_upper      ON plot_registries(site_id, UPPER(plot_no));
CREATE INDEX IF NOT EXISTS idx_pr_site_created_entry_date ON plot_registries(site_id, created_entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_pr_site_customer ON plot_registries(site_id, customer_name)
  WHERE customer_name IS NOT NULL AND customer_name != '';
CREATE INDEX IF NOT EXISTS idx_pr_site_farmer   ON plot_registries(site_id, farmer_name)
  WHERE farmer_name IS NOT NULL AND farmer_name != '';

DROP TRIGGER IF EXISTS trg_plot_registries_updated_at ON plot_registries;
CREATE TRIGGER trg_plot_registries_updated_at
  BEFORE UPDATE ON plot_registries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS plot_registry_payments (
  id              SERIAL PRIMARY KEY,
  registry_id     INTEGER NOT NULL REFERENCES plot_registries(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_plot_payment_id INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL,
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_mode    VARCHAR(50),
  tally_date      DATE,
  tally_amount    NUMERIC(15,2),
  notes           TEXT,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prp_registry ON plot_registry_payments(registry_id);
CREATE INDEX IF NOT EXISTS idx_prp_site     ON plot_registry_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_prp_date     ON plot_registry_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_plot_registry_payments_assigned_admin_id ON plot_registry_payments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_prp_registry_date ON plot_registry_payments(registry_id, payment_date, created_at);
CREATE INDEX IF NOT EXISTS idx_prp_source_plot_payment ON plot_registry_payments(source_plot_payment_id)
  WHERE source_plot_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prp_site_mode ON plot_registry_payments(site_id, payment_mode)
  WHERE payment_mode IS NOT NULL AND payment_mode != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_prp_source_plot_payment
  ON plot_registry_payments(source_plot_payment_id) WHERE source_plot_payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_plot_registry_payments_updated_at ON plot_registry_payments;
CREATE TRIGGER trg_plot_registry_payments_updated_at
  BEFORE UPDATE ON plot_registry_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 15. EXPENSES  (site-level payment / expense tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS expenses (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  from_entity     VARCHAR(255),
  to_entity       VARCHAR(255),
  payment_mode    VARCHAR(50),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  remark          TEXT,
  account_no      VARCHAR(100),
  branch          VARCHAR(255),
  category        VARCHAR(100),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voucher_url     TEXT,
  bill_url        TEXT,
  assigned_user_id  INTEGER REFERENCES members(id) ON DELETE SET NULL,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exp_site      ON expenses(site_id);
CREATE INDEX IF NOT EXISTS idx_exp_date      ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_exp_site_date ON expenses(site_id, date);
CREATE INDEX IF NOT EXISTS idx_exp_mode      ON expenses(payment_mode);
CREATE INDEX IF NOT EXISTS idx_exp_category  ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_exp_status    ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_exp_assigned_admin_id ON expenses(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_expenses_site_created  ON expenses(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exp_site_status        ON expenses(site_id, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_exp_active_site ON expenses(site_id, date DESC)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')) AND status != 'rejected';
CREATE INDEX IF NOT EXISTS idx_exp_site_to_entity   ON expenses(site_id, to_entity)
  WHERE to_entity IS NOT NULL AND to_entity != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_from_entity ON expenses(site_id, from_entity)
  WHERE from_entity IS NOT NULL AND from_entity != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_payment_mode ON expenses(site_id, payment_mode)
  WHERE payment_mode IS NOT NULL AND payment_mode != '';
CREATE INDEX IF NOT EXISTS idx_exp_site_category_active ON expenses(site_id, category)
  WHERE category IS NOT NULL AND category != '';

DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;
CREATE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 16. VENDOR MANAGEMENT  (commitments + payments, migrations 018/019/023/031)
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_heads (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_heads_site_name ON vendor_heads(site_id, name);

DROP TRIGGER IF EXISTS trg_vendor_heads_updated_at ON vendor_heads;
CREATE TRIGGER trg_vendor_heads_updated_at
  BEFORE UPDATE ON vendor_heads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS vendor_commitments (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  vendor_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  vendor_name     VARCHAR(200) NOT NULL,
  head_id         INTEGER REFERENCES vendor_heads(id) ON DELETE SET NULL,
  head_name       VARCHAR(120),
  work_title      VARCHAR(220) NOT NULL,
  contract_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (contract_amount >= 0),
  start_date      DATE,
  due_date        DATE,
  note            TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_commitments_site_id          ON vendor_commitments(site_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commitments_vendor_member_id ON vendor_commitments(vendor_member_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commitments_assigned_admin_id ON vendor_commitments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_vc_site_status     ON vendor_commitments(site_id, status);
CREATE INDEX IF NOT EXISTS idx_vc_site_head       ON vendor_commitments(site_id, head_id);
CREATE INDEX IF NOT EXISTS idx_vc_site_created_at ON vendor_commitments(site_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_vendor_commitments_updated_at ON vendor_commitments;
CREATE TRIGGER trg_vendor_commitments_updated_at
  BEFORE UPDATE ON vendor_commitments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS vendor_payments (
  id              SERIAL PRIMARY KEY,
  commitment_id   INTEGER NOT NULL REFERENCES vendor_commitments(id) ON DELETE CASCADE,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  payment_date    DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode    VARCHAR(20) NOT NULL DEFAULT 'cash'
                    CHECK (payment_mode IN ('cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other')),
  reference_no    VARCHAR(120),
  note            TEXT,
  voucher_url     TEXT,
  -- Approval workflow (migration 019)
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_commitment_id ON vendor_payments(commitment_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_site_id       ON vendor_payments(site_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_date          ON vendor_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_status        ON vendor_payments(status);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_assigned_admin_id ON vendor_payments(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_vp_commitment_active ON vendor_payments(commitment_id)
  WHERE cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED');
CREATE INDEX IF NOT EXISTS idx_vp_site_date ON vendor_payments(site_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_vp_active_for_unified ON vendor_payments(site_id, payment_date DESC)
  WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED')) AND status != 'rejected';

-- ============================================================================
-- 17. VENDOR INVENTORY  (purchase orders + payments, migrations 043/044/047)
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_inventory_orders (
  id                  SERIAL PRIMARY KEY,
  site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  vendor_member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
  commitment_id       INTEGER REFERENCES vendor_commitments(id) ON DELETE SET NULL,
  vendor_name         VARCHAR(200) NOT NULL,
  item_name           VARCHAR(200) NOT NULL,
  item_category       VARCHAR(120),
  unit                VARCHAR(40)  NOT NULL DEFAULT 'pcs',
  qty_ordered         NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_ordered >= 0),
  qty_received        NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  rate                NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  discount_pct        NUMERIC(6,3)  NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  gross_amount        NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(qty_received * rate, 2)) STORED,
  net_amount          NUMERIC(14,2) GENERATED ALWAYS AS (
                        ROUND(qty_received * rate
                          - COALESCE(CASE
                            WHEN discount_pct > 0 THEN ROUND(qty_received * rate * discount_pct / 100, 2)
                            ELSE discount_amount
                          END, 0), 2)
                      ) STORED,
  total_paid          NUMERIC(14,2) NOT NULL DEFAULT 0,
  order_date          DATE NOT NULL,
  expected_date       DATE,
  note                TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'partial', 'completed', 'cancelled')),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vio_site_id          ON vendor_inventory_orders(site_id);
CREATE INDEX IF NOT EXISTS idx_vio_vendor_member_id ON vendor_inventory_orders(vendor_member_id);
CREATE INDEX IF NOT EXISTS idx_vio_order_date       ON vendor_inventory_orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_vio_commitment_id    ON vendor_inventory_orders(commitment_id);
CREATE INDEX IF NOT EXISTS idx_vio_site_status_date ON vendor_inventory_orders(site_id, status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_vio_site_category    ON vendor_inventory_orders(site_id, LOWER(item_category));
CREATE INDEX IF NOT EXISTS idx_vio_commitment_site  ON vendor_inventory_orders(commitment_id, site_id);

CREATE TABLE IF NOT EXISTS vendor_inventory_payments (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES vendor_inventory_orders(id) ON DELETE CASCADE,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  payment_date  DATE NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_mode  VARCHAR(20) NOT NULL DEFAULT 'cash'
                  CHECK (payment_mode IN ('cash','bank','upi','cheque','neft','rtgs','imps','other')),
  reference_no  VARCHAR(120),
  cheque_no     VARCHAR(50),
  note          TEXT,
  voucher_url   TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vipay_order_id ON vendor_inventory_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_vipay_site_date ON vendor_inventory_payments(site_id, payment_date DESC);

-- ============================================================================
-- 18. IMPREST  (admin → sub-admin petty cash; ledger; overdraft requests)
-- ============================================================================
CREATE TABLE IF NOT EXISTS imprest_allocations (
  id                  SERIAL PRIMARY KEY,
  admin_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount              NUMERIC(15,2) NOT NULL,
  remark              TEXT,
  status              VARCHAR(30) NOT NULL DEFAULT 'PENDING_RECEIPT'
                        CHECK (status IN ('PENDING_RECEIPT', 'RECEIVED', 'CANCELLED')),
  confirmation_remark TEXT,
  assigned_admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ia_admin     ON imprest_allocations(admin_id);
CREATE INDEX IF NOT EXISTS idx_ia_sub_admin ON imprest_allocations(sub_admin_id);
CREATE INDEX IF NOT EXISTS idx_ia_status    ON imprest_allocations(status);
CREATE INDEX IF NOT EXISTS idx_imprest_allocations_assigned_admin_id ON imprest_allocations(assigned_admin_id);

DROP TRIGGER IF EXISTS trg_imprest_allocations_updated_at ON imprest_allocations;
CREATE TRIGGER trg_imprest_allocations_updated_at
  BEFORE UPDATE ON imprest_allocations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS imprest_ledger (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(30) NOT NULL
                        CHECK (type IN ('ALLOCATION', 'EXPENSE', 'ADJUSTMENT', 'REFUND')),
  reference_id        INTEGER,
  amount              NUMERIC(15,2) NOT NULL,
  balance_after       NUMERIC(15,2) NOT NULL DEFAULT 0,
  remarks             TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_il_user    ON imprest_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_il_type    ON imprest_ledger(type);
CREATE INDEX IF NOT EXISTS idx_il_created ON imprest_ledger(created_at);

CREATE TABLE IF NOT EXISTS imprest_expense_requests (
  id                  SERIAL PRIMARY KEY,
  sub_admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  amount              NUMERIC(15,2) NOT NULL,
  expense_data        JSONB NOT NULL,
  reason              TEXT,
  status              VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  review_remark       TEXT,
  assigned_admin_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ier_sub_admin ON imprest_expense_requests(sub_admin_id);
CREATE INDEX IF NOT EXISTS idx_ier_status    ON imprest_expense_requests(status);
CREATE INDEX IF NOT EXISTS idx_ier_site      ON imprest_expense_requests(site_id);
CREATE INDEX IF NOT EXISTS idx_imprest_expense_requests_assigned_admin_id ON imprest_expense_requests(assigned_admin_id);

DROP TRIGGER IF EXISTS trg_imprest_expense_requests_updated_at ON imprest_expense_requests;
CREATE TRIGGER trg_imprest_expense_requests_updated_at
  BEFORE UPDATE ON imprest_expense_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 19. DAY BOOK  (daily ledger; links back to every source module)
-- ============================================================================
CREATE TABLE IF NOT EXISTS day_book (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  particular      VARCHAR(500) NOT NULL,
  entry_type      VARCHAR(50) NOT NULL DEFAULT 'GENERAL'
                    CHECK (entry_type IN ('GENERAL','EXPENSE','INCOME','PAYMENT','RECEIPT','TRANSFER','ADJUSTMENT','OTHER','FARMER PAYMENT','PLOT COMMISSION','CASH FLOW','FIRM TRANSACTION','PLOT PAYMENT','IMPREST','VENDOR PAYMENT')),
  debit           NUMERIC(15,2) NOT NULL DEFAULT 0,
  credit          NUMERIC(15,2) NOT NULL DEFAULT 0,
  remarks         TEXT,
  payment_mode    VARCHAR(50),
  category        VARCHAR(100),
  from_entity     VARCHAR(255),
  to_entity       VARCHAR(255),
  account_no      VARCHAR(100),
  branch          VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  -- Source-module linkage
  farmer_payment_id   INTEGER REFERENCES farmer_payments(id) ON DELETE SET NULL,
  commission_id       INTEGER REFERENCES plot_commissions(id) ON DELETE SET NULL,
  cash_flow_entry_id  INTEGER REFERENCES cash_flow_entries(id) ON DELETE SET NULL,
  firm_transaction_id INTEGER REFERENCES firm_transactions(id) ON DELETE SET NULL,
  plot_payment_id     INTEGER REFERENCES plot_payments(id) ON DELETE SET NULL,
  imprest_allocation_id INTEGER REFERENCES imprest_allocations(id) ON DELETE SET NULL,
  vendor_payment_id   INTEGER REFERENCES vendor_payments(id) ON DELETE SET NULL,
  -- Assignment / vouchers / cheque (migrations 008/020/031)
  assigned_user_id  INTEGER REFERENCES members(id) ON DELETE SET NULL,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voucher_url     VARCHAR(1000),
  cheque_status   VARCHAR(20),
  cheque_no       VARCHAR(50),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_day_book_site      ON day_book(site_id);
CREATE INDEX IF NOT EXISTS idx_day_book_date      ON day_book(date);
CREATE INDEX IF NOT EXISTS idx_day_book_type      ON day_book(entry_type);
CREATE INDEX IF NOT EXISTS idx_day_book_site_date ON day_book(site_id, date);
CREATE INDEX IF NOT EXISTS idx_day_book_status    ON day_book(status);
CREATE INDEX IF NOT EXISTS idx_day_book_cash_flow_entry_id  ON day_book(cash_flow_entry_id);
CREATE INDEX IF NOT EXISTS idx_day_book_firm_transaction_id ON day_book(firm_transaction_id);
CREATE INDEX IF NOT EXISTS idx_day_book_plot_payment_id     ON day_book(plot_payment_id);
CREATE INDEX IF NOT EXISTS idx_day_book_vendor_payment_id   ON day_book(vendor_payment_id);
CREATE INDEX IF NOT EXISTS idx_day_book_assigned_admin_id   ON day_book(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_daybook_site_type        ON day_book(site_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_daybook_site_type_date   ON day_book(site_id, entry_type, date DESC);
CREATE INDEX IF NOT EXISTS idx_day_book_farmer_payment_id ON day_book(farmer_payment_id)
  WHERE farmer_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_day_book_expense_unified ON day_book(site_id, date DESC)
  WHERE entry_type = 'EXPENSE'
    AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
    AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
    AND status != 'rejected';

DROP TRIGGER IF EXISTS trg_day_book_updated_at ON day_book;
CREATE TRIGGER trg_day_book_updated_at
  BEFORE UPDATE ON day_book
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Per-site per-date opening/closing balance snapshot (migration 048)
CREATE TABLE IF NOT EXISTS day_book_daily_balance (
  id              SERIAL PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  closing_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id, date)
);
CREATE INDEX IF NOT EXISTS idx_dbdb_site_date ON day_book_daily_balance(site_id, date DESC);

-- ============================================================================
-- 20. CHAT  (1:1 conversations + messages, migration 012)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  user1_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user2_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user1_id, user2_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message_text    TEXT,
  attachment_url  TEXT,
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 21. CASH-FLOW AUTO-SYNC ENGINE
--     Every financial module row is mirrored into cash_flow_entries via these
--     triggers, so the central ledger always reflects all module activity.
--     Function bodies reflect the FINAL versions (migrations 016/019/041/047).
-- ============================================================================

-- Ensure a "site" cash-flow month exists for a given date, carrying forward the
-- closing balance of the previous month as the opening balance.
CREATE OR REPLACE FUNCTION ensure_site_cashflow_month(
  p_site_id INTEGER,
  p_entry_date DATE,
  p_created_by INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_month INTEGER;
  v_year INTEGER;
  v_month_id INTEGER;
  v_prev_id INTEGER;
  v_opening NUMERIC(15,2) := 0;
BEGIN
  v_month := EXTRACT(MONTH FROM p_entry_date)::INTEGER;
  v_year := EXTRACT(YEAR FROM p_entry_date)::INTEGER;

  SELECT id INTO v_month_id
  FROM cash_flow_months
  WHERE site_id = p_site_id
    AND month = v_month
    AND year = v_year
    AND COALESCE(ledger_name, '') = ''
    AND COALESCE(ledger_type, 'site') = 'site'
  LIMIT 1;

  IF v_month_id IS NOT NULL THEN
    RETURN v_month_id;
  END IF;

  SELECT cfm.id INTO v_prev_id
  FROM cash_flow_months cfm
  WHERE cfm.site_id = p_site_id
    AND COALESCE(cfm.ledger_name, '') = ''
    AND COALESCE(cfm.ledger_type, 'site') = 'site'
    AND (cfm.year < v_year OR (cfm.year = v_year AND cfm.month < v_month))
  ORDER BY cfm.year DESC, cfm.month DESC
  LIMIT 1;

  IF v_prev_id IS NOT NULL THEN
    SELECT
      COALESCE(cfm.opening_balance, 0)
        + COALESCE(SUM(cfe.credit), 0)
        - COALESCE(SUM(cfe.debit), 0)
    INTO v_opening
    FROM cash_flow_months cfm
    LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
    WHERE cfm.id = v_prev_id
    GROUP BY cfm.opening_balance;
  END IF;

  INSERT INTO cash_flow_months (
    site_id, month, year, ledger_name, ledger_type, opening_balance, created_by
  ) VALUES (
    p_site_id, v_month, v_year, '', 'site', COALESCE(v_opening, 0), p_created_by
  )
  ON CONFLICT (site_id, month, year, ledger_name)
  DO NOTHING;

  SELECT id INTO v_month_id
  FROM cash_flow_months
  WHERE site_id = p_site_id
    AND month = v_month
    AND year = v_year
    AND COALESCE(ledger_name, '') = ''
    AND COALESCE(ledger_type, 'site') = 'site'
  LIMIT 1;

  RETURN v_month_id;
END;
$$;

-- Central upsert: mirrors a source-module row into cash_flow_entries
-- (handles INSERT / UPDATE / DELETE). FINAL version — migration 041.
CREATE OR REPLACE FUNCTION sync_cashflow_from_modules()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_site_id INTEGER;
  v_entry_date DATE;
  v_particular VARCHAR(500);
  v_debit NUMERIC(15,2) := 0;
  v_credit NUMERIC(15,2) := 0;
  v_cash_type VARCHAR(20) := 'bank';
  v_remarks TEXT;
  v_created_by INTEGER;
  v_month_id INTEGER;
  v_source_module VARCHAR(50);
  v_source_id INTEGER;
  v_assigned_admin_id INTEGER;
  v_voucher_url TEXT;
  v_status VARCHAR(20) := 'pending';
  v_approved_by INTEGER;
  v_approved_at TIMESTAMPTZ;
  v_cheque_status VARCHAR(20);
  v_cheque_no VARCHAR(50);
BEGIN
  v_source_module := TG_TABLE_NAME;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM cash_flow_entries cfe
    WHERE cfe.source_module = v_source_module
      AND cfe.source_id = OLD.id;
    RETURN OLD;
  END IF;

  v_source_id := NEW.id;

  -- Safe assignments from NEW (only if columns exist in the table)
  IF TG_TABLE_NAME IN ('farmer_payments', 'plot_commission_payments', 'firm_transactions', 'vendor_payments', 'plot_payments', 'expenses', 'plot_registry_payments', 'day_book', 'plot_commissions', 'plot_installment_payments') THEN
    BEGIN
      v_cheque_status := NEW.cheque_status;
      v_cheque_no := NEW.cheque_no;
    EXCEPTION WHEN OTHERS THEN
      v_cheque_status := NULL;
      v_cheque_no := NULL;
    END;
  END IF;

  -- ── CASE: farmer_payments ──
  IF TG_TABLE_NAME = 'farmer_payments' THEN
    SELECT f.site_id, f.name INTO v_site_id, v_particular FROM farmers f WHERE f.id = NEW.farmer_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
    v_debit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_remarks := NEW.remarks;
    v_assigned_admin_id := NEW.assigned_admin_id;

  -- ── CASE: plot_commissions ──
  ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
    v_debit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%CHEQUE%' THEN 'cheque'
      WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%BANK%'   THEN 'bank'
      WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%ONLINE%' THEN 'bank'
      ELSE 'cash'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;
    v_remarks := NEW.remarks;

  -- ── CASE: plot_commission_payments ──
  ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
    SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular FROM plot_commissions_v2 pcm LEFT JOIN members m ON m.id = pcm.agent_id WHERE pcm.id = NEW.plot_commission_id;
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
    v_debit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;

  -- ── CASE: firm_transactions ──
  ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := ('FIRM TRANSACTION - ' || COALESCE(NEW.description, 'TRANSACTION'))::VARCHAR(500);
    v_debit := COALESCE(NEW.debit, 0);
    v_credit := COALESCE(NEW.credit, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := 'approved';
    v_created_by := NEW.created_by;
    v_remarks := NEW.remark;

  -- ── CASE: plot_payments ──
  ELSIF TG_TABLE_NAME = 'plot_payments' THEN
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.buyer_name, NEW.payment_from, 'PLOT'))::VARCHAR(500);
    v_credit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;
    v_remarks := NEW.narration;

  -- ── CASE: expenses ──
  ELSIF TG_TABLE_NAME = 'expenses' THEN
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
    v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY')::VARCHAR(500);
    v_debit := COALESCE(NEW.debit, 0);
    v_credit := COALESCE(NEW.credit, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%CHEQUE%' THEN 'cheque'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%'   THEN 'bank'
      ELSE 'cash'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;
    v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);

  -- ── CASE: vendor_payments ──
  ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
    SELECT vc.vendor_name INTO v_particular FROM vendor_commitments vc WHERE vc.id = NEW.commitment_id;
    v_site_id := NEW.site_id;
    v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
    v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
    v_debit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'cheque' THEN 'cheque'
      WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank'   THEN 'bank'
      ELSE 'cash'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;
    v_remarks := NEW.note;

  -- ── CASE: plot_installment_payments ──
  ELSIF TG_TABLE_NAME = 'plot_installment_payments' THEN
    SELECT plot_no, buyer_name, site_id INTO v_particular, v_remarks, v_site_id FROM plots WHERE id = NEW.plot_id;
    v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
    v_particular := ('INST. PAYMENT - ' || COALESCE(v_particular, 'PLOT') || ' (' || COALESCE(v_remarks, 'BUYER') || ')')::VARCHAR(500);
    v_credit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := 'approved';
    v_created_by := NEW.created_by;
    v_remarks := NEW.notes;

  -- ── CASE: plot_registry_payments ──
  ELSIF TG_TABLE_NAME = 'plot_registry_payments' THEN
    SELECT p.plot_no, p.buyer_name, p.site_id INTO v_particular, v_remarks, v_site_id FROM plot_registries pr JOIN plots p ON pr.plot_id = p.id WHERE pr.id = NEW.registry_id;
    v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
    v_particular := ('REGISTRY PAYMENT - ' || COALESCE(v_particular, 'PLOT') || ' (' || COALESCE(v_remarks, 'BUYER') || ')')::VARCHAR(500);
    v_debit := COALESCE(NEW.amount, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := 'approved';
    v_created_by := NEW.created_by;
    v_remarks := NEW.notes;

  -- ── CASE: day_book ──
  -- Day-book entries whose type belongs to another module are linked back to
  -- that module's own table and must NOT create a duplicate CFE.
  ELSIF TG_TABLE_NAME = 'day_book' THEN
    IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT')
       AND (NEW.cash_flow_entry_id IS NOT NULL
            OR NEW.firm_transaction_id IS NOT NULL
            OR NEW.plot_payment_id IS NOT NULL
            OR NEW.farmer_payment_id IS NOT NULL
            OR NEW.commission_id IS NOT NULL
            OR NEW.vendor_payment_id IS NOT NULL)
    THEN
      DELETE FROM cash_flow_entries WHERE source_module = 'day_book' AND source_id = NEW.id;
      RETURN NEW;
    END IF;
    v_site_id := NEW.site_id;
    v_entry_date := NEW.date;
    v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY')::VARCHAR(500);
    v_debit := COALESCE(NEW.debit, 0);
    v_credit := COALESCE(NEW.credit, 0);
    v_cash_type := CASE
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CASH'   THEN 'cash'
      WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'CHEQUE' THEN 'cheque'
      ELSE 'bank'
    END;
    v_status := COALESCE(NEW.status, 'pending');
    v_created_by := NEW.created_by;
    v_remarks := NEW.remarks;
  END IF;

  -- NOTE: Bounced/returned cheques keep their actual amounts here.
  -- All financial sum queries exclude them via:
  --   (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))

  IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0 AND v_cheque_status IS NULL) THEN
    DELETE FROM cash_flow_entries cfe WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
    RETURN NEW;
  END IF;

  v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

  INSERT INTO cash_flow_entries (
    cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
    status, source_module, source_id, created_by, created_at,
    assigned_admin_id, cheque_status, cheque_no
  ) VALUES (
    v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
    v_status, v_source_module, v_source_id, v_created_by, NEW.created_at,
    NEW.assigned_admin_id, v_cheque_status, v_cheque_no
  )
  ON CONFLICT (source_module, source_id)
  DO UPDATE SET
    cash_flow_month_id = EXCLUDED.cash_flow_month_id, site_id = EXCLUDED.site_id,
    date = EXCLUDED.date, particular = EXCLUDED.particular,
    debit = EXCLUDED.debit, credit = EXCLUDED.credit, cash_type = EXCLUDED.cash_type,
    remarks = EXCLUDED.remarks, status = EXCLUDED.status, created_by = EXCLUDED.created_by,
    assigned_admin_id = EXCLUDED.assigned_admin_id,
    cheque_status = EXCLUDED.cheque_status, cheque_no = EXCLUDED.cheque_no, updated_at = NOW();

  RETURN NEW;
END;
$$;

-- Propagate status/approval/voucher changes from source rows to their CFE
-- (migration 017/019).
CREATE OR REPLACE FUNCTION sync_cashflow_status_from_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'day_book' THEN
    UPDATE cash_flow_entries cfe
    SET status = COALESCE(NEW.status, cfe.status),
        approved_by = NEW.approved_by,
        approved_at = NEW.approved_at,
        assigned_admin_id = NEW.assigned_admin_id,
        updated_at = NOW()
    WHERE cfe.source_module = 'day_book' AND cfe.source_id = NEW.id;

  ELSIF TG_TABLE_NAME = 'expenses' THEN
    UPDATE cash_flow_entries cfe
    SET status = COALESCE(NEW.status, cfe.status),
        approved_by = NEW.approved_by,
        approved_at = NEW.approved_at,
        voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
        updated_at = NOW()
    WHERE cfe.source_module = 'expenses' AND cfe.source_id = NEW.id;

  ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
    UPDATE cash_flow_entries cfe
    SET status = COALESCE(NEW.status, cfe.status),
        voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
        updated_at = NOW()
    WHERE cfe.source_module = 'firm_transactions' AND cfe.source_id = NEW.id;

  ELSIF TG_TABLE_NAME = 'plot_payments' THEN
    UPDATE cash_flow_entries cfe
    SET status = COALESCE(NEW.status, cfe.status),
        voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
        updated_at = NOW()
    WHERE cfe.source_module = 'plot_payments' AND cfe.source_id = NEW.id;

  ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
    UPDATE cash_flow_entries cfe
    SET status = COALESCE(NEW.status, cfe.status),
        approved_by = NEW.approved_by,
        approved_at = NEW.approved_at,
        voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
        updated_at = NOW()
    WHERE cfe.source_module = 'vendor_payments' AND cfe.source_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Mirror vendor_payments into day_book (migration 019)
CREATE OR REPLACE FUNCTION sync_daybook_from_vendor_payments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_vendor_name VARCHAR(255);
BEGIN
  SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_vendor_name
  FROM vendor_commitments vc
  WHERE vc.id = NEW.commitment_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO day_book (
      site_id, date, particular, entry_type,
      debit, credit, remarks, payment_mode,
      category, from_entity, to_entity,
      status, approved_by, approved_at,
      vendor_payment_id, created_by
    ) VALUES (
      NEW.site_id,
      COALESCE(NEW.payment_date, CURRENT_DATE),
      ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
      'VENDOR PAYMENT',
      COALESCE(NEW.amount, 0),
      0,
      NEW.note,
      UPPER(COALESCE(NEW.payment_mode, 'CASH')),
      'VENDOR',
      'COMPANY',
      COALESCE(v_vendor_name, NEW.reference_no, 'VENDOR'),
      COALESCE(NEW.status, 'pending'),
      NEW.approved_by,
      NEW.approved_at,
      NEW.id,
      NEW.created_by
    )
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE day_book db
    SET site_id = NEW.site_id,
        date = COALESCE(NEW.payment_date, db.date),
        particular = ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
        debit = COALESCE(NEW.amount, 0),
        credit = 0,
        remarks = NEW.note,
        payment_mode = UPPER(COALESCE(NEW.payment_mode, db.payment_mode, 'CASH')),
        category = 'VENDOR',
        from_entity = 'COMPANY',
        to_entity = COALESCE(v_vendor_name, db.to_entity),
        status = COALESCE(NEW.status, db.status),
        approved_by = NEW.approved_by,
        approved_at = NEW.approved_at,
        updated_at = NOW()
    WHERE db.vendor_payment_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Keep vendor_inventory_orders.total_paid + status in sync (migration 047)
CREATE OR REPLACE FUNCTION sync_vendor_inventory_order()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_order_id INTEGER;
  v_paid     NUMERIC(14,2);
  v_value    NUMERIC(14,2);
  v_status   VARCHAR(20);
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
  FROM vendor_inventory_payments WHERE order_id = v_order_id;

  SELECT ROUND(qty_ordered * rate
    - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                   ELSE discount_amount END, 0), 2)
  INTO v_value
  FROM vendor_inventory_orders WHERE id = v_order_id;

  IF v_value IS NULL OR v_value <= 0 THEN
    v_status := 'open';
  ELSIF v_paid <= 0 THEN
    v_status := 'open';
  ELSIF v_paid >= v_value THEN
    v_status := 'completed';
  ELSE
    v_status := 'partial';
  END IF;

  UPDATE vendor_inventory_orders
  SET total_paid = v_paid,
      status     = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE v_status END,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = v_order_id;

  RETURN NULL;
END;
$$;

-- ── Cash-flow sync triggers (INSERT/UPDATE/DELETE) on all source modules ──
DROP TRIGGER IF EXISTS trg_sync_cfe_farmer_payments ON farmer_payments;
CREATE TRIGGER trg_sync_cfe_farmer_payments
  AFTER INSERT OR UPDATE OR DELETE ON farmer_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commissions ON plot_commissions;
CREATE TRIGGER trg_sync_cfe_plot_commissions
  AFTER INSERT OR UPDATE OR DELETE ON plot_commissions
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_plot_commission_payments ON plot_commission_payments;
CREATE TRIGGER trg_sync_cfe_plot_commission_payments
  AFTER INSERT OR UPDATE OR DELETE ON plot_commission_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_day_book ON day_book;
CREATE TRIGGER trg_sync_cfe_day_book
  AFTER INSERT OR UPDATE OR DELETE ON day_book
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_firm_transactions ON firm_transactions;
CREATE TRIGGER trg_sync_cfe_firm_transactions
  AFTER INSERT OR UPDATE OR DELETE ON firm_transactions
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_plot_payments ON plot_payments;
CREATE TRIGGER trg_sync_cfe_plot_payments
  AFTER INSERT OR UPDATE OR DELETE ON plot_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_expenses ON expenses;
CREATE TRIGGER trg_sync_cfe_expenses
  AFTER INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_vendor_payments ON vendor_payments;
CREATE TRIGGER trg_sync_cfe_vendor_payments
  AFTER INSERT OR UPDATE OR DELETE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_plot_installment_payments ON plot_installment_payments;
CREATE TRIGGER trg_sync_cfe_plot_installment_payments
  AFTER INSERT OR UPDATE OR DELETE ON plot_installment_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

DROP TRIGGER IF EXISTS trg_sync_cfe_plot_registry_payments ON plot_registry_payments;
CREATE TRIGGER trg_sync_cfe_plot_registry_payments
  AFTER INSERT OR UPDATE OR DELETE ON plot_registry_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules();

-- ── Status-sync triggers (INSERT/UPDATE) ──
DROP TRIGGER IF EXISTS trg_sync_cfe_status_day_book ON day_book;
CREATE TRIGGER trg_sync_cfe_status_day_book
  AFTER INSERT OR UPDATE ON day_book
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();

DROP TRIGGER IF EXISTS trg_sync_cfe_status_expenses ON expenses;
CREATE TRIGGER trg_sync_cfe_status_expenses
  AFTER INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();

DROP TRIGGER IF EXISTS trg_sync_cfe_status_firm_transactions ON firm_transactions;
CREATE TRIGGER trg_sync_cfe_status_firm_transactions
  AFTER INSERT OR UPDATE ON firm_transactions
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();

DROP TRIGGER IF EXISTS trg_sync_cfe_status_plot_payments ON plot_payments;
CREATE TRIGGER trg_sync_cfe_status_plot_payments
  AFTER INSERT OR UPDATE ON plot_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();

DROP TRIGGER IF EXISTS trg_sync_cfe_status_vendor_payments ON vendor_payments;
CREATE TRIGGER trg_sync_cfe_status_vendor_payments
  AFTER INSERT OR UPDATE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();

-- ── Vendor payment → day_book mirror ──
DROP TRIGGER IF EXISTS trg_sync_daybook_vendor_payments ON vendor_payments;
CREATE TRIGGER trg_sync_daybook_vendor_payments
  AFTER INSERT OR UPDATE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION sync_daybook_from_vendor_payments();

-- ── Vendor inventory order sync ──
DROP TRIGGER IF EXISTS trg_sync_inv_payment ON vendor_inventory_payments;
CREATE TRIGGER trg_sync_inv_payment
  AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments
  FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_order();

-- ============================================================================
-- SEED DATA: Admin User
-- ============================================================================
INSERT INTO users (name, email, password, role, is_active) 
VALUES ('Admin', 'admin@gmail.com', 'admin@1234', 'admin', TRUE)
ON CONFLICT (email) DO NOTHING;

COMMIT;

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
