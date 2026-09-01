import pool from '../config/db.js';

// The OCR engine label records which engine produced a result. It was
// varchar(40), sized when labels looked like 'groq-llama-3.3'. Once a document
// could be OCR'd by one provider and structured by another the label became a
// pair — 'mistral-ocr:mistral-ocr-latest+openrouter:qwen/qwen3-vl-30b-a3b-instruct'
// is 72 characters — and the INSERT died with "value too long for type character
// varying(40)", failing the whole extraction after the OCR and AI calls had both
// already succeeded and been paid for.
//
// Widening a varchar in PostgreSQL is a catalogue-only change: no table rewrite,
// no lock beyond a brief ACCESS EXCLUSIVE, no data touched. The code also
// shortens and clamps the label, but the column is widened so that a label
// nobody anticipated can never again discard a good result.
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE documents   ALTER COLUMN ocr_engine TYPE VARCHAR(120)`);
    await client.query(`ALTER TABLE ocr_results ALTER COLUMN engine     TYPE VARCHAR(120)`);
    await client.query('COMMIT');
    console.log('Migration 128_ocr_engine_label_width complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 128_ocr_engine_label_width failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
