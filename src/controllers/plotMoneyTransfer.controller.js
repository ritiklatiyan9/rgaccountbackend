import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { executePlotMoneyTransfer, transferInput } from '../services/plotMoneyTransfer.service.js';

export const transferPlotMoney = asyncHandler(async (req, res) => {
  const input = transferInput(req.body, req.params.id);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await executePlotMoneyTransfer(db, req.user, input);
    await db.query('COMMIT');
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
});
