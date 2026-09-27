// ============================================================
//  VibeChat Minigames — canvas games, touch + keyboard
// ============================================================

import { db, auth } from "./firebase-config.js";
import {
  ref,
  get,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

let activeGame = null;

export function initGames() {
  document.querySelectorAll("[data-game]").forEach(card => {
    card.addEventListener("click", () => launchGame(card.dataset.game));
  });
  document.getElementById("game-close-btn").addEventListener("click", () => {
    closeGame();
    document.getElementById("game-view").classList.add("hidden");
    document.getElementById("games-grid").classList.remove("hidden");
  });
}

export function launchGame(id) {
  closeGame();
  const meta = GAMES[id];
  if (!meta) return;
  document.getElementById("games-grid").classList.add("hidden");
  document.getElementById("game-view").classList.remove("hidden");
  document.getElementById("game-title").textContent = `${meta.icon} ${meta.name}`;
  setScore(0);
  renderBest(id);
  const stage = document.getElementById("game-stage");
  stage.innerHTML = "";
  activeGame = meta.create(stage, makeApi(id));
}

export function closeGame() {
  if (activeGame) {
    try { activeGame.destroy(); } catch (e) { /* already gone */ }
    activeGame = null;
  }
  const stage = document.getElementById("game-stage");
  if (stage) stage.innerHTML = "";
}

function setScore(n) {
  const el = document.getElementById("game-score");
  if (el) el.textContent = n > 0 ? `Score: ${n}` : "";
}

function makeApi(gameId) {
  return {
    setScore,
    async gameOver(score) {
      setScore(score);
      try {
        const user = auth.currentUser;
        if (user && score > 0) {
          const bestRef = ref(db, `highscores/${gameId}/${user.uid}`);
          const snap = await get(bestRef);
          if (score > (snap.val()?.score || 0)) {
            await set(bestRef, {
              username: localStorage.getItem("vibechat-username") || "player",
              score: score,
              at: serverTimestamp()
            });
          }
        }
      } catch (err) {
        console.error("Highscore save failed:", err);
      }
      renderBest(gameId);
    }
  };
}

async function renderBest(gameId) {
  const el = document.getElementById("game-leaderboard");
  if (!el) return;
  el.textContent = "";
  try {
    const snap = await get(ref(db, `highscores/${gameId}`));
    const rows = Object.values(snap.val() || {}).sort((a, b) => b.score - a.score).slice(0, 5);
    if (!rows.length) return;
    el.textContent = "🏆 " + rows.map(r => `${r.username} ${r.score}`).join(" · ");
  } catch (err) {
    console.error("Leaderboard load failed:", err);
  }
}

function makeCanvas(stage, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.className = "game-canvas";
  stage.appendChild(c);
  return c;
}

function overlayText(ctx, W, H, lines) {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? "bold 28px" : "16px"} 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(line, W / 2, H / 2 - (lines.length - 1) * 18 + i * 36);
  });
}

