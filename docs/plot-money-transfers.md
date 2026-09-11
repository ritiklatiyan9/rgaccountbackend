# Plot entry transfers

New plot transfers use the shared **Transfer Entry** preview and paired-posting workflow documented in [transaction-transfers.md](transaction-transfers.md). It supports plot-to-plot and cross-module transfers, full or partial amounts, and an explicit transfer date while preserving the original receipt.

The former plot-specific POST now returns `410` with `UNIFIED_TRANSFER_REQUIRED`. Existing `plot_money_transfers` audit records and payment protections remain intact. Amounts allocated by that earlier feature are deducted from the source receipt's availability in the shared workflow.
