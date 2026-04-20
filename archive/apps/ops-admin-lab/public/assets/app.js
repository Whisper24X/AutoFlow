async function getJSON(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

async function postJSON(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function qs(selector) {
  return document.querySelector(selector);
}

function readIdParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id");
}

function formatAmount(value) {
  return `¥${Number(value).toLocaleString("zh-CN")}`;
}

function chipClass(value) {
  return `status-chip status-${String(value).replace(/\s+/g, "-")}`;
}

function setActiveNav(page) {
  const navPageMap = {
    "user-detail": "users",
    "order-detail": "orders"
  };
  const activePage = navPageMap[page] || page;

  document.querySelectorAll("[data-nav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.nav === activePage);
  });
}

function renderOrderRows(orders) {
  if (!orders.length) {
    return '<tr><td colspan="6" class="empty-state">没有匹配的数据</td></tr>';
  }

  return orders
    .map(
      (order) => `
        <tr data-testid="order-row-${order.id}">
          <td><a href="/order-detail.html?id=${order.id}" data-testid="order-link-${order.id}">${order.id}</a></td>
          <td>${order.userName}</td>
          <td><span class="${chipClass(order.status)}">${order.status}</span></td>
          <td>${formatAmount(order.amount)}</td>
          <td>${order.flagged ? '<span class="status-chip status-high">已标记</span>' : "正常"}</td>
          <td>${order.createdAt}</td>
        </tr>
      `
    )
    .join("");
}

function renderUserRows(users) {
  if (!users.length) {
    return '<tr><td colspan="7" class="empty-state">没有匹配的数据</td></tr>';
  }

  return users
    .map(
      (user) => `
        <tr data-testid="user-row-${user.id}">
          <td><a href="/user-detail.html?id=${user.id}" data-testid="user-link-${user.id}">${user.name}</a></td>
          <td>${user.id}</td>
          <td><span class="${chipClass(user.status)}">${user.status}</span></td>
          <td>${user.segment}</td>
          <td>${user.city}</td>
          <td>${user.orderCount}</td>
          <td>${user.watchlist ? '<span class="status-chip status-high">观察中</span>' : "正常"}</td>
        </tr>
      `
    )
    .join("");
}

function renderReviewRows(reviews) {
  if (!reviews.length) {
    return '<tr><td colspan="7" class="empty-state">没有匹配的数据</td></tr>';
  }

  return reviews
    .map(
      (review) => `
        <tr data-testid="review-row-${review.id}">
          <td>${review.title}</td>
          <td>${review.type}</td>
          <td>${review.relatedUserName}</td>
          <td><span class="${chipClass(review.priority)}">${review.priority}</span></td>
          <td><span class="${chipClass(review.status)}" data-testid="review-status-${review.id}">${review.status}</span></td>
          <td>
            ${
              review.type === "order"
                ? `<a href="/order-detail.html?id=${review.targetId}" data-testid="review-target-${review.id}">查看订单</a>`
                : `<a href="/user-detail.html?id=${review.targetId}" data-testid="review-target-${review.id}">查看用户</a>`
            }
          </td>
          <td>
            <button class="button-sm" data-testid="approve-review-${review.id}" ${review.status !== "pending" ? "disabled" : ""}>通过</button>
            <button class="button-secondary button-sm" data-testid="reject-review-${review.id}" ${review.status !== "pending" ? "disabled" : ""}>驳回</button>
          </td>
        </tr>
      `
    )
    .join("");
}

async function initDashboard() {
  const data = await getJSON("/api/dashboard");

  qs("[data-testid='stat-users']").textContent = String(data.totals.users);
  qs("[data-testid='stat-pending-reviews']").textContent = String(data.totals.pendingReviews);
  qs("[data-testid='stat-flagged-orders']").textContent = String(data.totals.flaggedOrders);
  qs("[data-testid='stat-watchlist-users']").textContent = String(data.totals.watchlistUsers);

  qs("[data-testid='recent-orders-body']").innerHTML = renderOrderRows(data.recentOrders);
  qs("[data-testid='review-queue-body']").innerHTML = renderReviewRows(data.reviewQueue);
}

async function initUsers() {
  const searchInput = qs("[data-testid='user-search']");
  const statusSelect = qs("[data-testid='user-status-filter']");
  const tableBody = qs("[data-testid='users-table-body']");

  async function loadUsers() {
    const params = new URLSearchParams({
      search: searchInput.value,
      status: statusSelect.value
    });

    const data = await getJSON(`/api/users?${params.toString()}`);
    tableBody.innerHTML = renderUserRows(data.items);
  }

  qs("[data-testid='apply-user-filters']").addEventListener("click", loadUsers);
  await loadUsers();
}

