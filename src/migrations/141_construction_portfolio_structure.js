import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Give Construction a reusable location hierarchy instead of baking one
 * building shape into the product. A project can now model Block A > Floor 2
 * > Flat 204, Phase 1 > Plot 18, a studio wing, or any mixture of them.
 * Operational records keep their project link and may optionally point at the
 * exact location where the work, material or vendor commitment belongs.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('141_construction_portfolio_structure'))`);

    await client.query(`
      ALTER TABLE construction_projects
      ADD COLUMN IF NOT EXISTS project_type VARCHAR(32) NOT NULL DEFAULT 'GENERAL'
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'construction_projects_type_check'
        ) THEN
          ALTER TABLE construction_projects ADD CONSTRAINT construction_projects_type_check
          CHECK (project_type IN (
            'GENERAL','STUDIO_APARTMENTS','APARTMENTS','FLATS','PLOTTED_DEVELOPMENT',
            'MIXED_USE','INFRASTRUCTURE','RENOVATION'
          ));
        END IF;
      END $$
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_locations (
        id            SERIAL PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
        parent_id     INTEGER,
        location_type VARCHAR(24) NOT NULL DEFAULT 'ZONE'
                        CHECK (location_type IN (
                          'SITE','PHASE','TOWER','BLOCK','FLOOR','UNIT','FLAT','STUDIO',
                          'PLOT','VILLA','ZONE','AMENITY'
                        )),
        name          VARCHAR(255) NOT NULL,
        code          VARCHAR(60),
        status        VARCHAR(20) NOT NULL DEFAULT 'PLANNED'
                        CHECK (status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED')),
        progress_pct  INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
        sequence      INTEGER NOT NULL DEFAULT 0,
        area_sqft     NUMERIC(15,2),
        notes         TEXT,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (id, project_id)
      )
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'construction_locations_parent_project_fk'
        ) THEN
          ALTER TABLE construction_locations
          ADD CONSTRAINT construction_locations_parent_project_fk
          FOREIGN KEY (parent_id, project_id)
          REFERENCES construction_locations(id, project_id) ON DELETE CASCADE;
        END IF;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_locations_project_parent ON construction_locations(project_id, parent_id, sequence, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_locations_project_type ON construction_locations(project_id, location_type)`);

    await client.query(`ALTER TABLE construction_tasks ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await client.query(`ALTER TABLE construction_material_requests ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await client.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await client.query(`ALTER TABLE vendor_commitments ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES construction_projects(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE vendor_commitments ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await client.query(`ALTER TABLE vendor_inventory_orders ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES construction_projects(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE vendor_inventory_orders ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await client.query(`ALTER TABLE vendor_inventory_orders ADD COLUMN IF NOT EXISTS material_request_id INTEGER REFERENCES construction_material_requests(id) ON DELETE SET NULL`);

    // The single-column key safely clears only location_id on location delete.
    // The composite key independently prevents cross-project attachments.
    const constraints = [
      ['construction_tasks', 'construction_tasks_location_project_fk', 'location_id, project_id'],
      ['construction_material_requests', 'construction_requests_location_project_fk', 'location_id, project_id'],
      ['inventory_movements', 'inventory_movements_location_project_fk', 'location_id, project_id'],
      ['vendor_commitments', 'vendor_commitments_location_project_fk', 'location_id, project_id'],
      ['vendor_inventory_orders', 'vendor_orders_location_project_fk', 'location_id, project_id'],
    ];
    for (const [table, name, columns] of constraints) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_location_fk') THEN
            ALTER TABLE ${table} ADD CONSTRAINT ${table}_location_fk
            FOREIGN KEY (location_id) REFERENCES construction_locations(id) ON DELETE SET NULL;
          END IF;
        END $$
      `);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE ${table} ADD CONSTRAINT ${name}
            FOREIGN KEY (${columns}) REFERENCES construction_locations(id, project_id);
          END IF;
        END $$
      `);
    }

    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_tasks_location ON construction_tasks(location_id) WHERE location_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_requests_location ON construction_material_requests(location_id) WHERE location_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_location ON inventory_movements(location_id) WHERE location_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_commitments_project ON vendor_commitments(project_id) WHERE project_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vendor_orders_project ON vendor_inventory_orders(project_id) WHERE project_id IS NOT NULL`);

    await client.query('COMMIT');
    console.log('Migration 141: construction portfolio structure ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 141 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
