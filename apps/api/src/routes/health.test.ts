import { describe, expect, it } from "vitest";
import request from "supertest";

import { app } from "../app.js";

describe("GET /api/health", () => {
  it("returns 200 with status ok and a non-negative numeric uptime", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(typeof response.body.uptime).toBe("number");
    expect(response.body.uptime).toBeGreaterThanOrEqual(0);
  });
});
