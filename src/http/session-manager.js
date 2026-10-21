import AnyListClient from "../anylist-client.js";
import { getAnyListCredentials } from "./db.js";

const IDLE_TIMEOUT_MS =
  (parseInt(process.env.ANYLIST_SESSION_IDLE_MINUTES, 10) || 30) * 60 * 1000;

// Map of userId → { client: AnyListClient, timer: NodeJS.Timeout }
const sessions = new Map();

/**
 * Get or create an AnyListClient for a user, keeping the connection alive.
 * On first call for a user, loads credentials from the DB and connects.
 * Resets the idle timer on each call.
 *
 * @param {string} userId
 * @returns {Promise<AnyListClient>}
 */
export async function getOrCreateSession(userId, {snapshotOnly=false} = {}) {
  // Snapshot readers never inherit a legacy client with a background listener.
  const key=JSON.stringify([userId,snapshotOnly === true]);
  if (sessions.has(key)) {
    const session = sessions.get(key);
    resetIdleTimer(key, session);
    return session.client;
  }

  const creds = getAnyListCredentials(userId);
  if (!creds) {
    throw new Error("No AnyList credentials configured for this user. Complete setup first.");
  }

  const client = new AnyListClient({
    username: creds.username,
    password: creds.password,
    defaultListName: creds.defaultListName,
    snapshotOnly: snapshotOnly === true,
  });

  const session = { client, timer: null };
  sessions.set(key, session);
  resetIdleTimer(key, session);

  return client;
}

/**
 * Evict a user's session immediately (e.g. after credential change).
 */
export function evictSession(userId) {
  for (const snapshotOnly of [false,true]) {
    const key=JSON.stringify([userId,snapshotOnly]);
    const session=sessions.get(key);
    if(session){clearTimeout(session.timer);sessions.delete(key);}
  }
}

function resetIdleTimer(userId, session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    sessions.delete(userId);
  }, IDLE_TIMEOUT_MS);
}
