(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");

  const VIEW_W = canvas.width;
  const VIEW_H = canvas.height;
  const WORLD_W = 2600;

  const G = 0.55;
  const MOVE = 4.2;
  const JUMP = -11.2;

  const ground = { x: 0, y: VIEW_H - 56, w: WORLD_W, h: 56 };

  const platforms = [
    { x: 320, y: 380, w: 160, h: 20 },
    { x: 560, y: 320, w: 140, h: 20 },
    { x: 780, y: 260, w: 120, h: 20 },
    { x: 1020, y: 340, w: 200, h: 20 },
    { x: 1320, y: 300, w: 180, h: 20 },
    { x: 1580, y: 240, w: 160, h: 20 },
    { x: 1820, y: 320, w: 220, h: 20 }
  ];

  const solids = () => [ground, ...platforms];

  const player = { x: 80, y: 180, w: 28, h: 36, vx: 0, vy: 0, onGround: false };

  function makeEnemies() {
    return [
      { x: 360, y: 380 - 28, w: 32, h: 28, vx: 1.4, minX: 330, maxX: 470 },
      { x: 1120, y: 340 - 28, w: 32, h: 28, vx: -1.2, minX: 1040, maxX: 1200 },
      { x: 1700, y: 320 - 28, w: 32, h: 28, vx: 1.1, minX: 1640, maxX: 1760 }
    ];
  }

  let enemies = makeEnemies();
  const goal = { x: WORLD_W - 120, y: VIEW_H - 56 - 120, w: 44, h: 120 };

  let cameraX = 0;
  let gameState = "playing";
  const keys = new Set();

  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function resolveHorizontal(box, dx) {
    box.x += dx;
    if (box.x < 0) box.x = 0;
    if (box.x + box.w > WORLD_W) box.x = WORLD_W - box.w;
    for (const s of solids()) {
      if (!overlap(box, s)) continue;
      if (dx > 0) box.x = s.x - box.w;
      else if (dx < 0) box.x = s.x + s.w;
    }
  }

  function resolveVertical(box, dy) {
    box.y += dy;
    box.onGround = false;
    for (const s of solids()) {
      if (!overlap(box, s)) continue;
      if (dy > 0) {
        box.y = s.y - box.h;
        box.vy = 0;
        box.onGround = true;
      } else if (dy < 0) {
        box.y = s.y + s.h;
        box.vy = 0;
      }
    }
  }

  function tickEnemies() {
    for (const e of enemies) {
      e.x += e.vx;
      if (e.x <= e.minX) {
        e.x = e.minX;
        e.vx *= -1;
      }
      if (e.x + e.w >= e.maxX) {
        e.x = e.maxX - e.w;
        e.vx *= -1;
      }
    }
  }

  function stompFromAbove(e) {
    if (player.vy <= 0.2) return false;
    const wasAbove = player.y + player.h - player.vy <= e.y + 10;
    const hOverlap = player.x + player.w > e.x + 4 && player.x < e.x + e.w - 4;
    return wasAbove && hOverlap && overlap(player, e);
  }

  function update() {
    if (gameState !== "playing") return;

    player.vx = 0;
    if (keys.has("ArrowLeft") || keys.has("KeyA")) player.vx -= MOVE;
    if (keys.has("ArrowRight") || keys.has("KeyD")) player.vx += MOVE;
    if ((keys.has("Space") || keys.has("ArrowUp") || keys.has("KeyW")) && player.onGround) {
      player.vy = JUMP;
      player.onGround = false;
    }

    player.vy += G;
    resolveHorizontal(player, player.vx);
    resolveVertical(player, player.vy);

    if (player.y > VIEW_H + 200) {
      gameState = "lose";
      statusEl.textContent = "失败：掉进坑里。按 R 重开";
      return;
    }

    tickEnemies();

    enemies = enemies.filter((e) => {
      if (e.y > VIEW_H + 100) return false;
      if (stompFromAbove(e)) {
        player.vy = JUMP * 0.55;
        return false;
      }
      if (overlap(player, e)) {
        gameState = "lose";
        statusEl.textContent = "失败：碰到蘑菇怪。按 R 重开";
      }
      return true;
    });

    if (gameState !== "playing") return;

    if (overlap(player, goal)) {
      gameState = "win";
      statusEl.textContent = "通关：到达终点旗！按 R 重开";
    }

    cameraX = clamp(player.x - VIEW_W * 0.35, 0, Math.max(0, WORLD_W - VIEW_W));
  }

  function drawCloud(cx, cy) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.arc(cx + 22, cy - 4, 22, 0, Math.PI * 2);
    ctx.arc(cx + 48, cy, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBrick(x, y, w, h) {
    ctx.fillStyle = "#b45309";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#7c2d12";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  function drawPlayer(x, y) {
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x + 6, y + 8, 16, 12);
    ctx.fillStyle = "#1d4ed8";
    ctx.fillRect(x + 4, y + 20, 20, 16);
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(x + 10, y, 10, 8);
  }

  function drawEnemy(x, y) {
    ctx.fillStyle = "#78350f";
    ctx.fillRect(x, y + 10, 32, 18);
    ctx.fillStyle = "#fde68a";
    ctx.fillRect(x + 6, y + 16, 8, 6);
    ctx.fillRect(x + 18, y + 16, 8, 6);
    ctx.fillRect(x + 4, y + 4, 24, 10);
  }

  function drawGoal(x, y) {
    ctx.fillStyle = "#64748b";
    ctx.fillRect(x, y, 8, 120);
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.moveTo(x + 8, y);
    ctx.lineTo(x + 8 + 72, y + 26);
    ctx.lineTo(x + 8, y + 50);
    ctx.closePath();
    ctx.fill();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, "#38bdf8");
    g.addColorStop(1, "#bae6fd");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.translate(-cameraX, 0);
    drawCloud(180, 70);
    drawCloud(620, 110);
    drawCloud(1400, 80);

    drawBrick(ground.x, ground.y, ground.w, ground.h);
    for (const p of platforms) drawBrick(p.x, p.y, p.w, p.h);

    for (const e of enemies) drawEnemy(e.x, e.y);
    drawGoal(goal.x, goal.y);
    drawPlayer(player.x, player.y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.fillStyle = "rgba(15,23,42,0.78)";
    ctx.fillRect(8, 8, 300, 26);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("← → 移动 · 空格跳跃 · 终点绿色旗 · R 重开", 16, 26);
  }

  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  function reset() {
    player.x = 80;
    player.y = 180;
    player.vx = 0;
    player.vy = 0;
    player.onGround = false;
    enemies = makeEnemies();
    cameraX = 0;
    gameState = "playing";
    statusEl.textContent = "向右走到旗杆；可踩蘑菇怪头顶";
  }

  window.addEventListener("keydown", (ev) => {
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.code)) {
      ev.preventDefault();
    }
    keys.add(ev.code);
    if (ev.code === "KeyR") reset();
  });
  window.addEventListener("keyup", (ev) => keys.delete(ev.code));

  reset();
  requestAnimationFrame(loop);
})();
