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

  // Each press goes out immediately (no waiting on the previous round trip).
  // Only a runaway backlog (e.g. a stuck hold-repeat) gets trimmed.
  let inflight = 0;
  const LOG = [];
  const SHORT = { "key:LeftTrigger": "LT", "key:RightTrigger": "RT", "key:LeftShoulder": "LB", "key:RightShoulder": "RB", rewind: "LT·REW", ff: "RT·FF", previous: "LB·PREV", next: "RB·NEXT" };
  function logLine(action, ok, ms, detail) {
    const t = new Date().toTimeString().slice(0, 8);
    const name = (SHORT[action] || action.replace("key:", "")).padEnd(8);
    LOG.unshift({ bad: !ok, text: `${t} ${name} ${ok ? "OK " : "ERR"} ${String(ms).padStart(4)}ms${detail ? "  " + detail : ""}` });
    LOG.length = Math.min(LOG.length, 40);
    const el = $("#log");
    if (el) el.innerHTML = LOG.map((l) => `<span class="${l.bad ? "bad" : ""}">${l.text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</span>`).join("\n");
  }
  function send(action, value) {
    if (!consoleSel) { toast("Pick a console in Settings", true); openSettings(); return; }
    if (inflight > 10) return;
    inflight++;
    const t0 = performance.now();
    return api("/api/cmd", { method: "POST", body: JSON.stringify({ consoleId: consoleSel.id, action, value }) })
      .then((res) => {
        const ms = Math.round(performance.now() - t0);
        logLine(action, res.ok !== false, ms, res.ok === false && res.status ? JSON.stringify(res.status).slice(0, 120) : "");
        $("#ping").textContent = `${String(Math.round(performance.now() - t0)).padStart(3, "0")}ms`;
        if (res.ok === false) toast(/Trigger|Shoulder|^ff$|^rewind$/.test(action) ? "CONSOLE IGNORED " + (SHORT[action] || action) : "Console reported an error", true);
        return res;
      })
      .catch((e) => {
        logLine(action, false, Math.round(performance.now() - t0), `${e.code || ""} ${e.message || ""}`.trim().slice(0, 160));
        if (/Trigger|Shoulder|^ff$|^rewind$/.test(action) && e.code === "command_failed") toast("CONSOLE REJECTED " + (SHORT[action] || action) + ": cloud API may not support it", true);
        else toast(explain(e), true);
      })
      .finally(() => { inflight--; });
  }

  // ---- trigger/bumper mode: real controller presses or media commands ----
  const TRIG = {
    buttons: { LT: "key:LeftTrigger", RT: "key:RightTrigger", LB: "key:LeftShoulder", RB: "key:RightShoulder" },
    media: { LT: "rewind", RT: "ff", LB: "previous", RB: "next" },
  };
  function setTrigMode(mode) {
    if (!TRIG[mode]) mode = "buttons";
    store.set("trigMode", mode);
    $$("[data-shoulder]").forEach((el) => { el.dataset.act = TRIG[mode][el.dataset.shoulder]; });
    $$("#trigMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  }
  $$("#trigMode button").forEach((b) => b.addEventListener("click", () => { setTrigMode(b.dataset.mode); toast(b.dataset.mode === "media" ? "TRIGGERS: MEDIA" : "TRIGGERS: CONTROLLER"); }));
  setTrigMode(store.get("trigMode", "buttons"));

  // ---- press feedback + simple buttons ----
  function flash(el) {
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 140);
  }
  $$("[data-act]").forEach((el) => {
    if (el.closest("#pad")) {
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); flash(el); send(el.dataset.act); }); // reads current mapping
    } else {
      el.addEventListener("click", () => { flash(el); send(el.dataset.act); });
    }
  });

  // iOS ignores user-scalable=no: block pinch and double-tap zoom, which were shifting the layout.
  ["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
  let lastEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastEnd < 350 && !e.target.closest("textarea, input, .sheet")) e.preventDefault();
    lastEnd = now;
  }, { passive: false });
  // if the keyboard sheet nudged the page, snap it back
  window.addEventListener("scroll", () => { if (window.scrollY) window.scrollTo(0, 0); });

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
  const svg = $("#pad"), touch = $("#touch"), hit = $("#touchHit"), rip = $("#rip");
  const SEG = { Up: "#segUp", Down: "#segDown", Left: "#segLeft", Right: "#segRight" };
  let g = null;

  function toSvg(e) {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }
  function lightSeg(dir, hold) {
    Object.values(SEG).forEach((s) => $(s).classList.remove("pressed"));
    if (!dir) return;
    const el = $(SEG[dir]);
    el.classList.add("pressed");
    if (!hold) setTimeout(() => { if (!g || !g.repT) el.classList.remove("pressed"); }, 150);
  }
  function armHold() {
    clearTimeout(g.holdT); clearInterval(g.repT); g.repT = null;
    g.holdT = setTimeout(() => {
      lightSeg(g.dir, true);
      g.repT = setInterval(() => send(`key:${g.dir}`), 160);
    }, 380);
  }
  hit.addEventListener("pointerdown", (e) => {
    hit.setPointerCapture?.(e.pointerId);
    touch.classList.add("active");
    g = { x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: Date.now(), fired: false, dir: null, repT: null };
  });
  hit.addEventListener("pointermove", (e) => {
    if (!g) return;
    const dx = e.clientX - g.ax, dy = e.clientY - g.ay;
    const need = g.fired ? 48 : 22; // first swipe triggers fast, follow-up steps need more travel
    if (Math.hypot(dx, dy) < need) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "Right" : "Left") : (dy > 0 ? "Down" : "Up");
    g.fired = true; g.dir = dir; g.ax = e.clientX; g.ay = e.clientY;
    send(`key:${dir}`);
    lightSeg(dir, false);
    armHold();
  });
  function endGesture(e, cancelled) {
    if (!g) return;
    clearTimeout(g.holdT); clearInterval(g.repT);
    lightSeg(null);
    touch.classList.remove("active");
    const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
    if (!cancelled && !g.fired && moved < 12 && Date.now() - g.t0 < 450) {
      const p = toSvg(e);
      rip.setAttribute("x", p.x - 18); rip.setAttribute("y", p.y - 18);
      rip.classList.remove("go"); void rip.getBBox(); rip.classList.add("go");
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

  $("#kbBtn").addEventListener("click", () => { closeSheets(); openSheet("#kbSheet"); setTimeout(() => $("#kbText").focus(), 50); });
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
  $("#copyLog").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(LOG.map((l) => l.text).join("\n")); toast("LOG COPIED"); } catch { toast("Copy failed: long-press the log instead", true); }
  });
  confirmTap($("#resetBtn"), "CONFIRM RESET", async () => {
    toast("RESETTING");
    try { await api("/api/reset", { method: "POST" }); } catch {}
    try { const regs = await navigator.serviceWorker?.getRegistrations(); await Promise.all((regs || []).map((r) => r.unregister())); } catch {}
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch {}
    store.del("mode");
    location.replace("/?r=" + Date.now());
  });
  confirmTap($("#unlinkBtn"), "CONFIRM SEVER", async () => {
    try { await api("/api/unlink", { method: "POST" }); toast("LINK SEVERED"); refreshStatus(); } catch (e) { toast(explain(e), true); }
  });

  // ---- boot ----
  paintConsole();
  const params = new URLSearchParams(location.search);
  if (params.get("r")) { history.replaceState(null, "", "/"); toast("RESET COMPLETE"); }
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
