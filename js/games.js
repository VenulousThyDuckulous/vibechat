// ============================================================
//  VibeChat Minigames — canvas games, touch + keyboard
// ============================================================

import { db, auth } from "./firebase-config.js";
import {
  ref,
  get,
  set,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// Coins per score point, per game (scores live on very different scales)
const COIN_RATES = { flappy: 2, snake: 2, breakout: 0.1, memory: 0.05, wave: 1, tetris: 0.02, game2048: 0.005, pong: 3 };

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
          // Coins for playing (capped per game)
          const earned = Math.max(1, Math.min(150, Math.round(score * (COIN_RATES[gameId] ?? 0.5))));
          await runTransaction(ref(db, `users/${user.uid}/coins`), (c) => (c || 0) + earned);
          window.dispatchEvent(new CustomEvent("vibechat-coins", { detail: earned }));
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
    py += holding ? -speed : speed; // true GD 45° angles at any speed
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
    // Deep-space background with a faint blue grid
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#070b18");
    bg.addColorStop(1, "#04060d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(0, 140, 255, 0.10)";
    ctx.lineWidth = 1;
    const off = -(dist % 40);
    ctx.beginPath();
    for (let x = off; x < W; x += 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = 0; y < H; y += 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    // Solid GD-style blocks with a soft glow
    ctx.fillStyle = "#f2f5ff";
    ctx.shadowColor = "rgba(160, 200, 255, 0.55)";
    ctx.shadowBlur = 12;
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
    ctx.shadowBlur = 0;
    // Glowing trail ribbon, fading toward the tail
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = `rgba(0, 229, 255, ${(i / trail.length) * 0.85})`;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
    // Arrow player that flips with direction, white core + cyan glow
    const dir = holding ? -1 : 1;
    ctx.save();
    ctx.translate(PX, py);
    ctx.shadowColor = "#00e5ff";
    ctx.shadowBlur = 16;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (dir < 0) {
      ctx.moveTo(11, -4);
      ctx.lineTo(-9, -12);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-9, 12);
    } else {
      ctx.moveTo(11, 4);
      ctx.lineTo(-9, 12);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-9, -12);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
  // Tap starts/restarts, but must NOT queue a direction mid-game —
  // pointerdown fires before touchend, so an unguarded handler would turn
  // right first and eat the actual swipe (anti-reverse then locks it in).
  c.addEventListener("pointerdown", () => {
    if (state !== "play") setDir({ x: 1, y: 0 });
  });
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

// ============ GBA EMULATOR (EmulatorJS) ============
// ROMs are user-supplied (upload or URL) — nothing copyrighted ships
// with the app. No BIOS file needed (built-in replacement).
// Uploads are staged in Cache Storage and served over same-origin https
// by the app service worker, because the EmulatorJS loader refuses
// blob: URLs.
let gbaCachedUrl = null;

function gbaEsc(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Layered teardown: a new instance per ROM means the old one must die,
// or you get double audio + 2x CPU (the classic "runs badly" symptom).
function killEmu() {
  try {
    const emu = window.EJS_emulator;
    if (emu) {
      try { emu.pause?.(); } catch (e) { /* no pause API */ }
      try { emu.callEvent?.("exit"); } catch (e) { /* no event API */ }
    }
  } catch (e) { /* already gone */ }
  try { window.EJS_emulator = null; } catch (e) {}
  document.querySelector('script[data-emu-loader]')?.remove();
}

async function gbaForgetCached() {
  if (!gbaCachedUrl) return;
  try {
    const cache = await caches.open("vibechat-emu-roms");
    await cache.delete(gbaCachedUrl);
  } catch (e) { /* cache unavailable — nothing to clean */ }
  gbaCachedUrl = null;
}

// The ROM worker must CONTROL this page for its fetches to be
// intercepted, so register the app-wide worker (default scope) and wait
// for control — not just activation.
let emuDiagLine = "";
async function ensureEmuSW(romUrl) {
  // Versioned URL forces a fresh install (SW update checks can serve a
  // stale cached copy for up to 24h otherwise).
  const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js?v=2");
  let worker = reg.installing || reg.waiting || reg.active;
  try {
    await reg.update();
    worker = reg.installing || reg.waiting || reg.active || worker;
  } catch (e) { /* offline-first update failed — proceed */ }
  if (worker && worker.state !== "activated") {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SW activation timeout")), 20000);
      const onChange = () => {
        if (worker.state === "activated") {
          clearTimeout(timeout);
          worker.removeEventListener("statechange", onChange);
          resolve();
        } else if (worker.state === "redundant") {
          clearTimeout(timeout);
          worker.removeEventListener("statechange", onChange);
          reject(new Error("SW redundant"));
        }
      };
      worker.addEventListener("statechange", onChange);
    });
  }
  // Record registrations BEFORE waiting, so the diagnostic line is
  // always populated even if a later step times out.
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    emuDiagLine = regs.map(r => `${r.scope} [${r.active?.state || r.installing?.state || r.waiting?.state || "?"}]`).join(" | ") || "none";
    const covered = regs.some(r => r.active && romUrl.startsWith(r.scope));
    if (!covered) throw new Error("SW scope mismatch");
  } catch (err) {
    if (err.message === "SW scope mismatch") throw err;
    /* getRegistrations failed — proceed, probe will tell us */
  }
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SW controller timeout")), 15000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
}

