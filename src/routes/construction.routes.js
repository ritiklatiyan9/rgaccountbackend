import express from 'express';
const router = express.Router();

import {
  listProjects, createProject, getProject, updateProject, deleteProject,
  createLocation, bulkCreateLocations, updateLocation, deleteLocation,
  createTask, updateTask, deleteTask,
  createMaterialRequest, getMaterialRequest, issueMaterialRequest, updateMaterialRequest,
  consumeMaterial, constructionSummary, requireConstructionAccess, assignableUsers, createQuote, updateQuote, selectQuote,
} from '../controllers/construction.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

router.use(authMiddleware);

// Each route resolves authoritative site/project scope before its controller.

// Dashboard summary
router.get('/summary', requirePermission('construction', 'read'), requireConstructionAccess, constructionSummary);

router.get('/workflow-summary', requirePermission('construction','read'), requireConstructionAccess, constructionSummary);
router.get('/assignable-users', requirePermission('construction','read'), requireConstructionAccess, assignableUsers);

// Projects
router.get('/projects', requirePermission('construction', 'read'), requireConstructionAccess, listProjects);
router.post('/projects', requirePermission('construction', 'write'), requireConstructionAccess, createProject);
router.get('/projects/:id', requirePermission('construction', 'read'), requireConstructionAccess, getProject);
router.put('/projects/:id', requirePermission('construction', 'update'), requireConstructionAccess, updateProject);
router.delete('/projects/:id', requirePermission('construction', 'delete'), requireConstructionAccess, deleteProject);

// Reusable project hierarchy for mixed developments.
router.post('/projects/:id/locations', requirePermission('construction', 'write'), requireConstructionAccess, createLocation);
router.post('/projects/:id/locations/bulk', requirePermission('construction', 'write'), requireConstructionAccess, bulkCreateLocations);
router.put('/locations/:locationId', requirePermission('construction', 'update'), requireConstructionAccess, updateLocation);
router.delete('/locations/:locationId', requirePermission('construction', 'delete'), requireConstructionAccess, deleteLocation);

// Quotes are review records; selection creates one canonical vendor commitment.
router.post('/projects/:id/quotes', requirePermission('construction','write'), requireConstructionAccess, createQuote);
router.put('/quotes/:quoteId', requirePermission('construction','update'), requireConstructionAccess, updateQuote);
router.post('/quotes/:quoteId/select', requirePermission('construction','update'), requirePermission('vendors','write'), requireConstructionAccess, selectQuote);

// Tasks (nested create, flat update/delete)
router.post('/projects/:id/tasks', requirePermission('construction', 'write'), requireConstructionAccess, createTask);
router.put('/tasks/:taskId', requirePermission('construction', 'update'), requireConstructionAccess, updateTask);
router.delete('/tasks/:taskId', requirePermission('construction', 'delete'), requireConstructionAccess, deleteTask);

// Material requests + issue flow
router.post('/projects/:id/material-requests', requirePermission('construction', 'write'), requireConstructionAccess, createMaterialRequest);
router.get('/material-requests/:reqId', requirePermission('construction', 'read'), requireConstructionAccess, getMaterialRequest);
router.put('/material-requests/:reqId', requirePermission('construction', 'update'), requireConstructionAccess, updateMaterialRequest);
router.post('/material-requests/:reqId/issue', requirePermission('construction', 'write'), requireConstructionAccess, issueMaterialRequest);

// Consumption (draws stock, feeds actual cost)
router.post('/projects/:id/consume', requirePermission('construction', 'write'), requireConstructionAccess, consumeMaterial);

export default router;
