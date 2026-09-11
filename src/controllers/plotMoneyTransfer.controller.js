import asyncHandler from '../utils/asyncHandler.js';

// Historic plot_money_transfers and their protections remain intact. New
// transfers require the same reviewed paired-entry plan as every other module.
export const transferPlotMoney = asyncHandler(async (req, res) => {
  res.status(410).json({
    message: 'Use Transfer Entry to preview and post a balanced transfer.',
    code: 'UNIFIED_TRANSFER_REQUIRED',
    transfer_endpoint: '/transaction-transfers',
  });
});