// Prove the staged ROM is retrievable before launching the player,
// so a serving failure shows a clear message instead of a grey box.
async function probeEmuRom(romUrl) {
  const res = await fetch(romUrl);
  if (!res.ok) throw new Error(`ROM probe HTTP ${res.status}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  try { reader.cancel(); } catch (e) {}
  if (!value || !value.length) throw new Error("ROM probe empty");
}

function createGba(stage, api) {
  let alive = true;

  const picker = document.createElement("div");
  picker.className = "emu-picker";
  picker.innerHTML = `
    <h4>🕹️ Game Boy Advance</h4>
    <p>Load a ROM dump you own (homebrew works great). The file never leaves your browser.</p>
    <input type="file" id="emu-file" accept=".gba,.zip" />
    <div class="emu-or">— or paste a direct ROM link —</div>
    <input type="text" id="emu-url" placeholder="https://…/game.gba" autocomplete="off" />
    <button id="emu-url-btn" class="btn btn-primary">Load URL</button>
    <p id="emu-status" class="emu-status"></p>
  `;
  stage.appendChild(picker);

  const setStatus = (msg) => {
    const el = picker.querySelector("#emu-status");
    if (el) el.textContent = msg;
  };

  function showPicker() {
    killEmu();
    stage.querySelector("#emu-holder")?.remove();
    picker.classList.remove("hidden");
    picker.style.display = "";
    setStatus("");
  }

  function startEmu(romUrl, label) {
    if (!alive) return;
    killEmu();
    stage.querySelector("#emu-holder")?.remove();

    picker.style.display = "none";
    const holder = document.createElement("div");
    holder.id = "emu-holder";
    holder.innerHTML = `
      <div id="emu-game"></div>
      <p class="emu-rom">Playing: ${gbaEsc(label)}</p>
      <button id="emu-change" class="btn btn-ghost">Change ROM</button>
    `;
    stage.appendChild(holder);
    holder.querySelector("#emu-change").addEventListener("click", showPicker);

    window.EJS_player = "#emu-game";
    window.EJS_gameUrl = romUrl;
    window.EJS_core = "gba";
    window.EJS_biosUrl = "";
    window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
    const s = document.createElement("script");
    s.src = "https://cdn.emulatorjs.org/stable/data/loader.js";
    s.dataset.emuLoader = "1";
    s.onerror = () => {
      const grid = holder.querySelector("#emu-game");
      if (grid) grid.innerHTML = '<p class="gif-status">Could not load the emulator. Check your connection and try again.</p>';
    };
    document.body.appendChild(s);
  }

  picker.querySelector("#emu-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !alive) return;
    if (!("serviceWorker" in navigator) || !window.caches || !location.href.startsWith("https://")) {
      setStatus("Uploads need the hosted https site — or paste a direct ROM link instead.");
      return;
    }
    setStatus("Staging ROM…");
    try {
      const safeName = (file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_") || "game.gba").slice(0, 80);
      const romUrl = new URL(`./emu-rom/${Date.now()}-${safeName}`, location.href).href;
      const buf = await file.arrayBuffer();
      const cache = await caches.open("vibechat-emu-roms");
      await cache.put(romUrl, new Response(buf));
      await gbaForgetCached();
      gbaCachedUrl = romUrl;
      setStatus("Starting player…");
      await ensureEmuSW(romUrl);
      await probeEmuRom(romUrl);
      if (!alive) return;
      setStatus("");
      startEmu(romUrl, file.name);
    } catch (err) {
      console.error("ROM staging failed:", err, "| workers:", emuDiagLine);
      const msg = /probe|service worker|SW|controller|redundant|activation|scope/i.test(err?.message || "")
        ? "Player can't reach the staged ROM — open F12 Console and send me the red lines."
        : "Could not stage that file — try a direct ROM link instead.";
      setStatus(msg);
    }
  });
  const loadUrl = () => {
    const url = picker.querySelector("#emu-url").value.trim();
    if (!url) return;
    const label = url.split("/").pop().split("?")[0] || url;
    startEmu(url, label);
  };
  picker.querySelector("#emu-url-btn").addEventListener("click", loadUrl);
  picker.querySelector("#emu-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadUrl();
    }
  });

  return {
    destroy() {
      alive = false;
      killEmu();
      gbaForgetCached();
    }
  };
}

// ============ TETRIS ============
const TETRIS_PIECES = [
  { m: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], c: "#00f0f0" },
  { m: [[1, 0, 0], [1, 1, 1], [0, 0, 0]], c: "#0000f0" },
  { m: [[0, 0, 1], [1, 1, 1], [0, 0, 0]], c: "#f0a000" },
  { m: [[1, 1], [1, 1]], c: "#f0f000" },
  { m: [[0, 1, 1], [1, 1, 0], [0, 0, 0]], c: "#00f000" },
  { m: [[0, 1, 0], [1, 1, 1], [0, 0, 0]], c: "#a000f0" },
  { m: [[1, 1, 0], [0, 1, 1], [0, 0, 0]], c: "#f00000" }
];

function createTetris(stage, api) {
  const COLS = 10, ROWS = 20, CELL = 24, W = COLS * CELL, H = ROWS * CELL;
  const wrap = document.createElement("div");
  wrap.className = "tetris-wrap";
  const top = document.createElement("div");
  top.className = "tetris-top";
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  c.className = "game-canvas";
  const next = document.createElement("canvas");
  next.width = 96;
  next.height = 96;
  next.className = "game-canvas tetris-next";
  top.appendChild(c);
  const side = document.createElement("div");
  side.className = "tetris-side";
  side.innerHTML = "<div class='tetris-label'>Next</div>";
  side.appendChild(next);
  wrap.appendChild(top);
  wrap.appendChild(side);
  const pad = document.createElement("div");
  pad.className = "game-pad";
  pad.innerHTML = `
    <button data-k="left">◀</button>
    <button data-k="rotate">⟳</button>
    <button data-k="down">⬇</button>
    <button data-k="drop">⏬</button>
    <button data-k="right">▶</button>
  `;
  wrap.appendChild(pad);
  stage.appendChild(wrap);

  const ctx = c.getContext("2d");
  const nctx = next.getContext("2d");
  let grid, bag, cur, nxt, score, lines, state, timer, alive;

  function newBag() {
    bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }

  function takePiece() {
    if (!bag.length) newBag();
    const p = TETRIS_PIECES[bag.pop()];
    return { m: p.m.map(r => r.slice()), c: p.c, x: 3, y: 0 };
  }

  function reset() {
    grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    newBag();
    cur = takePiece();
    nxt = takePiece();
    score = 0;
    lines = 0;
    state = "ready";
    api.setScore(0);
  }

  function level() {
    return Math.floor(lines / 10) + 1;
  }

  function speed() {
    return Math.max(70, 600 - (level() - 1) * 50);
  }

  function collides(m, px, py) {
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m[y].length; x++) {
        if (!m[y][x]) continue;
        const bx = px + x, by = py + y;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && grid[by][bx]) return true;
      }
    }
    return false;
  }

  function rotateMatrix(m) {
    const n = m.length;
    return m.map((row, i) => row.map((_, j) => m[n - 1 - j][i]));
  }

  function tryRotate() {
    if (cur.m.length === 2) return; // O piece
    const r = rotateMatrix(cur.m);
    for (const dx of [0, -1, 1, -2, 2]) {
      if (!collides(r, cur.x + dx, cur.y)) {
        cur.m = r;
        cur.x += dx;
        return;
      }
    }
  }

  function stepDown() {
    if (!collides(cur.m, cur.x, cur.y + 1)) {
      cur.y++;
      return true;
    }
    lockPiece();
    return false;
  }

  function hardDrop() {
    while (stepDown()) { /* fall through */ }
  }

  function lockPiece() {
    for (let y = 0; y < cur.m.length; y++) {
      for (let x = 0; x < cur.m[y].length; x++) {
        if (!cur.m[y][x]) continue;
        const by = cur.y + y;
        if (by < 0) {
          die();
          return;
        }
        grid[by][cur.x + x] = cur.c;
      }
    }
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (grid[y].every(v => v)) {
        grid.splice(y, 1);
        grid.unshift(Array(COLS).fill(null));
        cleared++;
        y++;
      }
    }
    if (cleared > 0) {
      lines += cleared;
      score += [0, 100, 300, 500, 800][cleared] * level();
      api.setScore(score);
    }
    cur = nxt;
    nxt = takePiece();
    if (collides(cur.m, cur.x, cur.y)) die();
  }

  function die() {
    state = "over";
    api.gameOver(score);
  }

  function tick() {
    if (!alive) return;
    if (state === "play") stepDown();
    draw();
    timer = setTimeout(tick, speed());
  }

  function drawCell(g, x, y, color) {
    g.fillStyle = color;
    g.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x]) drawCell(ctx, x, y, grid[y][x]);
      }
    }
    cur.m.forEach((row, y) => row.forEach((v, x) => {
      if (v && cur.y + y >= 0) drawCell(ctx, cur.x + x, cur.y + y, cur.c);
    }));
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Lv ${level()}  Lines ${lines}`, 8, 20);
    nctx.fillStyle = "#0f0f13";
    nctx.fillRect(0, 0, 96, 96);
    const nm = nxt.m;
    const scale = nm.length === 4 ? 20 : 24;
    const offX = (96 - nm.length * scale) / 2;
    const offY = (96 - nm.length * scale) / 2;
    nctx.fillStyle = nxt.c;
    nm.forEach((row, y) => row.forEach((v, x) => {
      if (v) nctx.fillRect(offX + x * scale + 1, offY + y * scale + 1, scale - 2, scale - 2);
    }));
    if (state === "ready") overlayText(ctx, W, H, ["Ready", "Tap / Space to start"]);
    else if (state === "over") overlayText(ctx, W, H, ["Game Over", `Score: ${score}`, "Tap to restart"]);
  }

  function press() {
    if (!alive) return;
    if (state === "over") {
      reset();
      state = "play";
    } else if (state === "ready") {
      state = "play";
    } else {
      tryRotate();
    }
  }

  function move(dx) {
    if (!alive) return;
    if (state !== "play") {
      press();
      return;
    }
    if (!collides(cur.m, cur.x + dx, cur.y)) cur.x += dx;
  }

  function down() {
    if (!alive) return;
    if (state !== "play") {
      press();
      return;
    }
    stepDown();
    draw();
  }

  function onKey(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { e.preventDefault(); move(-1); }
    else if (e.code === "ArrowRight" || e.code === "KeyD") { e.preventDefault(); move(1); }
    else if (e.code === "ArrowDown" || e.code === "KeyS") { e.preventDefault(); down(); }
    else if (e.code === "ArrowUp" || e.code === "KeyX" || e.code === "KeyW") { e.preventDefault(); press(); }
    else if (e.code === "Space") {
      e.preventDefault();
      if (state === "play") {
        hardDrop();
        draw();
      } else press();
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
      press();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1);
    else if (dy > 0) down();
  }

  pad.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.k;
      if (k === "left") move(-1);
      else if (k === "right") move(1);
      else if (k === "rotate") press();
      else if (k === "down") down();
      else if (k === "drop") {
        if (state === "play") {
          hardDrop();
          draw();
        } else press();
      }
    });
  });

  reset();
  alive = true;
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

