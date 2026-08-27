const errorMiddleware = (err, req, res, next) => {
  console.error(err.stack);
  const statusCode = Number(err.statusCode)
    || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'The uploaded file exceeds the 10 MB limit.'
    : (statusCode < 500 ? err.message : 'Something went wrong with it');
  res.status(statusCode).json({ message, code: err.code || 'INTERNAL_ERROR' });
};

export default errorMiddleware;