async function initUserDetail() {
  const userId = readIdParam();
  const flash = qs("[data-testid='user-flash']");

  if (!userId) {
    flash.textContent = "缺少用户 ID";
    return;
  }

  async function loadDetail() {
    const data = await getJSON(`/api/users/${userId}`);

    qs("[data-testid='user-detail-name']").textContent = data.name;
    qs("[data-testid='user-detail-status']").innerHTML =
      `<span class="${chipClass(data.status)}">${data.status}</span>`;
    qs("[data-testid='user-detail-risk']").innerHTML =
      `<span class="${chipClass(data.risk)}">${data.risk}</span>`;
    qs("[data-testid='user-watchlist-state']").textContent = data.watchlist ? "观察中" : "正常";
    qs("[data-testid='user-detail-notes']").textContent = data.notes;
    qs("[data-testid='user-meta']").innerHTML = `
      <div class="meta-item"><span>用户 ID</span>${data.id}</div>
      <div class="meta-item"><span>城市</span>${data.city}</div>
      <div class="meta-item"><span>归属人</span>${data.owner}</div>
      <div class="meta-item"><span>入驻时间</span>${data.joinedAt}</div>
    `;
    qs("[data-testid='user-orders-body']").innerHTML = renderOrderRows(data.recentOrders);
    qs("[data-testid='toggle-watchlist']").textContent = data.watchlist ? "移出观察名单" : "加入观察名单";
  }

  qs("[data-testid='toggle-watchlist']").addEventListener("click", async () => {
    await postJSON(`/api/users/${userId}/watchlist`);
    flash.textContent = "观察名单状态已更新";
    await loadDetail();
  });

  await loadDetail();
}

async function initOrders() {
  const statusSelect = qs("[data-testid='order-status-filter']");
  const tableBody = qs("[data-testid='orders-table-body']");

  async function loadOrders() {
    const params = new URLSearchParams({
      status: statusSelect.value
    });

    const data = await getJSON(`/api/orders?${params.toString()}`);
    tableBody.innerHTML = renderOrderRows(data.items);
  }

  qs("[data-testid='apply-order-filters']").addEventListener("click", loadOrders);
  await loadOrders();
}

async function initOrderDetail() {
  const orderId = readIdParam();
  const flash = qs("[data-testid='order-flash']");

  if (!orderId) {
    flash.textContent = "缺少订单 ID";
    return;
  }

  async function loadDetail() {
    const data = await getJSON(`/api/orders/${orderId}`);

    qs("[data-testid='order-detail-id']").textContent = data.id;
    qs("[data-testid='order-detail-status']").innerHTML =
      `<span class="${chipClass(data.status)}">${data.status}</span>`;
    qs("[data-testid='order-review-state']").innerHTML =
      `<span class="${chipClass(data.reviewState)}">${data.reviewState}</span>`;
    qs("[data-testid='order-flag-state']").textContent = data.flagged ? "已标记异常" : "正常";
    qs("[data-testid='order-items']").innerHTML = data.items.map((item) => `<li>${item}</li>`).join("");
    qs("[data-testid='order-meta']").innerHTML = `
      <div class="meta-item"><span>金额</span>${formatAmount(data.amount)}</div>
      <div class="meta-item"><span>支付状态</span>${data.paymentState}</div>
      <div class="meta-item"><span>渠道</span>${data.channel}</div>
      <div class="meta-item"><span>创建时间</span>${data.createdAt}</div>
    `;
    qs("[data-testid='order-user-link']").href = `/user-detail.html?id=${data.userId}`;
    qs("[data-testid='order-user-link']").textContent = data.userName;
    qs("[data-testid='toggle-order-flag']").textContent = data.flagged ? "取消异常标记" : "标记异常";
  }

  qs("[data-testid='toggle-order-flag']").addEventListener("click", async () => {
    await postJSON(`/api/orders/${orderId}/flag`);
    flash.textContent = "订单标记状态已更新";
    await loadDetail();
  });

  qs("[data-testid='submit-order-review']").addEventListener("click", async () => {
    await postJSON(`/api/orders/${orderId}/submit-review`);
    flash.textContent = "订单已提交审核";
    await loadDetail();
  });

  await loadDetail();
}

async function initReviews() {
  const statusSelect = qs("[data-testid='review-status-filter']");
  const tableBody = qs("[data-testid='reviews-table-body']");
  const flash = qs("[data-testid='reviews-flash']");

  async function loadReviews() {
    const params = new URLSearchParams({
      status: statusSelect.value
    });

    const data = await getJSON(`/api/reviews?${params.toString()}`);
    tableBody.innerHTML = renderReviewRows(data.items);

    tableBody.querySelectorAll("[data-testid^='approve-review-']").forEach((button) => {
      button.addEventListener("click", async () => {
        const reviewId = button.dataset.testid.replace("approve-review-", "");
        await postJSON(`/api/reviews/${reviewId}/decision`, { action: "approve" });
        flash.textContent = `审核 ${reviewId} 已通过`;
        await loadReviews();
      });
    });

    tableBody.querySelectorAll("[data-testid^='reject-review-']").forEach((button) => {
      button.addEventListener("click", async () => {
        const reviewId = button.dataset.testid.replace("reject-review-", "");
        await postJSON(`/api/reviews/${reviewId}/decision`, { action: "reject" });
        flash.textContent = `审核 ${reviewId} 已驳回`;
        await loadReviews();
      });
    });
  }

  qs("[data-testid='apply-review-filters']").addEventListener("click", loadReviews);
  await loadReviews();
}

async function bootstrap() {
  const page = document.body.dataset.page;
  setActiveNav(page);

  if (page === "dashboard") {
    await initDashboard();
  }

  if (page === "users") {
    await initUsers();
  }

  if (page === "user-detail") {
    await initUserDetail();
  }

  if (page === "orders") {
    await initOrders();
  }

  if (page === "order-detail") {
    await initOrderDetail();
  }

  if (page === "reviews") {
    await initReviews();
  }
}

bootstrap().catch((error) => {
  const target = document.querySelector("[data-testid='global-error']");
  if (target) {
    target.textContent = `页面加载失败: ${error.message}`;
  }
  console.error(error);
});
