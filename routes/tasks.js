const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const {
  ApiError, isObjectId, isPlainObject, send, wrap, parseSelect, parseListQuery, runListQuery, toQueryError
} = require('./helpers');

const router = express.Router();

function parseDeadline(v) {
  if (v === undefined || v === null || v === '') throw new ApiError(400, 'Task deadline is required');
  let d;
  if (typeof v === 'number') d = new Date(v);
  else if (typeof v === 'string') d = /^-?\d+$/.test(v.trim()) ? new Date(Number(v)) : new Date(v);
  else throw new ApiError(400, 'Task deadline must be a date');
  if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Task deadline is not a valid date');
  return d;
}

function parseCompleted(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ApiError(400, 'completed must be true or false');
}

// Validate format/values of a task body (400 errors only; no DB access).
function validateTaskBody(rawBody) {
  const body = isPlainObject(rawBody) ? rawBody : {};

  const name = body.name;
  if (name === undefined || name === null || (typeof name === 'string' && name.trim() === '')) {
    throw new ApiError(400, 'Task name is required');
  }
  if (typeof name !== 'string') throw new ApiError(400, 'Task name must be a string');

  const deadline = parseDeadline(body.deadline);

  let description = body.description;
  if (description === undefined || description === null) description = '';
  if (typeof description !== 'string') throw new ApiError(400, 'Task description must be a string');

  const completed = parseCompleted(body.completed);

  let assignedUser = body.assignedUser;
  if (assignedUser === undefined || assignedUser === null) assignedUser = '';
  if (typeof assignedUser !== 'string') throw new ApiError(400, 'assignedUser must be a user id string');
  if (assignedUser !== '' && !isObjectId(assignedUser)) {
    throw new ApiError(400, 'assignedUser is not a valid user id');
  }
  assignedUser = assignedUser.toLowerCase();

  let assignedUserName = body.assignedUserName;
  if (assignedUserName === null || assignedUserName === '') assignedUserName = undefined;
  if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
    throw new ApiError(400, 'assignedUserName must be a string');
  }
  if (assignedUser === '' && assignedUserName !== undefined && assignedUserName !== 'unassigned') {
    throw new ApiError(400, 'assignedUserName must be "unassigned" when the task has no assignedUser');
  }

  return { name, description, deadline, completed, assignedUser, assignedUserName };
}

// Shared by POST (existing = null) and PUT. Validates everything before writing.
async function saveTask(rawBody, existing) {
  const data = validateTaskBody(rawBody);

  let assignedUserName = 'unassigned';
  if (data.assignedUser) {
    const user = await User.findById(data.assignedUser);
    if (!user) throw new ApiError(404, 'The assigned user does not exist');
    if (data.assignedUserName !== undefined && data.assignedUserName !== user.name) {
      throw new ApiError(400, 'assignedUserName does not match the name of assignedUser');
    }
    assignedUserName = user.name;
  }

  // --- all checks passed: write ---
  const task = existing || new Task();
  const taskId = task._id.toString();
  task.name = data.name;
  task.description = data.description;
  task.deadline = data.deadline;
  task.completed = data.completed;
  task.assignedUser = data.assignedUser;
  task.assignedUserName = assignedUserName;
  await task.save();

  // Remove from every other user's pendingTasks (previous owner, stale refs).
  const others = data.assignedUser ? { _id: { $ne: data.assignedUser }, pendingTasks: taskId } : { pendingTasks: taskId };
  await User.updateMany(others, { $pull: { pendingTasks: taskId } });

  if (data.assignedUser) {
    const update = data.completed ? { $pull: { pendingTasks: taskId } } : { $addToSet: { pendingTasks: taskId } };
    await User.updateOne({ _id: data.assignedUser }, update);
  }
  return task;
}

async function findTaskOr404(id) {
  const task = isObjectId(id) ? await Task.findById(id) : null;
  if (!task) throw new ApiError(404, 'Task not found');
  return task;
}

router.get('/', wrap(async (req, res) => {
  const q = parseListQuery(req.query);
  const data = await runListQuery(Task, q, 100);
  send(res, 200, 'OK', data);
}));

router.post('/', wrap(async (req, res) => {
  const task = await saveTask(req.body, null);
  send(res, 201, 'Task created', task);
}));

router.get('/:id', wrap(async (req, res) => {
  if (!isObjectId(req.params.id)) throw new ApiError(404, 'Task not found');
  const select = parseSelect(req.query);
  let task;
  try {
    task = await Task.findById(req.params.id).select(select || {});
  } catch (err) {
    throw toQueryError(err);
  }
  if (!task) throw new ApiError(404, 'Task not found');
  send(res, 200, 'OK', task);
}));

router.put('/:id', wrap(async (req, res) => {
  const existing = await findTaskOr404(req.params.id);
  const task = await saveTask(req.body, existing);
  send(res, 200, 'Task updated', task);
}));

router.delete('/:id', wrap(async (req, res) => {
  const task = await findTaskOr404(req.params.id);
  const taskId = task._id.toString();
  await Task.deleteOne({ _id: task._id });
  await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
  send(res, 204);
}));

module.exports = router;
