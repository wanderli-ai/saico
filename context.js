// context.js — backward compatibility shim
// The Context class has moved to msgs.js. This file re-exports for compatibility.
'use strict';
const { Context, createContext } = require('./msgs.js');
module.exports = { Context, createContext };
