"use strict";

const { randomUUID } = require("node:crypto");

module.exports = function v4() {
  return randomUUID();
};
