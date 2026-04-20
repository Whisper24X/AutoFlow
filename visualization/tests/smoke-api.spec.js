const { test, expect } = require("@playwright/test");

test.describe("step5 minimum gate - API smoke", () => {
  test("health endpoint is reachable and shaped", async ({ request }) => {
    const resp = await request.get("/api/health");
    expect(resp.status()).toBe(200);

    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("compose2-loop-platform");
    expect(typeof body.time).toBe("string");
  });

  test("orders API supports create-read-update-delete", async ({ request }) => {
    const createResp = await request.post("/api/orders", {
      data: { customerName: "Step5 Smoke", amount: 99.5, status: "pending", note: "demo" }
    });
    expect(createResp.status()).toBe(201);
    const created = await createResp.json();
    const orderId = created?.order?.id;
    expect(orderId).toBeTruthy();

    const getResp = await request.get(`/api/orders/${orderId}`);
    expect(getResp.status()).toBe(200);
    const got = await getResp.json();
    expect(got.order.customerName).toBe("Step5 Smoke");
    expect(got.order.status).toBe("pending");

    const updateResp = await request.put(`/api/orders/${orderId}`, {
      data: { customerName: "Step5 Smoke", amount: 120, status: "paid", note: "updated" }
    });
    expect(updateResp.status()).toBe(200);
    const updated = await updateResp.json();
    expect(updated.order.status).toBe("paid");
    expect(updated.order.amount).toBe(120);

    const deleteResp = await request.delete(`/api/orders/${orderId}`);
    expect(deleteResp.status()).toBe(204);

    const getAfterDelete = await request.get(`/api/orders/${orderId}`);
    expect(getAfterDelete.status()).toBe(404);
  });
});
