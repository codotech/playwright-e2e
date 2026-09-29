import { expect, test } from "@playwright/test";

interface EchoResponse {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | null>;
  body: unknown;
}

test(
  "echoes forwarded runtime values without exposing unlisted workflow variables",
  { tag: ["@smoke", "@regression"] },
  async ({ request }): Promise<void> => {
    const requestBody =
      await test.step("Arrange: Read runtime values inside the test container", () => ({
        token: process.env.DEMO_RUNTIME_TOKEN ?? null,
        message: process.env.DEMO_RUNTIME_MESSAGE ?? null,
        unlisted: process.env.DEMO_UNLISTED_TOKEN ?? null,
      }));

    const response =
      await test.step("Act: Send the runtime values to the echo server", () =>
        request.post("/echo", { data: requestBody }));

    await test.step("Assert: The server echoes both forwarded values and no unlisted value", async () => {
      expect(response.status(), "The echo request should succeed").toBe(200);
      await expect(
        response.json(),
        "Only allowlisted runtime values should reach the test container",
      ).resolves.toMatchObject({
        method: "POST",
        path: "/echo",
        body: {
          token: "synthetic-token-not-a-secret",
          message:
            'hello from the workflow\nspaces, "quotes", $dollar and = survive',
          unlisted: null,
        },
      });
    });
  },
);

test(
  "reports that the SUT is healthy",
  { tag: "@smoke" },
  async ({ request }): Promise<void> => {
    const response = await request.get("/health");

    expect(response.ok()).toBe(true);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  },
);

test(
  "echoes a GET request",
  { tag: "@smoke" },
  async ({ request }): Promise<void> => {
    const response = await request.get("/echo", {
      params: { message: "hello from Playwright" },
      headers: { "x-unused-demonstration-header": "test" },
    });
    const payload = (await response.json()) as EchoResponse;

    expect(response.ok()).toBe(true);
    expect(payload).toMatchObject({
      method: "GET",
      path: "/echo",
      query: { message: "hello from Playwright" },
      body: null,
    });
    expect(payload.headers.accept).toBe("*/*");
  },
);

test(
  "echoes a POST request with a JSON body",
  { tag: "@regression" },
  async ({ request }): Promise<void> => {
    const requestBody = {
      message: "hello from a real process boundary",
      sequence: 42,
    };
    const response = await request.post("/echo", { data: requestBody });
    const payload = (await response.json()) as EchoResponse;

    expect(response.ok()).toBe(true);
    expect(payload).toMatchObject({
      method: "POST",
      path: "/echo",
      query: {},
      body: requestBody,
    });
    expect(payload.headers["content-type"]).toContain("application/json");
  },
);
