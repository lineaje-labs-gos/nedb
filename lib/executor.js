/**
 * Responsible for sequentially executing actions on the database
 */

var async = require('async')
  ;

    // JS BUILTINS to be blocked 
  const JS_BUILTINS = ['__proto__', 'constructor', 'prototype'];
  const DANGEROUS_RE = new RegExp(`^(?:${JS_BUILTINS.join('|')})$`, 'i');

function Executor () {
  this.buffer = [];
  this.ready = false;

  // This queue will execute all commands, one-by-one in order
  this.queue = async.queue(function (task, cb) {
    var newArguments = [];

    // task.arguments is an array-like object on which adding a new field doesn't work, so we transform it into a real array
    for (var i = 0; i < task.arguments.length; i += 1) { newArguments.push(task.arguments[i]); }
    var lastArg = task.arguments[task.arguments.length - 1];

    // Always tell the queue task is complete. Execute callback if any was given.
    if (typeof lastArg === 'function') {
      // Callback was supplied
      newArguments[newArguments.length - 1] = function () {
        if (typeof setImmediate === 'function') {
           setImmediate(cb);
        } else {
          process.nextTick(cb);
        }
        lastArg.apply(null, arguments);
      };
    } else if (!lastArg && task.arguments.length !== 0) {
      // false/undefined/null supplied as callbback
      newArguments[newArguments.length - 1] = function () { cb(); };
    } else {
      // Nothing supplied as callback
      newArguments.push(function () { cb(); });
    }


    task.fn.apply(task.this, newArguments);
  }, 1);
}


/** Decode \uXXXX and percent-encoded sequences */
function normalizeKeyString(key) {
  if (typeof key !== 'string') return key;
  try { key = decodeURIComponent(key); } catch (_) {}
  key = key.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  key = key.replace(/[\u0000-\u001F\u007F\u200B-\u200F\uFEFF]/g, ''); // remove control/invisible chars
  return key.trim();
}

/** Split dotted or bracket path notations into individual segments */
function splitPathSegments(key) {
  const segments = [];
  let buf = '', inBracket = false, inQuote = false, quoteChar = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (!inBracket && !inQuote && ch === '.') {
      if (buf) { segments.push(buf); buf = ''; }
      continue;
    }
    if (!inQuote && ch === '[') { inBracket = true; continue; }
    if (inBracket && !inQuote && (ch === `"` || ch === `'`)) { inQuote = true; quoteChar = ch; continue; }
    if (inQuote && ch === quoteChar) { inQuote = false; continue; }
    if (inBracket && !inQuote && ch === ']') { inBracket = false; if (buf) { segments.push(buf); buf = ''; } continue; }
    buf += ch;
  }
  if (buf) segments.push(buf);
  return segments.map(normalizeKeyString);
}

/** Core check: true if a key or any of its segments is unsafe */
function isUnsafeKey(key) {
  const norm = normalizeKeyString(key);
  const allSegments = norm.split('.').concat(splitPathSegments(norm));
  return allSegments.some(seg => DANGEROUS_RE.test(seg));
}

/**
 * Main sanitizer – recursively walk an object/array and throw on unsafe keys.
 */
function sanitizeQuery(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (isUnsafeKey(key)) {
      const message = `Unsafe key detected in update: "${fullPath}"`
      throw new Error(message);
    }
    const val = obj[key];
    if (val && typeof val === 'object') {
      sanitizeQuery(val, fullPath);
    }
  }
}

/**
 * If executor is ready, queue task (and process it immediately if executor was idle)
 * If not, buffer task for later processing
 * @param {Object} task
 *                 task.this - Object to use as this
 *                 task.fn - Function to execute
 *                 task.arguments - Array of arguments, IMPORTANT: only the last argument may be a function (the callback)
 *                                                                 and the last argument cannot be false/undefined/null
 * @param {Boolean} forceQueuing Optional (defaults to false) force executor to queue task even if it is not ready
 */
Executor.prototype.push = function (task, forceQueuing) {
    try {
    // Convert arguments-like object into real array
    const args = Array.from(task.arguments || []);

    // Sanitize any object arguments before executing the task
    for (const arg of args) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        sanitizeQuery(arg);
      }
    }
  } catch (err) {
    console.error('Unsafe query detected:', err.message);
    // Find callback (last argument) if present
    const cb = typeof task.arguments[task.arguments.length - 1] === 'function'
      ? task.arguments[task.arguments.length - 1]
      : null;
    if (cb) return cb(err);
    throw err;
  }
  if (this.ready || forceQueuing) {
    this.queue.push(task);
  } else {
    this.buffer.push(task);
  }
};


/**
 * Queue all tasks in buffer (in the same order they came in)
 * Automatically sets executor as ready
 */
Executor.prototype.processBuffer = function () {
  var i;
  this.ready = true;
  for (i = 0; i < this.buffer.length; i += 1) { this.queue.push(this.buffer[i]); }
  this.buffer = [];
};



// Interface
module.exports = Executor;
