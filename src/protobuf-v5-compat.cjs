"use strict";

const namespaceCache = new WeakMap();
const PROTO_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertName(name, kind) {
  if (typeof name !== "string" || !PROTO_NAME.test(name)) {
    throw new TypeError(`Invalid ${kind} name in bundled protobuf schema`);
  }
}

function enumDescriptor(definition) {
  assertName(definition?.name, "enum");
  if (!Array.isArray(definition.values)) {
    throw new TypeError(`Enum ${definition.name} has no values`);
  }

  const values = Object.create(null);
  for (const value of definition.values) {
    assertName(value?.name, "enum value");
    if (!Number.isInteger(value.id)) {
      throw new TypeError(`Enum ${definition.name}.${value.name} has an invalid id`);
    }
    values[value.name] = value.id;
  }

  return { edition: "proto2", values };
}

function fieldDescriptor(field, messageName) {
  assertName(field?.name, "field");
  if (typeof field.type !== "string" || !Number.isInteger(field.id)) {
    throw new TypeError(`Field ${messageName}.${field.name} is invalid`);
  }

  const descriptor = { id: field.id, type: field.type };
  if (field.rule === "map") {
    if (typeof field.keytype !== "string") {
      throw new TypeError(`Map field ${messageName}.${field.name} has no key type`);
    }
    descriptor.keyType = field.keytype;
  } else if (field.rule) {
    descriptor.rule = field.rule;
  }
  if (field.options) {
    descriptor.options = field.options;
  }
  return descriptor;
}

function messageDescriptor(definition) {
  assertName(definition?.name, "message");
  if (!Array.isArray(definition.fields)) {
    throw new TypeError(`Message ${definition.name} has no fields`);
  }

  const fields = Object.create(null);
  for (const field of definition.fields) {
    fields[field.name] = fieldDescriptor(field, definition.name);
  }

  const descriptor = { edition: "proto2", fields };
  if (definition.enums?.length) {
    descriptor.nested = Object.create(null);
    for (const enumeration of definition.enums) {
      descriptor.nested[enumeration.name] = enumDescriptor(enumeration);
    }
  }
  return descriptor;
}

function reflectionTree(definitions) {
  if (!definitions || typeof definitions !== "object") {
    throw new TypeError("Expected a bundled protobuf schema object");
  }
  if (!Array.isArray(definitions.messages) || !Array.isArray(definitions.enums)) {
    throw new TypeError("Bundled protobuf schema is missing messages or enums");
  }

  const packageParts = definitions.package?.split(".");
  if (!packageParts?.length) {
    throw new TypeError("Bundled protobuf schema has no package name");
  }
  for (const part of packageParts) {
    assertName(part, "package");
  }

  const packageMembers = Object.create(null);
  for (const message of definitions.messages) {
    packageMembers[message.name] = messageDescriptor(message);
  }
  for (const enumeration of definitions.enums) {
    packageMembers[enumeration.name] = enumDescriptor(enumeration);
  }

  let nested = packageMembers;
  for (const part of packageParts.reverse()) {
    const parent = Object.create(null);
    parent[part] = { nested };
    nested = parent;
  }
  return nested;
}

function materializeNamespace(protobuf, namespace) {
  const result = Object.create(null);
  for (const [name, member] of Object.entries(namespace.nested || {})) {
    if (member instanceof protobuf.Type) {
      const Message = member.ctor;
      for (const field of member.fieldsArray) {
        const suffix = field.name[0].toUpperCase() + field.name.slice(1);
        Object.defineProperty(Message.prototype, `get${suffix}`, {
          configurable: false,
          enumerable: false,
          value() {
            return this[field.name];
          },
          writable: false,
        });
        Object.defineProperty(Message.prototype, `set${suffix}`, {
          configurable: false,
          enumerable: false,
          value(value) {
            this[field.name] = field.repeated && !Array.isArray(value) ? [value] : value;
            return this;
          },
          writable: false,
        });
      }
      Object.defineProperty(Message.prototype, "toBuffer", {
        configurable: false,
        enumerable: false,
        value() {
          return Buffer.from(member.encode(this).finish());
        },
        writable: false,
      });
      Object.assign(Message, materializeNamespace(protobuf, member));
      result[name] = Message;
    } else if (member instanceof protobuf.Enum) {
      result[name] = Object.freeze({ ...member.values });
    } else {
      result[name] = materializeNamespace(protobuf, member);
    }
  }
  return result;
}

function buildNamespace(protobuf, definitions, packageName) {
  if (packageName !== definitions.package) {
    throw new Error(`Unknown protobuf package: ${packageName}`);
  }

  let byPackage = namespaceCache.get(definitions);
  if (!byPackage) {
    byPackage = new Map();
    namespaceCache.set(definitions, byPackage);
  }
  if (byPackage.has(packageName)) {
    return byPackage.get(packageName);
  }

  const root = new protobuf.Root();
  root.addJSON(reflectionTree(definitions));
  root.resolveAll();
  const result = materializeNamespace(protobuf, root.lookup(packageName));
  byPackage.set(packageName, result);
  return result;
}

function installProtobufV5Compatibility(protobuf, expectedDefinitions) {
  if (typeof protobuf.newBuilder === "function") {
    return protobuf;
  }
  if (typeof protobuf.Root !== "function" || typeof protobuf.Type !== "function") {
    throw new Error("Unsupported protobufjs runtime");
  }
  if (!expectedDefinitions || typeof expectedDefinitions !== "object") {
    throw new TypeError("Expected the bundled AnyList protobuf schema");
  }

  Object.defineProperty(protobuf, "newBuilder", {
    configurable: false,
    enumerable: false,
    value() {
      let definitions;
      return {
        import(schema) {
          if (schema !== expectedDefinitions) {
            throw new Error("Only the bundled AnyList protobuf schema is allowed");
          }
          definitions = schema;
          return this;
        },
        build(packageName) {
          if (!definitions) {
            throw new Error("No protobuf schema imported");
          }
          return buildNamespace(protobuf, definitions, packageName);
        },
      };
    },
    writable: false,
  });
  return protobuf;
}

module.exports = { installProtobufV5Compatibility };
