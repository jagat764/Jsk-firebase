/** Build a Firebase Realtime Database REST URL for a node read. */
export function databaseReadUrl(databaseUrl, path, { shallow = false } = {}) {
  const database = new URL(String(databaseUrl));
  const auth = database.searchParams.get("auth") || database.searchParams.get("key");
  const base = database.origin + database.pathname.replace(/\/+$/, "");
  const segments = String(path || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  const url = new URL(`${base}/${segments.length ? segments.join("/") : ""}.json`);
  if (shallow) url.searchParams.set("shallow", "true");
  if (auth) url.searchParams.set("auth", auth);
  return url.toString();
}

/** Build a Firebase Realtime Database REST URL for a shallow key read. */
export function shallowReadUrl(databaseUrl, path) {
  return databaseReadUrl(databaseUrl, path, { shallow: true });
}
