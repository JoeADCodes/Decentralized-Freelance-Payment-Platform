/**
 * The API base URL is build-time configuration, and the difference between an
 * *unset* and an *empty* `VITE_API_URL` is the whole of issue #55: empty means
 * "same origin", which is what lets the containerised app reach the backend
 * through nginx's `/api/` proxy instead of trying to resolve the `backend`
 * service name in the browser.
 *
 * `import.meta.env` is inlined when the module is evaluated, so each case
 * re-imports a fresh copy of the module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Re-evaluate `./api` so it reads the currently stubbed environment. */
async function loadApiModule() {
  vi.resetModules();
  return await import("./api");
}

function stubOkResponse(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API base URL", () => {
  it("falls back to the local backend when VITE_API_URL is unset", async () => {
    vi.unstubAllEnvs();

    const { API_BASE_URL } = await loadApiModule();

    expect(API_BASE_URL).toBe("http://localhost:3000");
  });

  it("treats an empty VITE_API_URL as same-origin, so requests go through nginx", async () => {
    vi.stubEnv("VITE_API_URL", "");

    const { API_BASE_URL, fetchJobs } = await loadApiModule();
    expect(API_BASE_URL).toBe("");

    const fetchMock = stubOkResponse();
    await fetchJobs({ page: 1 });

    // Relative — the browser never sees (and cannot resolve) `backend:3000`.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs?page=1");
  });

  it("uses the configured origin as-is for a hosted deploy", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.com");

    const { fetchJobs } = await loadApiModule();

    const fetchMock = stubOkResponse();
    await fetchJobs();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/jobs");
  });
});
