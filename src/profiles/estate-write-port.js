import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sourceId, exactName, boundedText, calendarDate, dayInScope, digest } from './estate-write-policy.js';
import { CapabilityError } from '../stable/errors.js';
const require = createRequire(import.meta.url);
const List = require('../../anylist-js/lib/list.js');
const Event = require('../../anylist-js/lib/meal-planning-calendar-event.js');
const quantity = z.number().int().min(1).max(99);
const shoppingFields = { name: exactName, quantity, note: boundedText(2000) };
const mealFields = { date: calendarDate, title: exactName, details: boundedText(2000), label_id: sourceId.nullable() };
const schemas = {
  'shopping.add': z.object({ name: exactName, quantity: quantity.default(1), note: boundedText(2000).default('') }).strict(),
  'shopping.update': z.object({ name: shoppingFields.name.optional(), quantity: quantity.optional(), note: shoppingFields.note.optional() }).strict().refine(value => Object.keys(value).length > 0),
  'shopping.check': z.object({}).strict(), 'shopping.uncheck': z.object({}).strict(), 'shopping.remove': z.object({}).strict(),
  'meal.create': z.object({ date: calendarDate, title: exactName, details: boundedText(2000).default(''), label_id: sourceId.nullable().default(null) }).strict(),
  'meal.update': z.object(Object.fromEntries(Object.entries(mealFields).map(([key, schema]) => [key, schema.optional()]))).strict().refine(value => Object.keys(value).length > 0),
  'meal.delete': z.object({}).strict(),
};
const creates = operation => ['shopping.add', 'meal.create'].includes(operation);
function demand(condition, code = 'INVALID_SNAPSHOT') {
  if (!condition) throw new CapabilityError(code, 'The bounded source state or request is unavailable.');
}
function validRows(rows) {
  demand(Array.isArray(rows) && rows.length <= 10000);
  const ids = new Set();
  for (const row of rows) { sourceId.parse(row?.identifier); demand(!ids.has(row.identifier)); ids.add(row.identifier); }
}
function bounded(value) { demand(Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, 'RESPONSE_LIMIT'); return value; }
const collision = name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
function itemView(policy, item) {
  const amount = item.quantityPb?.amount ?? item.deprecatedQuantity ?? item.quantity ?? '';
  demand(typeof amount === 'string' || typeof amount === 'number' && Number.isFinite(amount));
  return { exists: true, id: sourceId.parse(item.identifier), list_id: policy.listId,
    name: boundedText(4096).parse(item.name), quantity: boundedText(1000).parse(String(amount)),
    note: boundedText(16000).parse(item.details ?? ''), checked: z.boolean().parse(item.checked) };
}
function eventView(event) {
  return { exists: true, id: sourceId.parse(event.identifier), date: calendarDate.parse(event.date),
    title: boundedText(4096).parse(event.title ?? ''), details: boundedText(16000).parse(event.details ?? ''),
    label_id: event.labelId == null || event.labelId === '' ? null : sourceId.parse(event.labelId),
    recipe_id: event.recipeId == null || event.recipeId === '' ? null : sourceId.parse(event.recipeId) };
}
export class WritePort {
  constructor(client) { this.client = client; }
  validate(value, policy) {
    demand(Object.hasOwn(schemas, value.operation) && policy.operations.includes(value.operation), 'SCOPE_DENIED');
    if (value.record_id !== undefined) sourceId.parse(value.record_id);
    if (value.action === 'inspect') {
      demand(creates(value.operation) || value.record_id !== undefined, 'INVALID_INPUT');
      return value;
    }
    demand(creates(value.operation) ? value.record_id === undefined : value.record_id !== undefined, 'INVALID_INPUT');
    return { ...value, fields: schemas[value.operation].parse(value.fields) };
  }
  async load(policy) {
    demand(this.client._oneShotWrites === true, 'DEDICATED_WRITE_SESSION_REQUIRED');
    await this.client.ensureAuthenticated({ safeDiagnostics: true });
    const raw = this.client.client;
    demand(raw.uid === policy.upstreamUserId, 'SOURCE_IDENTITY_CHANGED');
    // Refresh authentication before the journal dispatch boundary. Data POSTs
    // themselves have no transparent retry or authentication replay hook.
    if (typeof this.client.refreshWriteAuthentication === 'function') await this.client.refreshWriteAuthentication();
    else if (typeof raw._refreshTokens === 'function') await raw._refreshTokens();
    demand(raw.uid === policy.upstreamUserId, 'SOURCE_IDENTITY_CHANGED');
    const snapshot = await raw._getUserData(true);
    this.raw = raw;
    if (policy.kind === 'shopping') {
      const lists = snapshot?.shoppingListsResponse?.newLists;
      demand(Array.isArray(lists));
      const matches = lists.filter(list => list.identifier === policy.listId);
      demand(matches.length === 1, 'SCOPE_DENIED');
      const list = matches[0]; validRows(list.items);
      demand(list.items.every(item => item.listId === undefined || item.listId === policy.listId));
      this.rows = bounded(list.items.map(item => itemView(policy, item))).sort((a, b) => a.id.localeCompare(b.id));
      this.list = new List({ ...list, items: list.items.map(item => ({ ...item, listId: policy.listId })) },
        { client: raw.client, protobuf: raw.protobuf, uid: raw.uid, stores: [] });
    } else {
      const calendar = snapshot?.mealPlanningCalendarResponse;
      validRows(calendar?.events); validRows(calendar?.labels);
      this.calendarId = sourceId.parse(calendar.calendarId ?? raw.calendarId);
      this.rawEvents = new Map(calendar.events.map(event => [event.identifier, event]));
      this.rows = bounded(calendar.events.map(eventView)).sort((a, b) => a.id.localeCompare(b.id));
      this.labels = new Set(calendar.labels.map(label => label.identifier));
    }
  }
  view(policy, value) {
    if (value.record_id !== undefined) {
      const row = this.rows.find(item => item.id === value.record_id);
      if (policy.kind === 'meal' && row) {
        demand(dayInScope(policy, row.date), 'DATE_OUT_OF_SCOPE');
        demand(row.label_id === null || policy.labelIds.includes(row.label_id), 'LABEL_OUT_OF_SCOPE');
      }
      if (row && value.operation === 'meal.update') {
        const raw = this.rawEvents.get(row.id);
        const protectedOrder = Object.fromEntries(['labelSortIndex', 'orderAddedSortIndex'].map(key => {
          const value = raw[key] ?? null;
          demand(value === null || typeof value === 'number' && Number.isFinite(value));
          return [key, value];
        }));
        return { ...row, preserved_order_digest: digest(protectedOrder) };
      }
      return row ?? { exists: false, id: value.record_id };
    }
    const rows = policy.kind === 'meal' ? this.rows.filter(row => dayInScope(policy, row.date) && (row.label_id === null || policy.labelIds.includes(row.label_id))) : this.rows;
    return { exists: false, id: null, ...(policy.kind === 'shopping' ? { list_id: policy.listId } : {}), source_digest: digest(rows) };
  }
  async inspect(policy, value) { await this.load(policy); return this.view(policy, value); }
  async prepare(policy, value) {
    await this.load(policy);
    const before = this.view(policy, value), fields = value.fields;
    const recordId = creates(value.operation) ? randomUUID().replaceAll('-', '') : value.record_id;
    if (!creates(value.operation)) demand(before.exists, 'RECORD_NOT_FOUND');
    let after;
    if (policy.kind === 'shopping') {
      if (value.operation === 'shopping.add' || fields.name !== undefined) {
        demand(!this.rows.some(row => !row.checked && row.id !== recordId
          && collision(row.name) === collision(fields.name)), 'NAME_CONFLICT');
      }
      if (value.operation === 'shopping.add') after = { exists: true, id: recordId, list_id: policy.listId,
        name: fields.name, quantity: String(fields.quantity), note: fields.note, checked: false };
      else if (value.operation === 'shopping.remove') after = { exists: false, id: recordId };
      else after = { ...before, ...Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, key === 'quantity' ? String(item) : item])),
        ...(['shopping.check', 'shopping.uncheck'].includes(value.operation) ? { checked: value.operation === 'shopping.check' } : {}) };
    } else {
      if (fields.date !== undefined) demand(dayInScope(policy, fields.date), 'DATE_OUT_OF_SCOPE');
      if (fields.label_id != null) demand(policy.labelIds.includes(fields.label_id) && this.labels.has(fields.label_id), 'LABEL_OUT_OF_SCOPE');
      if (value.operation === 'meal.create') after = { exists: true, id: recordId, date: fields.date,
        title: fields.title, details: fields.details, label_id: fields.label_id, recipe_id: null };
      else if (value.operation === 'meal.delete') after = { exists: false, id: recordId };
      else after = { ...before, ...fields };
    }
    return { record_id: recordId, before, after };
  }
  async dispatch(policy, command, evidence) {
    const id = evidence.record_id, fields = command.fields;
    if (policy.kind === 'shopping') {
      if (command.operation === 'shopping.add') {
        const item = this.raw.createItem({ identifier: id, name: fields.name, quantity: fields.quantity,
          details: fields.note, checked: false });
        demand(item.identifier === id, 'INVALID_SOURCE_ID');
        await this.list.addItem(item);
      } else {
        const item = this.list.items.find(item => item.identifier === id); demand(item, 'RECORD_NOT_FOUND');
        if (command.operation === 'shopping.remove') await this.list.removeItem(item);
        else {
          if (command.operation === 'shopping.check' || command.operation === 'shopping.uncheck') item.checked = command.operation === 'shopping.check';
          if (fields.name !== undefined) item.name = fields.name;
          if (fields.quantity !== undefined) item.quantity = fields.quantity;
          if (fields.note !== undefined) item.details = fields.note;
          await item.save();
        }
      }
    } else {
      const existing = this.rawEvents.get(id);
      const event = new Event(command.operation === 'meal.create' ? { date: new Date(fields.date + 'T12:00:00') }
        : { ...existing, date: new Date(existing.date + 'T12:00:00') },
      { client: this.raw.client, protobuf: this.raw.protobuf, uid: this.raw.uid, calendarId: this.calendarId });
      if (command.operation === 'meal.create') event.identifier = id;
      else event.labelSortIndex = existing.labelSortIndex;
      if (command.operation === 'meal.delete') await event.delete();
      else {
        if (fields.date !== undefined) event.date = new Date(fields.date + 'T12:00:00');
        if (fields.title !== undefined) event.title = fields.title;
        if (fields.details !== undefined) event.details = fields.details;
        if (fields.label_id !== undefined) event.labelId = fields.label_id;
        await event.save();
      }
    }
  }
  async observe(policy, command, evidence) {
    await this.load(policy);
    return this.view(policy, { ...command, record_id: evidence.record_id });
  }
}