// ============ WAVE (ENDLESS, GD-STYLE) ============
function createWave(stage, api) {
  const W = 400, H = 520, PX = 100, PR = 6;
  const c = makeCanvas(stage, W, H);
  const ctx = c.getContext("2d");
  let segs, gapY, gapHalf, speed, dist, trail, py, state, holding, raf, alive, lastScore;

  function reset() {
    gapY = H / 2;
    gapHalf = 72;
    speed = 3;
    dist = 0;
    trail = [];
    lastScore = 0;
    holding = false;
    py = H / 2;
    segs = [];
    for (let x = -40; x <= W + 40; x += 8) {
      segs.push({ x, top: gapY - gapHalf, bottom: gapY + gapHalf });
    }
    state = "ready";
    api.setScore(0);
  }

  function press(down) {
    if (!alive) return;
    holding = down;
    if (down && state === "over") {
      reset();
      state = "play";
    } else if (down && state === "ready") {
      state = "play";
    }
  }

  function die() {
    state = "over";
    api.gameOver(lastScore);
  }

  function update() {
    gapY += (Math.random() - 0.5) * 4;
    const margin = gapHalf + 24;
    if (gapY < margin) gapY = margin + Math.random() * 4;
    if (gapY > H - margin) gapY = H - margin - Math.random() * 4;
    dist += speed;
    speed = Math.min(6, 3 + dist / 14000);
    gapHalf = Math.max(46, 72 - dist / 2600);
    for (const s of segs) s.x -= speed;
    while (segs.length && segs[0].x < -16) segs.shift();
    let last = segs[segs.length - 1];
    while (last.x < W + 16) {
      last = { x: last.x + 8, top: gapY - gapHalf, bottom: gapY + gapHalf };
      segs.push(last);
    }
    py += holding ? -3.4 : 3.4;
    trail.push({ x: PX, y: py });
    if (trail.length > 42) trail.shift();
    const score = Math.floor(dist / 50);
    if (score !== lastScore) {
      lastScore = score;
      api.setScore(score);
    }
    if (py - PR < 0 || py + PR > H) {
      die();
      return;
    }
    let g = segs[0];
    for (const s of segs) {
      if (s.x <= PX) g = s;
      else break;
    }
    if (py - PR < g.top || py + PR > g.bottom) die();
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(124,108,240,0.12)";
    ctx.lineWidth = 1;
    const off = -(dist % 40);
    ctx.beginPath();
    for (let x = off; x < W; x += 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
    ctx.fillStyle = "#1e1e28";
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    for (const s of segs) ctx.lineTo(s.x, s.top);
    ctx.lineTo(W + 8, -8);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-8, H + 8);
    for (const s of segs) ctx.lineTo(s.x, s.bottom);
    ctx.lineTo(W + 8, H + 8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#e055e0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    segs.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.top) : ctx.lineTo(s.x, s.top)));
    ctx.stroke();
    ctx.beginPath();
    segs.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.bottom) : ctx.lineTo(s.x, s.bottom)));
    ctx.stroke();
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      ctx.fillStyle = `rgba(78,205,196,${(i / trail.length) * 0.8})`;
      ctx.fillRect(t.x - 2, t.y - 2, 4, 4);
    }
    ctx.fillStyle = "#fff";
    ctx.fillRect(PX - 6, py - 6, 12, 12);
    ctx.fillStyle = "#4ecdc4";
    ctx.fillRect(PX - 4, py - 4, 8, 8);
    if (state === "ready") overlayText(ctx, W, H, ["Get Ready", "Hold to rise, release to fall"]);
    else if (state === "over") overlayText(ctx, W, H, ["Wrecked", `Score: ${lastScore}`, "Hold to retry"]);
  }

  function loop() {
    if (!alive) return;
    if (state === "play") update();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function onDown(e) {
    e.preventDefault();
    press(true);
  }
  function onUp() {
    press(false);
  }
  function onKeyDown(e) {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      if (!e.repeat) press(true);
    }
  }
  function onKeyUp(e) {
    if (e.code === "Space" || e.code === "ArrowUp") press(false);
  }

  reset();
  alive = true;
  c.addEventListener("pointerdown", onDown);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  loop();

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    }
  };
}

