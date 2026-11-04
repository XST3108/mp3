const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  ApiError, isObjectId, isPlainObject, send, wrap, parseSelect, parseListQuery, runListQuery, toQueryError
} = require('./helpers');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function requiredString(body, key, label) {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    throw new ApiError(400, `${label} is required`);
  }
  if (typeof v !== 'string') throw new ApiError(400, `${label} must be a string`);
  return v;
}

// Validate format/values of a user body (400 errors only; no DB access).
function validateUserBody(rawBody) {
  const body = isPlainObject(rawBody) ? rawBody : {};
  const name = requiredString(body, 'name', 'User name');
  const email = requiredString(body, 'email', 'User email');
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'User email is not a valid email address');

  let pending = body.pendingTasks;
  if (pending === undefined || pending === null) pending = [];
  else if (typeof pending === 'string') pending = pending === '' ? [] : [pending];
  if (!Array.isArray(pending)) throw new ApiError(400, 'pendingTasks must be an array of task ids');
  for (const id of pending) {
    if (typeof id !== 'string') throw new ApiError(400, 'pendingTasks must be an array of task ids');
    if (!isObjectId(id)) throw new ApiError(400, `"${id}" in pendingTasks is not a valid task id`);
  }
  pending = [...new Set(pending.map((id) => id.toLowerCase()))];
  return { name, email, pendingTasks: pending };
}

// Shared by POST (existing = null) and PUT. Validates everything before writing.
async function saveUser(rawBody, existing) {
  const data = validateUserBody(rawBody);

  const dupQuery = { email: data.email };
  if (existing) dupQuery._id = { $ne: existing._id };
  if (await User.exists(dupQuery)) throw new ApiError(400, 'A user with this email already exists');

  const tasks = await Task.find({ _id: { $in: data.pendingTasks } });
  if (tasks.length !== data.pendingTasks.length) {
    throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');
  }
  if (tasks.some((t) => t.completed)) {
    throw new ApiError(400, 'pendingTasks cannot contain a completed task');
  }

  // --- all checks passed: write ---
  const user = existing || new User();
  const userId = user._id.toString();
  user.name = data.name;
  user.email = data.email;
  user.pendingTasks = data.pendingTasks;
  await user.save();

  // Pending tasks of this user that are no longer in the list -> unassigned.
  await Task.updateMany(
    { assignedUser: userId, completed: false, _id: { $nin: data.pendingTasks } },
    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
  );
  // Tasks still assigned to this user (incl. completed) get the current name.
  await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: data.name } });
  if (data.pendingTasks.length) {
    // Tasks moving from another user.
    await User.updateMany(
      { _id: { $ne: user._id }, pendingTasks: { $in: data.pendingTasks } },
      { $pull: { pendingTasks: { $in: data.pendingTasks } } }
    );
    await Task.updateMany(
      { _id: { $in: data.pendingTasks } },
      { $set: { assignedUser: userId, assignedUserName: data.name } }
    );
  }
  return user;
}

async function findUserOr404(id) {
  const user = isObjectId(id) ? await User.findById(id) : null;
  if (!user) throw new ApiError(404, 'User not found');
  return user;
}

router.get('/', wrap(async (req, res) => {
  const q = parseListQuery(req.query);
  const data = await runListQuery(User, q, undefined);
  send(res, 200, 'OK', data);
}));

router.post('/', wrap(async (req, res) => {
  const user = await saveUser(req.body, null);
  send(res, 201, 'User created', user);
}));

router.get('/:id', wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) throw new ApiError(404, 'User not found');
  const select = parseSelect(req.query);
  let user;
  try {
    user = await User.findById(req.params.id).select(select || {});
  } catch (err) {
    throw toQueryError(err);
  }
  if (!user) throw new ApiError(404, 'User not found');
  send(res, 200, 'OK', user);
}));

router.put('/:id', wrap(async (req, res) => {
  const existing = await findUserOr404(req.params.id);
  const user = await saveUser(req.body, existing);
  send(res, 200, 'User updated', user);
}));

router.delete('/:id', wrap(async (req, res) => {
  const user = await findUserOr404(req.params.id);
  const userId = user._id.toString();
  await User.deleteOne({ _id: user._id });
  await Task.updateMany(
    { $or: [{ assignedUser: userId }, { _id: { $in: user.pendingTasks } }] },
    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
  );
  send(res, 204);
}));

module.exports = router;
