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

    // Check duplicate
    const existing = await expenseCategoryModel.findByName(trimmed, pool);
    if (existing) {
        return res.status(409).json({ message: 'Category already exists' });
    }

    const category = await expenseCategoryModel.create({
        name: trimmed,
        icon: icon || 'Tag',
        color: color || 'slate',
        grp: grp || 'Custom',
    }, pool);

    res.status(201).json({ category });
});

export const updateExpenseCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await expenseCategoryModel.findById(parseInt(id), pool);
    if (!existing) return res.status(404).json({ message: 'Category not found' });

    const { name, icon, color, grp } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim().toUpperCase();
    if (icon !== undefined) data.icon = icon;
    if (color !== undefined) data.color = color;
    if (grp !== undefined) data.grp = grp;

    const updated = await expenseCategoryModel.update(parseInt(id), data, pool);
    res.json({ category: updated });
});

export const deleteExpenseCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await expenseCategoryModel.findById(parseInt(id), pool);
    if (!existing) return res.status(404).json({ message: 'Category not found' });

    await expenseCategoryModel.delete(parseInt(id), pool);
    res.json({ message: 'Category deleted' });
});
