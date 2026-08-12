"use strict";

const protobuf = require("protobufjs");
const { installProtobufV5Compatibility } = require("./protobuf-v5-compat.cjs");
const definitions = require("../anylist-js/lib/definitions.json");

installProtobufV5Compatibility(protobuf, definitions);

module.exports = require("../anylist-js/lib/index.js");
