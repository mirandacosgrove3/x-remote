// Couch — Xbox remote PWA. Every tap is one independent HTTPS request,
// so there's no connection to drop when the phone locks.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ---- tiny storage wrapper (localStorage can throw in some contexts) ----
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let pin = store.get("pin", "");
  let consoleSel = store.get("console", null); // {id, name, power}
  let linked = false;

  // ---- toast ----
  let toastT;
  function toast(msg, err = false) {
    const t = $("#toast");
    $("#toastTag").textContent = err ? "WARNING" : "INFO";
    $("#toastMsg").textContent = msg;
    t.classList.toggle("err", err);
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), err ? 3200 : 1600);
  }

  // ---- API ----
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      ...opts,
      headers: { "x-pin": pin, "Content-Type": "application/json", ...(opts.headers || {}) },
      cache: "no-store",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.detail || j.error || r.status);
      e.code = j.error; e.status = r.status;
      throw e;
    }
    return j;
  }

  function explain(e) {
    switch (e.code) {
      case "bad_pin": openSettings(); return "Enter your remote PIN";
      case "not_linked": openSettings(); return "Sign in with Microsoft first";
      case "bad_console": openSettings(); return "Pick a console";
      case "xsts_failed": return "Xbox Live refused the account (no Xbox profile, or child account)";
      case "ms_token_failed": return "Microsoft login expired, sign in again";
      case "command_failed": return "Console didn't take it. Is it on, with remote features enabled?";
    }
    return navigator.onLine ? `Error: ${e.message}` : "You're offline";
  }

  // Commands go out one at a time so D-pad presses stay in order.
  let chain = Promise.resolve();
  let pending = 0;
  function send(action, value) {
    if (!consoleSel) { toast("Pick a console in Settings", true); openSettings(); return; }
    if (pending > 4) return; // don't let held buttons build a backlog
    pending++;
    chain = chain.then(async () => {
      const t0 = performance.now();
      try {
        const res = await api("/api/cmd", { method: "POST", body: JSON.stringify({ consoleId: consoleSel.id, action, value }) });
        $("#ping").textContent = `${String(Math.round(performance.now() - t0)).padStart(3, "0")}ms`;
        if (res.ok === false) toast("Console reported an error", true);
        return res;
      } catch (e) {
        toast(explain(e), true);
      } finally {
        pending--;
      }
    });
    return chain;
  }

  // ---- press feedback + simple buttons ----
  function flash(el) {
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 140);
  }
  $$("[data-act]").forEach((el) => {
    el.addEventListener("click", () => { flash(el); send(el.dataset.act); });
  });

  // ---- buttons that repeat while held (D-pad, volume) ----
  $$("[data-rep]").forEach((el) => {
    let delay, rep;
    const stop = () => { clearTimeout(delay); clearInterval(rep); el.classList.remove("pressed"); };
    el.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      el.setPointerCapture?.(ev.pointerId);
      el.classList.add("pressed");
      send(el.dataset.rep);
      delay = setTimeout(() => { rep = setInterval(() => send(el.dataset.rep), 170); }, 420);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => el.addEventListener(t, stop));
  });

  // ---- power: tap = on, hold = off ----
  $$("[data-hold]").forEach((el) => {
    let timer, held;
    el.addEventListener("pointerdown", () => {
      held = false;
      el.classList.add("pressed");
      timer = setTimeout(() => { held = true; toast("SHUTDOWN SEQUENCE"); send(el.dataset.hold); }, 750);
    });
    const end = () => {
      clearTimeout(timer);
      el.classList.remove("pressed");
    };
    el.addEventListener("pointerup", () => {
      end();
      if (!held) { toast("WAKE SIGNAL SENT"); send(el.dataset.tap); }
      held = true;
    });
    el.addEventListener("pointercancel", () => { end(); held = true; });
  });

  // ---- toggles ----
  let muted = false, playing = true;
  $("#muteBtn").addEventListener("click", (e) => {
    flash(e.currentTarget); muted = !muted;
    send(muted ? "mute" : "unmute");
    $("#muteTxt").textContent = muted ? "UNMUTE" : "MUTE";
    e.currentTarget.classList.toggle("on", muted);
  });
  $("#playBtn").addEventListener("click", (e) => { flash(e.currentTarget); playing = !playing; send(playing ? "play" : "pause"); });

  // ---- touch sensor (inside the SVG) ----
  const svg = $("#pad"), touch = $("#touch"), hit = $("#touchHit");
  const dirTxt = $("#dirTxt"), rip = $("#rip"), coord = $("#coord");
  const GLYPH = { Up: "▲ UP", Down: "▼ DOWN", Left: "◀ LEFT", Right: "RIGHT ▶" };
  const box = { x: 18, y: 404, w: 190, h: 196 };
  let g = null;

  function toSvg(e) {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  function showCoord(e) {
    const p = toSvg(e);
    const nx = Math.min(1, Math.max(0, (p.x - box.x) / box.w));
    const ny = Math.min(1, Math.max(0, (p.y - box.y) / box.h));
    coord.textContent = `X${nx.toFixed(2)} Y${ny.toFixed(2)}`;
  }
  function fireDir(dir) {
    send(`key:${dir}`);
    dirTxt.textContent = GLYPH[dir];
    dirTxt.classList.remove("go", "hold"); void dirTxt.getBBox(); dirTxt.classList.add("go");
  }
  function armHold() {
    clearTimeout(g.holdT); clearInterval(g.repT);
    g.holdT = setTimeout(() => {
      dirTxt.classList.remove("go"); dirTxt.classList.add("hold");
      g.repT = setInterval(() => send(`key:${g.dir}`), 160);
    }, 380);
  }
  hit.addEventListener("pointerdown", (e) => {
    hit.setPointerCapture?.(e.pointerId);
    touch.classList.add("active");
    showCoord(e);
    g = { x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: Date.now(), fired: false, dir: null };
  });
  hit.addEventListener("pointermove", (e) => {
    if (!g) return;
    showCoord(e);
    const dx = e.clientX - g.ax, dy = e.clientY - g.ay;
    const need = g.fired ? 56 : 26; // first swipe triggers fast, follow-up steps need more travel
    if (Math.hypot(dx, dy) < need) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "Right" : "Left") : (dy > 0 ? "Down" : "Up");
    g.fired = true; g.dir = dir; g.ax = e.clientX; g.ay = e.clientY;
    fireDir(dir);
    armHold();
  });
  function endGesture(e, cancelled) {
    if (!g) return;
    clearTimeout(g.holdT); clearInterval(g.repT);
    dirTxt.classList.remove("hold");
    touch.classList.remove("active");
    const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
    if (!cancelled && !g.fired && moved < 14 && Date.now() - g.t0 < 450) {
      const p = toSvg(e);
      rip.setAttribute("x", p.x - 22); rip.setAttribute("y", p.y - 22);
      rip.classList.remove("go"); void rip.getBBox(); rip.classList.add("go");
      dirTxt.textContent = "◆ A"; dirTxt.classList.remove("go"); void dirTxt.getBBox(); dirTxt.classList.add("go");
      send("key:A");
    }
    g = null;
  }
  hit.addEventListener("pointerup", (e) => endGesture(e, false));
  hit.addEventListener("pointercancel", (e) => endGesture(e, true));

  // ---- sheets ----
  function openSheet(id) { $(id).classList.remove("hidden"); }
  function closeSheets() { $$(".sheet-backdrop").forEach((s) => s.classList.add("hidden")); }
  $$("[data-close]").forEach((b) => b.addEventListener("click", closeSheets));
  $$(".sheet-backdrop").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s) closeSheets(); }));

  $("#kbBtn").addEventListener("click", () => { openSheet("#kbSheet"); setTimeout(() => $("#kbText").focus(), 50); });
  $("#kbSend").addEventListener("click", async () => {
    const v = $("#kbText").value;
    if (!v) return;
    const res = await send("text", v);
    if (res) { toast("TRANSMITTED"); $("#kbText").value = ""; }
  });

  function openSettings() {
    $("#pinInput").value = pin;
    openSheet("#setSheet");
    refreshStatus();
  }
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#consoleBtn").addEventListener("click", openSettings);

  $("#pinSave").addEventListener("click", () => {
    pin = $("#pinInput").value.trim();
    store.set("pin", pin);
    toast("ACCESS CODE STORED");
    refreshStatus();
  });

  // Sign-in posts the PIN in a form body (never in the URL).
  $("#linkBtn").addEventListener("click", (e) => {
    e.preventDefault();
    if (!pin) { toast("Save your PIN first", true); return; }
    const f = document.createElement("form");
    f.method = "POST"; f.action = "/auth/login";
    const i = document.createElement("input");
    i.type = "hidden"; i.name = "pin"; i.value = pin;
    f.appendChild(i); document.body.appendChild(f); f.submit();
  });

  async function refreshStatus() {
    const badge = $("#linkBadge");
    if (!pin) { badge.textContent = "NO CODE"; badge.classList.remove("ok"); return; }
    try {
      const s = await api("/api/status");
      linked = s.linked;
      badge.textContent = s.linked ? (s.mock ? "LINKED · MOCK" : "LINKED") : "NOT LINKED";
      badge.classList.toggle("ok", s.linked);
      if (s.linked) loadConsoles();
    } catch (e) {
      badge.textContent = e.code === "bad_pin" ? "CODE REJECTED" : "OFFLINE";
      badge.classList.remove("ok");
    }
  }

  async function loadConsoles() {
    const list = $("#consoleList");
    list.innerHTML = '<p class="muted small">Loading…</p>';
    try {
      const { consoles } = await api("/api/consoles");
      if (!consoles.length) { list.innerHTML = '<p class="muted small">No consoles on this account.</p>'; return; }
      list.innerHTML = "";
      consoles.forEach((c) => {
        const b = document.createElement("button");
        b.className = "console-opt" + (consoleSel && consoleSel.id === c.id ? " sel" : "");
        const name = document.createElement("span"); name.textContent = c.name;
        const meta = document.createElement("small");
        meta.textContent = `${c.power}${c.remoteEnabled === false ? " · remote features OFF" : ""}`;
        b.append(name, meta);
        b.addEventListener("click", () => { selectConsole(c); loadConsoles(); });
        list.appendChild(b);
      });
      if (!consoleSel && consoles.length === 1) selectConsole(consoles[0]);
      else if (consoleSel) {
        const cur = consoles.find((c) => c.id === consoleSel.id);
        if (cur) selectConsole(cur);
      }
    } catch (e) {
      list.innerHTML = "";
      const p = document.createElement("p"); p.className = "muted small"; p.textContent = explain(e);
      list.appendChild(p);
    }
  }
  $("#refreshConsoles").addEventListener("click", loadConsoles);

  function selectConsole(c) {
    consoleSel = { id: c.id, name: c.name, power: c.power };
    store.set("console", consoleSel);
    paintConsole();
  }
  function paintConsole() {
    $("#consoleName").textContent = consoleSel ? consoleSel.name.toUpperCase() : "NO SIGNAL";
    const st = $("#statTxt");
    const on = consoleSel && consoleSel.power === "On";
    st.textContent = !consoleSel ? "STANDBY" : on ? "ACTIVE" : (consoleSel.power || "ASLEEP").toUpperCase();
    st.className = "lb-val " + (on ? "ok" : consoleSel ? "warn" : "");
  }

  // Two-tap confirm for the drastic stuff (no browser dialogs).
  function confirmTap(btn, label, fn) {
    const orig = btn.textContent;
    btn.addEventListener("click", () => {
      if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = orig; fn(); return; }
      btn.dataset.armed = "1"; btn.textContent = label;
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = orig; }, 2500);
    });
  }
  confirmTap($("#rebootBtn"), "CONFIRM RESTART", () => { send("reboot"); toast("RESTART SEQUENCE"); });
  confirmTap($("#offBtn"), "CONFIRM SHUTDOWN", () => { send("power_off"); toast("SHUTDOWN SEQUENCE"); });
  confirmTap($("#unlinkBtn"), "CONFIRM SEVER", async () => {
    try { await api("/api/unlink", { method: "POST" }); toast("LINK SEVERED"); refreshStatus(); } catch (e) { toast(explain(e), true); }
  });

  // ---- boot ----
  paintConsole();
  const params = new URLSearchParams(location.search);
  if (params.get("linked")) {
    history.replaceState(null, "", "/");
    toast("MICROSOFT LINK ESTABLISHED");
    openSettings();
  } else if (!pin || !consoleSel) {
    openSettings();
  } else {
    // quietly refresh the console's power state when the app opens / comes back
    api("/api/consoles").then(({ consoles }) => {
      const cur = consoles.find((c) => c.id === consoleSel.id);
      if (cur) selectConsole(cur);
    }).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && pin && consoleSel) {
      api("/api/consoles").then(({ consoles }) => {
        const cur = consoles.find((c) => c.id === consoleSel.id);
        if (cur) selectConsole(cur);
      }).catch(() => {});
    }
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
