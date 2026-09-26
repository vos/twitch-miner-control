export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    // An error body is a courtesy; without one the status says enough.
    const payload = await response.json().catch(() => ({}));
    throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  // A success whose body cannot be read is a failed request, not an empty
  // one: the connection dropped mid-response (ERR_CONTENT_LENGTH_MISMATCH,
  // a backend restarting). Resolving {} would hand callers an object
  // missing every field they expect.
  try {
    return await response.json() as T;
  } catch {
    throw new Error("the response was cut off; try again");
  }
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => send<T>("PUT", path, body),
};