// ============ FLAPPY BIRD ============
function createFlappy(stage, api) {
  const W = 400, H = 520;
  const c = makeCanvas(stage, W, H);
  const ctx = c.getContext("2d");
  const GRAV = 0.45, GAP = 134, PW = 62, SPEED = 2.3, BX = 84, BR = 12;
  let bird, pipes, frame, score, state, raf, alive;

  function reset() {
    bird = { y: H / 2, v: 0 };
    pipes = [];
    frame = 0;
    score = 0;
    state = "ready";
    api.setScore(0);
  }

  function press() {
    if (!alive) return;
    if (state === "over") reset();
    if (state === "ready" || state === "play") {
      state = "play";
      bird.v = -7.2;
    }
  }

  function die() {
    state = "over";
    api.gameOver(score);
  }

  function update() {
    frame++;
    bird.v += GRAV;
    bird.y += bird.v;
    if (frame % 95 === 0) {
      const margin = 60;
      pipes.push({ x: W, gapY: margin + Math.random() * (H - GAP - margin * 2), scored: false });
    }
    for (const p of pipes) p.x -= SPEED;
    if (pipes.length && pipes[0].x < -PW) pipes.shift();
    for (const p of pipes) {
      if (!p.scored && p.x + PW < BX) {
        p.scored = true;
        score++;
        api.setScore(score);
      }
      if (BX + BR > p.x && BX - BR < p.x + PW && (bird.y - BR < p.gapY || bird.y + BR > p.gapY + GAP)) {
        die();
        return;
      }
    }
    if (bird.y + BR >= H || bird.y - BR <= 0) die();
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#2ea85c";
    for (const p of pipes) {
      ctx.fillRect(p.x, 0, PW, p.gapY);
      ctx.fillRect(p.x, p.gapY + GAP, PW, H - p.gapY - GAP);
    }
    ctx.fillStyle = "#f0c060";
    ctx.beginPath();
    ctx.arc(BX, bird.y, BR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(BX + 4, bird.y - 3, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7c6cf0";
    ctx.fillRect(0, H - 14, W, 14);
    if (state === "ready") overlayText(ctx, W, H, ["Get Ready", "Tap, click, or Space"]);
    else if (state === "over") overlayText(ctx, W, H, ["Game Over", `Score: ${score}`, "Tap to restart"]);
    else {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 32px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(score, W / 2, 56);
    }
  }

  function loop() {
    if (!alive) return;
    if (state === "play") update();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function onKey(e) {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      press();
    }
  }

  reset();
  alive = true;
  c.addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
  window.addEventListener("keydown", onKey);
  loop();

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    }
  };
}

// ============ SNAKE ============
function createSnake(stage, api) {
  const N = 20, CELL = 20, W = N * CELL;
  const c = makeCanvas(stage, W, W);
  const ctx = c.getContext("2d");
  let snake, dir, queue, food, score, speed, timer, state, alive;

  function reset() {
    snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    dir = { x: 1, y: 0 };
    queue = [];
    score = 0;
    speed = 115;
    state = "ready";
    placeFood();
    api.setScore(0);
  }

  function placeFood() {
    while (true) {
      const f = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) };
      if (!snake.some(s => s.x === f.x && s.y === f.y)) {
        food = f;
        return;
      }
    }
  }

  function setDir(d) {
    if (!alive) return;
    if (state === "over") {
      reset();
      state = "play";
    }
    if (state === "ready") state = "play";
    if (queue.length < 3) queue.push(d);
  }

  function step() {
    if (queue.length) {
      const d = queue.shift();
      if (!(d.x === -dir.x && d.y === -dir.y)) dir = d;
    }
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= N || head.y >= N) return die();
    const eats = head.x === food.x && head.y === food.y;
    const body = eats ? snake : snake.slice(0, -1);
    if (body.some(s => s.x === head.x && s.y === head.y)) return die();
    snake.unshift(head);
    if (eats) {
      score++;
      api.setScore(score);
      speed = Math.max(60, 115 - score * 2);
      placeFood();
    } else {
      snake.pop();
    }
  }

  function die() {
    state = "over";
    api.gameOver(score);
  }

  function tick() {
    if (!alive) return;
    if (state === "play") step();
    draw();
    timer = setTimeout(tick, speed);
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = "#e05555";
    ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? "#4ecdc4" : "#2a9d94";
      ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
    });
    if (state === "ready") overlayText(ctx, W, W, ["Ready", "Arrows / WASD / swipe"]);
    else if (state === "over") overlayText(ctx, W, W, ["Game Over", `Score: ${score}`, "Press a direction to restart"]);
  }

  const KEYMAP = {
    ArrowUp: { x: 0, y: -1 }, KeyW: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 }, KeyS: { x: 0, y: 1 },
    ArrowLeft: { x: -1, y: 0 }, KeyA: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 }, KeyD: { x: 1, y: 0 }
  };

  function onKey(e) {
    const d = KEYMAP[e.code];
    if (d) {
      e.preventDefault();
      setDir(d);
    } else if (e.code === "Space" && state === "over") {
      e.preventDefault();
      setDir({ x: 1, y: 0 });
    }
  }

  let touchStart = null;
  function onTouchStart(e) {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onTouchEnd(e) {
    if (!touchStart) return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
      if (state !== "play") setDir({ x: 1, y: 0 });
      return;
    }
    setDir(Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) });
  }

  reset();
  alive = true;
  c.addEventListener("pointerdown", () => setDir({ x: 1, y: 0 }));
  c.addEventListener("touchstart", onTouchStart, { passive: true });
  c.addEventListener("touchend", onTouchEnd);
  window.addEventListener("keydown", onKey);
  tick();

  return {
    destroy() {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      c.removeEventListener("touchstart", onTouchStart);
      c.removeEventListener("touchend", onTouchEnd);
    }
  };
}