// ============ 2048 ============
const TILE_COLORS = {
  2: "#3a3a4a", 4: "#4a4a5e", 8: "#f07830", 16: "#f09040",
  32: "#e05555", 64: "#d04040", 128: "#f0c060", 256: "#eeb040",
  512: "#4ecdc4", 1024: "#3aa8e0", 2048: "#7c6cf0"
};

function create2048(stage, api) {
  const N = 4, W = 400, CELL = W / N;
  const c = makeCanvas(stage, W, W);
  const ctx = c.getContext("2d");
  let grid, score, state, alive;

  function reset() {
    grid = Array.from({ length: N }, () => Array(N).fill(0));
    score = 0;
    state = "ready";
    spawn();
    spawn();
    api.setScore(0);
  }

  function emptyCells() {
    const cells = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!grid[y][x]) cells.push({ x, y });
      }
    }
    return cells;
  }

  function spawn() {
    const cells = emptyCells();
    if (!cells.length) return;
    const cell = cells[Math.floor(Math.random() * cells.length)];
    grid[cell.y][cell.x] = Math.random() < 0.9 ? 2 : 4;
  }

  function slide(row) {
    const tiles = row.filter(v => v);
    for (let i = 0; i < tiles.length - 1; i++) {
      if (tiles[i] === tiles[i + 1]) {
        tiles[i] *= 2;
        score += tiles[i];
        tiles.splice(i + 1, 1);
      }
    }
    while (tiles.length < N) tiles.push(0);
    return tiles;
  }

  function move(dx, dy) {
    if (!alive) return;
    if (state === "over") {
      reset();
      state = "play";
      draw();
      return;
    }
    if (state === "ready") state = "play";
    const before = JSON.stringify(grid);
    for (let i = 0; i < N; i++) {
      if (dx === -1) grid[i] = slide(grid[i]);
      else if (dx === 1) grid[i] = slide(grid[i].slice().reverse()).reverse();
      else if (dy === -1) {
        const col = slide([grid[0][i], grid[1][i], grid[2][i], grid[3][i]]);
        for (let y = 0; y < N; y++) grid[y][i] = col[y];
      } else if (dy === 1) {
        const col = slide([grid[3][i], grid[2][i], grid[1][i], grid[0][i]]).reverse();
        for (let y = 0; y < N; y++) grid[y][i] = col[y];
      }
    }
    if (JSON.stringify(grid) === before) return;
    api.setScore(score);
    spawn();
    draw();
    if (!movesAvailable()) {
      state = "over";
      api.gameOver(score);
      draw();
    }
  }

  function movesAvailable() {
    if (emptyCells().length) return true;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if ((x + 1 < N && grid[y][x] === grid[y][x + 1]) ||
            (y + 1 < N && grid[y][x] === grid[y + 1][x])) return true;
      }
    }
    return false;
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, W);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = grid[y][x];
        ctx.fillStyle = v ? (TILE_COLORS[v] || "#7c6cf0") : "#1e1e28";
        const px = x * CELL + 5, py = y * CELL + 5, s = CELL - 10;
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(px, py, s, s, 8);
          ctx.fill();
        } else {
          ctx.fillRect(px, py, s, s);
        }
        if (v) {
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${v < 100 ? 34 : v < 1000 ? 28 : 22}px 'Segoe UI', system-ui, sans-serif`;
          ctx.fillText(v, x * CELL + CELL / 2, y * CELL + CELL / 2 + 1);
        }
      }
    }
    ctx.textBaseline = "alphabetic";
    if (state === "ready") overlayText(ctx, W, W, ["Ready", "Arrows / WASD / swipe"]);
    else if (state === "over") overlayText(ctx, W, W, ["Game Over", `Score: ${score}`, "Tap / Space to restart"]);
  }

  function onKey(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { e.preventDefault(); move(-1, 0); }
    else if (e.code === "ArrowRight" || e.code === "KeyD") { e.preventDefault(); move(1, 0); }
    else if (e.code === "ArrowUp" || e.code === "KeyW") { e.preventDefault(); move(0, -1); }
    else if (e.code === "ArrowDown" || e.code === "KeyS") { e.preventDefault(); move(0, 1); }
    else if (e.code === "Space" && state === "over") {
      e.preventDefault();
      move(0, 0);
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
      if (state !== "play") move(0, 0);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1, 0);
    else move(0, dy > 0 ? 1 : -1);
  }

  reset();
  alive = true;
  draw();
  c.addEventListener("touchstart", onTouchStart, { passive: true });
  c.addEventListener("touchend", onTouchEnd);
  window.addEventListener("keydown", onKey);

  return {
    destroy() {
      alive = false;
      window.removeEventListener("keydown", onKey);
      c.removeEventListener("touchstart", onTouchStart);
      c.removeEventListener("touchend", onTouchEnd);
    }
  };
}

// ============ PONG VS AI ============
function createPong(stage, api) {
  const W = 400, H = 520;
  const c = makeCanvas(stage, W, H);
  const ctx = c.getContext("2d");
  const PW = 80, PH = 10, BR = 7, WIN_SCORE = 7;
  let playerX, aiX, ball, playerScore, aiScore, state, raf, alive, keys, aiTarget;

  function reset(full) {
    playerX = W / 2;
    aiX = W / 2;
    if (full) {
      playerScore = 0;
      aiScore = 0;
      api.setScore(0);
    }
    serve(playerScore >= aiScore ? 1 : -1);
    state = full ? "ready" : state;
  }

  function serve(dirY) {
    ball = { x: W / 2, y: H / 2, vx: (Math.random() < 0.5 ? -1 : 1) * 2.5, vy: 3.5 * dirY };
    aiTarget = W / 2 + (Math.random() - 0.5) * 60;
  }

  function die(playerWonPoint) {
    if (playerWonPoint) {
      playerScore++;
      api.setScore(playerScore);
    } else {
      aiScore++;
    }
    if (playerScore >= WIN_SCORE || aiScore >= WIN_SCORE) {
      state = "over";
      api.gameOver(playerScore);
    } else {
      serve(playerWonPoint ? -1 : 1);
    }
  }

  function update() {
    if (keys.has("left")) playerX = Math.max(PW / 2, playerX - 6);
    if (keys.has("right")) playerX = Math.min(W - PW / 2, playerX + 6);
    // AI tracks the ball with limited speed and aim error
    if (ball.vy < 0) {
      const diff = (aiTarget + (ball.x - aiTarget) * 0.4) - aiX;
      aiX += Math.max(-3.2, Math.min(3.2, diff));
      aiX = Math.max(PW / 2, Math.min(W - PW / 2, aiX));
    }
    ball.x += ball.vx;
    ball.y += ball.vy;
    if (ball.x - BR < 0 || ball.x + BR > W) ball.vx *= -1;
    // Player paddle (bottom)
    if (ball.vy > 0 && ball.y + BR >= H - 30 && ball.y + BR <= H - 30 + PH + 6 &&
        Math.abs(ball.x - playerX) <= PW / 2 + BR) {
      const off = (ball.x - playerX) / (PW / 2);
      ball.vx = off * 4.5;
      ball.vy = -Math.abs(ball.vy) * 1.04;
      ball.y = H - 30 - BR - 1;
    }
    // AI paddle (top)
    if (ball.vy < 0 && ball.y - BR <= 30 && ball.y - BR >= 30 - PH - 6 &&
        Math.abs(ball.x - aiX) <= PW / 2 + BR) {
      const off = (ball.x - aiX) / (PW / 2);
      ball.vx = off * 4.5;
      ball.vy = Math.abs(ball.vy) * 1.04;
      ball.y = 30 + BR + 1;
    }
    if (ball.y - BR > H) {
      aiTarget = W / 2 + (Math.random() - 0.5) * 60;
      die(false);
    } else if (ball.y + BR < 0) {
      aiTarget = W / 2 + (Math.random() - 0.5) * 60;
      die(true);
    }
  }

  function draw() {
    ctx.fillStyle = "#0f0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a2a38";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#7c6cf0";
    ctx.fillRect(aiX - PW / 2, 24 - PH / 2, PW, PH);
    ctx.fillStyle = "#4ecdc4";
    ctx.fillRect(playerX - PW / 2, H - 30 - PH / 2, PW, PH);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BR, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 40px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#9898b0";
    ctx.fillText(aiScore, W / 2, H / 2 - 30);
    ctx.fillText(playerScore, W / 2, H / 2 + 60);
    if (state === "ready") overlayText(ctx, W, H, ["Ready", "First to 7 wins", "Tap to serve"]);
    else if (state === "over") overlayText(ctx, W, H, [
      playerScore > aiScore ? "You Win!" : "AI Wins",
      `You ${playerScore} — ${aiScore} AI`,
      "Tap to play again"
    ]);
  }

  function loop() {
    if (!alive) return;
    if (state === "play") update();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function press() {
    if (!alive) return;
    if (state === "over") {
      reset(true);
      state = "play";
    } else if (state === "ready") {
      state = "play";
    }
  }

  function onKeyDown(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") { keys.add("left"); e.preventDefault(); }
    if (e.code === "ArrowRight" || e.code === "KeyD") { keys.add("right"); e.preventDefault(); }
    if (e.code === "Space") { e.preventDefault(); press(); }
  }
  function onKeyUp(e) {
    if (e.code === "ArrowLeft" || e.code === "KeyA") keys.delete("left");
    if (e.code === "ArrowRight" || e.code === "KeyD") keys.delete("right");
  }
  function onPointer(e) {
    const rect = c.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    if (clientX == null) {
      press();
      return;
    }
    playerX = Math.max(PW / 2, Math.min(W - PW / 2, (clientX - rect.left) * (W / rect.width)));
    if (state !== "play") press();
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

const GAMES = {
  wave: { name: "Wave", icon: "🌊", create: createWave },
  flappy: { name: "Flappy Bird", icon: "🐤", create: createFlappy },
  snake: { name: "Snake", icon: "🐍", create: createSnake },
  breakout: { name: "Breakout", icon: "🧱", create: createBreakout },
  memory: { name: "Memory Match", icon: "🃏", create: createMemory },
  gba: { name: "GBA Emulator", icon: "🕹️", create: createGba },
  tetris: { name: "Tetris", icon: "🟪", create: createTetris },
  game2048: { name: "2048", icon: "🔢", create: create2048 },
  pong: { name: "Pong", icon: "🏓", create: createPong }
};
