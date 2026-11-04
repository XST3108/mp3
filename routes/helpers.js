// Shared helpers: errors, response format, query-string parsing.

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v);

function send(res, status, message, data) {
  if (status === 204) return res.status(204).end();
  return res.status(status).json({ message, data: data === undefined ? null : data });
}

// Wrap async route handlers so thrown errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJSONParam(query, key) {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ApiError(400, `Query parameter "${key}" was given more than once or is malformed`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ApiError(400, `Query parameter "${key}" must be valid JSON`);
  }
}

function parseSelect(query) {
  const select = parseJSONParam(query, 'select');
  if (select === undefined) return undefined;
  if (!isPlainObject(select)) throw new ApiError(400, 'Query parameter "select" must be a JSON object, e.g. {"name": 1}');
  for (const [k, v] of Object.entries(select)) {
    if (![0, 1, true, false].includes(v)) {
      throw new ApiError(400, `Invalid select value for "${k}": use 1 to include or 0 to exclude`);
    }
  }
  return select;
}

function parseNonNegativeInt(query, key) {
  const parsed = parseJSONParam(query, key);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(400, `Query parameter "${key}" must be a non-negative integer`);
  }
  return parsed;
}

// Parse where/sort/select/skip/limit/count for collection endpoints.
function parseListQuery(query) {
  const where = parseJSONParam(query, 'where');
  if (where !== undefined && !isPlainObject(where)) {
    throw new ApiError(400, 'Query parameter "where" must be a JSON object');
  }

  const sort = parseJSONParam(query, 'sort');
  if (sort !== undefined) {
    if (!isPlainObject(sort)) throw new ApiError(400, 'Query parameter "sort" must be a JSON object, e.g. {"name": 1}');
    for (const [k, v] of Object.entries(sort)) {
      if (![1, -1, 'asc', 'desc', 'ascending', 'descending'].includes(v)) {
        throw new ApiError(400, `Invalid sort value for "${k}": use 1 (ascending) or -1 (descending)`);
      }
    }
  }

  const select = parseSelect(query);
  const skip = parseNonNegativeInt(query, 'skip');
  const limit = parseNonNegativeInt(query, 'limit');

  let count = false;
  const c = parseJSONParam(query, 'count');
  if (c !== undefined) {
    if (c !== true && c !== false) throw new ApiError(400, 'Query parameter "count" must be true or false');
    count = c;
  }

  return { where: where || {}, sort, select, skip, limit, count };
}

// Run a collection query built from client-supplied parameters with Mongoose methods.
async function runListQuery(Model, q, defaultLimit) {
  try {
    if (q.count) {
      const opts = {};
      if (q.skip !== undefined) opts.skip = q.skip;
      if (q.limit !== undefined && q.limit > 0) opts.limit = q.limit;
      return await Model.countDocuments(q.where, opts);
    }
    let query = Model.find(q.where);
    if (q.sort) query = query.sort(q.sort);
    if (q.select) query = query.select(q.select);
    if (q.skip !== undefined) query = query.skip(q.skip);
    const limit = q.limit !== undefined ? q.limit : defaultLimit;
    if (limit !== undefined) query = query.limit(limit);
    return await query.exec();
  } catch (err) {
    throw toQueryError(err);
  }
}

// Errors caused by a bad client query (bad cast, bad operator, mixed projection) -> 400.
function toQueryError(err) {
  if (err instanceof ApiError) return err;
  if (['CastError', 'StrictModeError', 'MongoServerError', 'ObjectParameterError'].includes(err.name)) {
    return new ApiError(400, 'Invalid query: one of the where/sort/select values could not be applied');
  }
  return err;
}

module.exports = {
  ApiError,
  isObjectId,
  isPlainObject,
  send,
  wrap,
  parseSelect,
  parseListQuery,
  runListQuery,
  toQueryError
};
