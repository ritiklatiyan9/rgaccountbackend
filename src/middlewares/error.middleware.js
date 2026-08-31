const errorMiddleware = (err, req, res, next) => {
  console.error(err.stack);
  const isInsufficientImprest = err.constraint === 'imprest_sufficient_balance';
  const isMissingImprestOwner = err.constraint === 'imprest_debit_owner_required';
  const isImprestConflict = isInsufficientImprest || isMissingImprestOwner;
  const statusCode = Number(err.statusCode)
    || (err.code === 'LIMIT_FILE_SIZE' ? 413 : isImprestConflict ? 409 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'The uploaded file exceeds the 10 MB limit.'
    : (statusCode < 500 ? err.message : 'Something went wrong with it');
  let imprestDetails = {};
  if (isInsufficientImprest && err.detail) {
    try {
      imprestDetails = JSON.parse(err.detail);
    } catch {
      // PostgreSQL detail is optional; the human-readable message is enough.
    }
  }
  res.status(statusCode).json({
    message,
    code: isInsufficientImprest
      ? 'INSUFFICIENT_IMPREST'
      : isMissingImprestOwner
        ? 'IMPREST_OWNER_REQUIRED'
        : err.code || 'INTERNAL_ERROR',
    ...imprestDetails,
  });
};

export default errorMiddleware;