// ============ BREAKOUT ============
function createBreakout(stage, api) {
  const W = 400, H = 520;
  const c = makeCanvas(stage, W, H);
  const ctx = c.getContext("2d");
  const PW = 78, PH = 12, PY = H - 34, BR = 7;
  const COLS = 6, ROWS = 5, BW = (W - 40) / COLS, BH = 22;
  const COLORS = ["#e05555", "#f0c060", "#4ecdc4", "#7c6cf0", "#2ea85c"];
  let paddleX, ball, bricks, lives, score, state, raf, alive, keys;

  function reset(full) {
    paddleX = W / 2;
    ball = { x: W / 2, y: PY - BR - 1, vx: 0, vy: 0, stuck: true };
    if (full) {
      bricks = [];
      for (let r = 0; r < ROWS; r++) {
        for (let col = 0; col < COLS; col++) {
          bricks.push({ x: 20 + col * BW + 2, y: 64 + r * (BH + 4), w: BW - 4, h: BH, color: COLORS[r % COLORS.length] });
        }
      }
      lives = 3;
      score = 0;
      api.setScore(0);
    }
    state = full ? "ready" : state;
  }

  function launch() {
    if (!alive) return;
    if (state === "over") {
      reset(true);
      state = "play";
      ball.stuck = false;
      ball.vx = 2.5;
      ball.vy = -4;
      return;
    }
    if (ball.stuck) {
      state = "play";
      ball.stuck = false;
      ball.vx = 2.5;
      ball.vy = -4;
    }
  }

  function update() {
    if (keys.has("left")) paddleX = Math.max(PW / 2, paddleX - 6);
    if (keys.has("right")) paddleX = Math.min(W - PW / 2, paddleX + 6);
    if (ball.stuck) {
      ball.x = paddleX;
      ball.y = PY - BR - 1;
      return;
    }
    ball.x += ball.vx;
    ball.y += ball.vy;
    if (ball.x - BR < 0 || ball.x + BR > W) ball.vx *= -1;
    if (ball.y - BR < 0) ball.vy *= -1;
    if (ball.vy > 0 && ball.y + BR >= PY && ball.y + BR <= PY + PH + 6 && Math.abs(ball.x - paddleX) <= PW / 2 + BR) {
      const off = (ball.x - paddleX) / (PW / 2);
      ball.vx = off * 4;
      ball.vy = -Math.abs(ball.vy);
      ball.y = PY - BR - 1;
    }
    for (let i = 0; i < bricks.length; i++) {
      const b = bricks[i];
      if (ball.x + BR > b.x && ball.x - BR < b.x + b.w && ball.y + BR > b.y && ball.y - BR < b.y + b.h) {
        bricks.splice(i, 1);
        ball.vy *= -1;
        score += 10;
        api.setScore(score);
        break;
      }
    }
    if (!bricks.length) {
      state = "over";
      api.gameOver(score + lives * 50);
      return;
    }
    if (ball.y - BR > H) {
      lives--;
      if (lives <= 0) {
        state = "over";
        api.gameOver(score);
      } else {
        ball = { x: paddleX, y: PY - BR - 1, vx: 0, vy: 0, stuck: true };
      }
    }
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, H);
    for (const b of bricks) {
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    ctx.fillStyle = "#7c6cf0";
    ctx.fillRect(paddleX - PW / 2, PY, PW, PH);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9898b0";
    ctx.font = "14px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Lives: ${lives}`, 12, 24);
    if (state === "ready") overlayText(ctx, W, H, ["Ready", "Tap to launch the ball"]);
    else if (state === "over") overlayText(ctx, W, H, [bricks.length ? "Game Over" : "You Win!", `Score: ${score}`, "Tap to play again"]);
  }

  function loop() {
    if (!alive) return;
    if (state === "play") update();
    else if (state === "ready") {
      if (keys.has("left")) paddleX = Math.max(PW / 2, paddleX - 6);
      if (keys.has("right")) paddleX = Math.min(W - PW / 2, paddleX + 6);
      ball.x = paddleX;
    }
    draw();
    raf = requestAnimationFrame(loop);
  }

  function onKeyDown(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keys.add("left"); e.preventDefault(); }
    if (e.code === "ArrowRight" || e.code === "KeyD") { keys.add("right"); e.preventDefault(); }
    if (e.code === "Space") { e.preventDefault(); launch(); }
  }
  function onKeyUp(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") keys.delete("left");
    if (e.code === "ArrowRight" || e.code === "KeyD") keys.delete("right");
  }
  function onPointer(e) {
    const rect = c.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    if (clientX == null) {
      launch();
      return;
    }
    paddleX = Math.max(PW / 2, Math.min(W - PW / 2, (clientX - rect.left) * (W / rect.width)));
    if (state !== "play") launch();
  }

  reset(true);
  alive = true;
  keys = new Set();
  c.addEventListener("pointerdown", onPointer);
  c.addEventListener("pointermove", (e) => {
    if (e.buttons > 0 || e.pointerType === "touch") onPointer(e);
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  loop();

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    }
  };
}

