import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CapabilityError } from '../stable/errors.js';

export const WRITE_CONTRACT = 'estate-household-write.v1';
export const WRITE_PROFILES = Object.freeze({ shopping: 'estate_hub_shopping_writer', meal: 'estate_hub_mealplan_writer' });
export const WRITE_SOURCES = Object.freeze({ shopping: 'estate-household-shopping-writer', meal: 'estate-household-mealplan-writer' });
export const HOUSEHOLD_WRITE_PROFILES = Object.freeze(Object.values(WRITE_PROFILES));
export const OPERATIONS = Object.freeze({
  shopping: ['shopping.add', 'shopping.check', 'shopping.uncheck', 'shopping.update', 'shopping.remove'],
  meal: ['meal.create', 'meal.update', 'meal.delete'],
});
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const result = JSON.stringify(value);
  if (result === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_JSON');
  return result;
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const sourceId = z.string().regex(/^[a-f0-9]{32}$/);
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
export const boundedText = maximum => z.string().max(maximum).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(value));
export const exactName = z.string().min(1).max(128).refine(value => value === value.trim() && !/\p{C}/u.test(value));
const common = { schemaVersion: z.literal(1), clientId: z.string().uuid(), userId: z.string().uuid(),
  upstreamUserId: z.string().min(1).max(256).regex(/^[A-Za-z0-9:_-]+$/),
  enabled: z.boolean(), revision: z.number().int().positive(), journalId: z.string().uuid() };
const schemas = {
  shopping: z.object({ ...common, listId: sourceId, operations: z.array(z.enum(OPERATIONS.shopping)).min(1).max(5) }).strict(),
  meal: z.object({ ...common, operations: z.array(z.enum(OPERATIONS.meal)).min(1).max(3),
    timeZone: z.literal('America/Denver'), maxPastDays: z.number().int().min(0).max(31),
    maxFutureDays: z.number().int().min(0).max(366), labelIds: z.array(sourceId).max(100) }).strict(),
};
export function writeKind(profile) {
  const kind = Object.keys(WRITE_PROFILES).find(key => WRITE_PROFILES[key] === profile);
  if (!kind) throw new CapabilityError('POLICY_UNAVAILABLE', 'Dedicated write policy is unavailable.');
  return kind;
}
export function writePolicyFile(profile) {
  return path.join(process.env.DATA_DIR || '/data', `estate-hub-${writeKind(profile) === 'meal' ? 'mealplan' : 'shopping'}-write-policy.json`);
}
export function assertWriteScope(profile, clientId, userId, source) {
  let fd;
  try {
    const kind = writeKind(profile);
    fd = openSync(writePolicyFile(profile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.nlink !== 1 || info.size > 8192
      || ![0, process.getuid()].includes(info.uid)) throw Error();
    const policy = schemas[kind].parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!policy.enabled || policy.clientId !== clientId || policy.userId !== userId
      || source !== WRITE_SOURCES[kind] || new Set(policy.operations).size !== policy.operations.length) throw Error();
    if (kind === 'meal' && (policy.maxPastDays + policy.maxFutureDays >= 366
      || new Set(policy.labelIds).size !== policy.labelIds.length)) throw Error();
    return { ...policy, kind, policyDigest: digest({ contract: WRITE_CONTRACT, profile, source, ...policy }) };
  } catch { throw new CapabilityError('POLICY_UNAVAILABLE', 'Dedicated write policy is unavailable.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function dayInScope(policy, value, now = new Date()) {
  calendarDate.parse(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: policy.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const field = key => parts.find(part => part.type === key).value;
  const today = `${field('year')}-${field('month')}-${field('day')}`;
  const days = (Date.parse(value + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
  return days >= -policy.maxPastDays && days <= policy.maxFutureDays;
}
