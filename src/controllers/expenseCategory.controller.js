import asyncHandler from '../utils/asyncHandler.js';
import { expenseCategoryModel } from '../models/ExpenseCategory.model.js';
import pool from '../config/db.js';

export const listExpenseCategories = asyncHandler(async (req, res) => {
    const categories = await expenseCategoryModel.findAllOrdered(pool);
    res.json({ categories });
});

export const createExpenseCategory = asyncHandler(async (req, res) => {
    const { name, icon, color, grp } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Category name is required' });
    }

    const trimmed = name.trim().toUpperCase();

    // Single CTE: dup-check + INSERT in ONE round-trip (was 2).
    const result = await pool.query(
        `WITH existing AS (
           SELECT 1 FROM expense_categories WHERE UPPER(name) = $1 LIMIT 1
         ),
         ins AS (
           INSERT INTO expense_categories (name, icon, color, grp)
           SELECT $1, $2, $3, $4
           WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING *
         )
         SELECT
           (SELECT row_to_json(ins) FROM ins) AS category,
           EXISTS (SELECT 1 FROM existing) AS dup`,
        [trimmed, icon || 'Tag', color || 'slate', grp || 'Custom']
    );
    const row = result.rows[0];
    if (row.dup) return res.status(409).json({ message: 'Category already exists' });
    res.status(201).json({ category: row.category });
});

export const updateExpenseCategory = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, icon, color, grp } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim().toUpperCase();
    if (icon !== undefined) data.icon = icon;
    if (color !== undefined) data.color = color;
    if (grp !== undefined) data.grp = grp;

    if (Object.keys(data).length === 0) {
        return res.status(400).json({ message: 'Nothing to update' });
    }

    // Sub-categories are keyed by category name, so a rename carries them along.
    if (data.name) {
        await pool.query(
            `UPDATE expense_sub_categories s SET category = $2
               FROM expense_categories c
              WHERE c.id = $1 AND s.category = c.name AND c.name <> $2`,
            [id, data.name]
        );
    }
    // Atomic UPDATE — saves a SELECT round-trip.
    const updated = await expenseCategoryModel.update(id, data, pool);
    if (!updated) return res.status(404).json({ message: 'Category not found' });
    res.json({ category: updated });
});

export const deleteExpenseCategory = asyncHandler(async (req, res) => {
    // Its sub-categories are keyed by this category's name and go with it.
    await pool.query(
        `DELETE FROM expense_sub_categories s USING expense_categories c WHERE c.id = $1 AND s.category = c.name`,
        [parseInt(req.params.id)]
    );
    const result = await pool.query(
        `DELETE FROM expense_categories WHERE id = $1 RETURNING id`,
        [parseInt(req.params.id)]
    );
    if (!result.rows[0]) return res.status(404).json({ message: 'Category not found' });
    res.json({ message: 'Category deleted' });
});

// ── Sub-categories (KITCHEN › CYLINDER) ──────────────────────
// Keyed by category NAME: predefined categories are not rows, and expenses
// store the category as text, so a foreign key has nothing to point at.
const cleanName = (value) => String(value || '').trim().toUpperCase();
const idParam = (req) => {
    const id = parseInt(req.params.id, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
};

export const listExpenseSubCategories = asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, category, name FROM expense_sub_categories ORDER BY category, name`
    );
    res.json({ sub_categories: rows });
});

export const createExpenseSubCategory = asyncHandler(async (req, res) => {
    const category = cleanName(req.body.category);
    const name = cleanName(req.body.name);
    if (!category || !name) return res.status(400).json({ message: 'Category and sub-category name are required' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO expense_sub_categories (category, name) VALUES ($1, $2) RETURNING id, category, name`,
            [category, name]
        );
        res.status(201).json({ sub_category: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: `${name} already exists under ${category}` });
        throw err;
    }
});

export const updateExpenseSubCategory = asyncHandler(async (req, res) => {
    const id = idParam(req);
    const name = cleanName(req.body.name);
    if (!id) return res.status(400).json({ message: 'A valid sub-category id is required' });
    if (!name) return res.status(400).json({ message: 'Sub-category name is required' });
    try {
        const { rows } = await pool.query(
            `UPDATE expense_sub_categories SET name = $2 WHERE id = $1 RETURNING id, category, name`,
            [id, name]
        );
        if (!rows[0]) return res.status(404).json({ message: 'Sub-category not found' });
        res.json({ sub_category: rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: `${name} already exists under this category` });
        throw err;
    }
});

export const deleteExpenseSubCategory = asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(400).json({ message: 'A valid sub-category id is required' });
    const { rows } = await pool.query(`DELETE FROM expense_sub_categories WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return res.status(404).json({ message: 'Sub-category not found' });
    res.json({ message: 'Sub-category deleted' });
});