// ============ MEMORY MATCH ============
const MEMO_EMOJI = ["🍕", "🚀", "🐸", "🎧", "🌈", "⚽", "🍩", "🐙"];

function createMemory(stage, api) {
  const deck = [...MEMO_EMOJI, ...MEMO_EMOJI]
    .map(e => ({ e, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(o => o.e);
  const grid = document.createElement("div");
  grid.className = "mem-grid";
  stage.appendChild(grid);

  let open = [];
  let matched = 0;
  let moves = 0;
  let lock = false;
  let alive = true;
  let checkTimer = 0;
  api.setScore(0);

  deck.forEach(face => {
    const btn = document.createElement("button");
    btn.className = "mem-card";
    btn.textContent = "❔";
    btn.addEventListener("click", () => {
      if (!alive || lock || btn.classList.contains("open")) return;
      btn.classList.add("open");
      btn.textContent = face;
      open.push({ btn, face });
      if (open.length === 2) {
        moves++;
        if (open[0].face === open[1].face) {
          open.forEach(o => {
            o.btn.classList.add("matched");
            o.btn.disabled = true;
          });
          open = [];
          matched += 2;
          api.setScore(matched * 10);
          if (matched === deck.length) {
            const finalScore = Math.max(50, 800 - (moves - 8) * 20);
            api.gameOver(finalScore);
          }
        } else {
          lock = true;
          const pair = open;
          open = [];
          checkTimer = setTimeout(() => {
            if (!alive) return;
            pair.forEach(o => {
              o.btn.classList.remove("open");
              o.btn.textContent = "❔";
            });
            lock = false;
          }, 650);
        }
      }
    });
    grid.appendChild(btn);
  });

  return {
    destroy() {
      alive = false;
      clearTimeout(checkTimer);
    }
  };
}

const GAMES = {
  wave: { name: "Wave", icon: "🌊", create: createWave },
  flappy: { name: "Flappy Bird", icon: "🐤", create: createFlappy },
  snake: { name: "Snake", icon: "🐍", create: createSnake },
  breakout: { name: "Breakout", icon: "🧱", create: createBreakout },
  memory: { name: "Memory Match", icon: "🃏", create: createMemory }
};
