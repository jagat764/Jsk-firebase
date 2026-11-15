/**
 * Minimal Firebase Realtime Database REST client.
 *
 * The panel talks to the REST API instead of the JS SDK on purpose: the
 * database URL is chosen at runtime, no third-party script is loaded into the
 * page, and every read can be bounded (`shallow`, `limitToLast`, `orderBy`).
 */

import { parseDatabaseUrl, restUrl } from "./detect.js";

export class DatabaseError extends Error {
  constructor(message, { status = 0, url = "" } = {}) {
    super(message);
    this.name = "DatabaseError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Normalise and split a connection descriptor.
 * @returns {{base: string, auth: string}|null}
 */
export function connectionFromInput(input) {
  return parseDatabaseUrl(input);
}

async function request(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();

    if (!response.ok) {
      // 401 = auth token required/rejected, 403 = rules denied the read.
      const message =
        response.status === 401
          ? "Permission denied (401). Add the database secret/auth token, or relax the read rules for your own project."
          : response.status === 403
            ? "Access denied (403) by the database security rules."
            : `Database returned HTTP ${response.status}.`;
      throw new DatabaseError(message, { status: response.status, url });
    }

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new DatabaseError("Response was not valid JSON.", { status: response.status, url });
    }
    return { data, bytes: text.length };
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    if (error?.name === "AbortError") {
      throw new DatabaseError(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s. The database may be unreachable.`,
        { url },
      );
    }
    throw new DatabaseError(
      "Network error — the database could not be reached. Check the URL and your connection.",
      { url },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Read a node. Returns { data, bytes }. */
export function readNode(connection, path = "", params = {}, options = {}) {
  const query = { ...params };
  if (connection.auth && query.auth === undefined) query.auth = connection.auth;
  return request(restUrl(connection.base, path, query), options);
}

/** Shallow read: returns { childKey: true } for a node's immediate children. */
export async function readShallow(connection, path = "") {
  const { data } = await readNode(connection, path, { shallow: true });
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

/** Shallow child keys of a node, sorted. */
export async function listKeys(connection, path = "") {
  const shallow = await readShallow(connection, path);
  return Object.keys(shallow).sort();
}

/**
 * Verify a connection works and return the root child keys.
 * Throws DatabaseError with a user-facing message on failure.
 */
export async function probeConnection(connection) {
  const shallow = await readShallow(connection, "");
  const keys = Object.keys(shallow).sort();
  return { keys, empty: keys.length === 0 };
}
