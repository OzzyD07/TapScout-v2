// TapScout v2 local UI. No build step, no external scripts.

const $app = document.getElementById("app");
const $info = document.getElementById("hubinfo");
let cleanup = [];

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "");
const STATE_TR = {
  queued: "sırada",
  dispatching: "başlatılıyor",
  waiting_for_runner: "runner bekleniyor",
  preparing: "hazırlanıyor",
  ready: "hazır",
  disconnected: "bağlantı koptu",
  stopping: "durduruluyor",
  closed: "kapandı",
  failed: "başarısız",
};
const chip = (state) => `<span class="chip ${esc(state)}">${esc(STATE_TR[state] ?? state)}</span>`;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers:
      opts.body && typeof opts.body === "string"
        ? { "content-type": "application/json" }
        : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadInfo() {
  try {
    const c = await api("/api/config");
    $info.innerHTML = `<span>MCP: <code>${esc(c.mcpUrl)}</code></span><span>GitHub: ${esc(c.githubRepo ?? "yok (yalnızca yerel)")}</span><span>Tünel: ${esc(c.tunnel ?? "kapalı")}</span>`;
  } catch {
    $info.textContent = "hub'a ulaşılamıyor";
  }
}

// ---- Home -----------------------------------------------------------------------------

async function home() {
  $app.innerHTML = `
    <section class="panel">
      <h2>Yeni oturum</h2>
      <form id="new" class="grid-form">
        <label>Platform<select name="platform"><option value="android">Android</option><option value="ios">iOS</option></select></label>
        <label>Çalışacağı yer<select name="target"><option value="github">GitHub Actions</option><option value="local">Bu bilgisayar</option></select></label>
        <label>Build yolu (.apk / iOS .zip)<input name="buildPath" placeholder="C:\\builds\\app.apk"></label>
        <label>…veya dosya seç<input type="file" name="file" accept=".apk,.zip"></label>
        <label>Etiket<input name="label" placeholder="isteğe bağlı"></label>
        <label>Azami dakika<input name="maxMinutes" type="number" min="5" max="330" value="60"></label>
        <label>AVD (yerel Android)<input name="avd" placeholder="Pixel_7_Pro_API_36"></label>
        <button class="primary">Başlat</button>
      </form>
      <p class="small muted">Oturumları normalde MCP'ye bağlı ajan başlatır; bu form elle denemek içindir.</p>
      <p id="formerr" class="small" style="color:var(--bad)"></p>
    </section>
    <section class="panel"><h2>Oturumlar</h2><div id="list" class="muted">yükleniyor…</div></section>
    <section class="panel"><h2>Testler ve regresyon</h2><div id="tests" class="muted">yükleniyor…</div></section>`;
  renderTests();
  document.getElementById("new").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = document.getElementById("formerr");
    err.textContent = "";
    try {
      let buildPath = f.get("buildPath");
      const file = f.get("file");
      if (file?.size) {
        err.textContent = "dosya yükleniyor…";
        const up = await fetch(`/api/builds?name=${encodeURIComponent(file.name)}`, {
          method: "PUT",
          body: file,
        });
        buildPath = (await up.json()).path;
      }
      const s = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          platform: f.get("platform"),
          target: f.get("target"),
          buildPath,
          label: f.get("label") || undefined,
          maxMinutes: Number(f.get("maxMinutes")) || undefined,
          avd: f.get("avd") || undefined,
        }),
      });
      location.hash = `#/s/${s.id}`;
    } catch (error) {
      err.textContent = error.message;
    }
  });
  const render = async () => {
    const list = await api("/api/sessions").catch(() => []);
    const el = document.getElementById("list");
    if (!el) return;
    el.innerHTML = list.length
      ? `<table><tr><th>Oturum</th><th>Platform</th><th>Durum</th><th>Build</th><th>Oluşturma</th></tr>${list
          .map(
            (s) =>
              `<tr><td><a href="#/s/${s.id}">${esc(s.label || s.id.slice(0, 8))}</a></td><td>${esc(s.platform)} · ${esc(s.target)}</td><td>${chip(s.state)} <span class="small muted">${esc(s.stateMessage)}</span></td><td class="small">${esc(s.build.fileName)}</td><td class="small muted">${esc(new Date(s.createdAt).toLocaleString())}</td></tr>`,
          )
          .join("")}</table>`
      : "Henüz oturum yok.";
  };
  await render();
  const timer = setInterval(render, 4000);
  cleanup.push(() => clearInterval(timer));
}

// ---- Session --------------------------------------------------------------------------

async function sessionPage(id) {
  let data;
  try {
    data = await api(`/api/sessions/${id}`);
  } catch (e) {
    $app.innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  let tab = "seen";
  const events = data.events || [];
  $app.innerHTML = `
    <div class="session">
      <div>
        <section class="panel">
          <h2>Canlı yayın <span class="small muted">— yalnızca sizin için</span></h2>
          <div class="phone" id="phone"><div class="empty">Cihaz hazır olunca yayın burada görünür.</div></div>
          <p class="notice">Bu yayın modele gönderilmez. Ajan yalnızca araçların döndürdüğü durağan görüntüleri görür (sağdaki "Ajanın gördükleri"). Ekrana tıklamak dokunur, sürüklemek kaydırır.</p>
          <div class="controls">
            <button data-key="back">◀ Geri</button><button data-key="home">● Ana ekran</button><button data-act="restart">↻ Uygulamayı yeniden başlat</button>
          </div>
          <form class="controls" id="typeform"><input name="text" placeholder="Odaktaki alana yaz"><button>Yaz</button></form>
        </section>
      </div>
      <div>
        <section class="panel" id="status"></section>
        <section class="panel">
          <div class="tabs" id="tabs">
            <button data-tab="seen">Ajanın gördükleri</button><button data-tab="activity">Etkinlik</button><button data-tab="findings">Bulgular</button><button data-tab="files">Kanıt ve dosyalar</button>
          </div>
          <div id="tabbody"></div>
        </section>
      </div>
    </div>`;

  const renderStatus = (s) => {
    data = { ...data, ...s };
    const d = s.device;
    document.getElementById("status").innerHTML = `
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(s.label || `Oturum ${s.id.slice(0, 8)}`)} ${chip(s.state)}</h2>
        <div class="row"><button id="report">Rapor</button><button id="stop" class="danger" ${["closed", "failed"].includes(s.state) ? "disabled" : ""}>Durdur</button></div></div>
      <p class="small">${esc(s.stateMessage)}</p>
      <dl class="kv">
        <dt>Platform</dt><dd>${esc(s.platform)} · ${esc(s.target === "github" ? "GitHub Actions" : "yerel")}</dd>
        <dt>Build</dt><dd>${esc(s.build.fileName)}</dd>
        ${d ? `<dt>Cihaz</dt><dd>${esc(d.deviceName)} · ${esc(d.platform)} ${esc(d.osVersion)} · ${esc(d.appId)}</dd>` : ""}
        ${s.view ? `<dt>Ajan koordinatları</dt><dd>${s.view.width}×${s.view.height} görünüm birimi</dd>` : ""}
        ${s.github?.runUrl ? `<dt>GitHub</dt><dd><a href="${esc(s.github.runUrl)}" target="_blank" rel="noreferrer">çalıştırmayı aç</a> ${esc(s.github.step ?? s.github.status ?? "")}</dd>` : ""}
        <dt>Klasör</dt><dd class="small">${esc(data.sessionDir ?? "")}</dd>
      </dl>
      ${s.progress?.length && s.state !== "ready" ? `<h3>İlerleme</h3><div class="log">${s.progress.map((p) => `<div>${esc(p)}</div>`).join("")}</div>` : ""}`;
    document.getElementById("stop").onclick = async () => {
      if (!confirm("Oturum durdurulsun mu?")) return;
      await api(`/api/sessions/${id}/stop`, { method: "POST" }).catch((e) => alert(e.message));
    };
    document.getElementById("report").onclick = async () => {
      const r = await api(`/api/sessions/${id}/report`, { method: "POST" }).catch((e) =>
        alert(e.message),
      );
      if (r?.url) window.open(r.url, "_blank");
    };
    const phone = document.getElementById("phone");
    const live = s.state === "ready" || s.state === "disconnected";
    if (live && !phone.querySelector("img")) {
      phone.innerHTML = `<img id="screen" alt="canlı ekran" src="/api/sessions/${id}/stream.mjpeg">`;
      wireScreen(document.getElementById("screen"));
    } else if (!live && phone.querySelector("img")) {
      phone.innerHTML = `<div class="empty">Yayın yok (${esc(STATE_TR[s.state] ?? s.state)}).</div>`;
    }
  };

  const control = (body) =>
    api(`/api/sessions/${id}/control`, { method: "POST", body: JSON.stringify(body) }).catch((e) =>
      alert(e.message),
    );

  function wireScreen(img) {
    let down = null;
    const pos = (e) => {
      const r = img.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
        t: Date.now(),
      };
    };
    img.addEventListener("pointerdown", (e) => {
      down = pos(e);
    });
    img.addEventListener("pointerup", (e) => {
      if (!down) return;
      const up = pos(e);
      const dist = Math.hypot(up.x - down.x, up.y - down.y);
      if (dist < 0.02)
        control({ action: up.t - down.t > 600 ? "long_press" : "tap", x: down.x, y: down.y });
      else control({ action: "swipe", x: down.x, y: down.y, x2: up.x, y2: up.y });
      down = null;
    });
  }

  document.querySelectorAll("[data-key]").forEach((b) => {
    b.onclick = () => control({ action: "key", key: b.dataset.key });
  });
  document.querySelector("[data-act=restart]").onclick = () => control({ action: "restart" });
  document.getElementById("typeform").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    control({ action: "type", text: input.value });
    input.value = "";
  });

  const fileUrl = (rel) => `/files/${id}/${rel}`;
  const renderTab = () => {
    document.querySelectorAll("#tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    const body = document.getElementById("tabbody");
    if (tab === "seen") {
      const shots = events
        .filter((e) => e.kind === "tool" && e.images?.length)
        .slice()
        .reverse();
      body.innerHTML = shots.length
        ? `<p class="small muted">Ajana gerçekten gönderilen görüntüler (en yeni önce).</p><div class="seen">${shots
            .flatMap((e) =>
              e.images.map(
                (img) =>
                  `<figure><a href="${fileUrl(img)}" target="_blank"><img loading="lazy" src="${fileUrl(img)}"></a><figcaption><b>${esc(e.tool)}</b> ${esc(time(e.ts))}<br>${esc(e.summary)}</figcaption></figure>`,
              ),
            )
            .join("")}</div>`
        : `<p class="muted">Ajan henüz bir görüntü istemedi.</p>`;
    } else if (tab === "activity") {
      body.innerHTML = `<div class="log">${events
        .slice()
        .reverse()
        .map((e) => {
          const t = esc(time(e.ts));
          if (e.kind === "tool")
            return `<div class="${e.ok ? "" : "err"}">${t} <b>${esc(e.tool)}</b> ${esc(JSON.stringify(e.args))} → ${esc(e.summary)} <span class="muted">(${e.ms} ms)</span></div>`;
          if (e.kind === "state")
            return `<div>${t} durum: <b>${esc(STATE_TR[e.state] ?? e.state)}</b> — ${esc(e.message)}</div>`;
          if (e.kind === "runner")
            return `<div class="${e.level === "error" ? "err" : ""}">${t} runner: ${esc(e.message)}</div>`;
          if (e.kind === "finding")
            return `<div>${t} bulgu ${esc(e.id)}: ${esc(e.title)} (${esc(e.severity)})</div>`;
          if (e.kind === "evidence") return `<div>${t} kanıt ${esc(e.id)}: ${esc(e.label)}</div>`;
          if (e.kind === "file")
            return `<div>${t} dosya: ${esc(e.name)} (${e.sizeBytes} bayt)</div>`;
          return "";
        })
        .join("")}</div>`;
    } else if (tab === "findings") {
      const f = data.findings || [];
      body.innerHTML = f.length
        ? f
            .map(
              (
                x,
              ) => `<div class="finding ${esc(x.severity)}"><b>${esc(x.id)} [${esc(x.severity)}] ${esc(x.title)}</b> <span class="small muted">${esc(x.status)}${x.category ? ` · ${esc(x.category)}` : ""}</span>
          <p>${esc(x.description)}</p>${x.steps?.length ? `<ol>${x.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
          ${x.expected ? `<p class="small"><b>Beklenen:</b> ${esc(x.expected)}</p>` : ""}${x.actual ? `<p class="small"><b>Gerçekleşen:</b> ${esc(x.actual)}</p>` : ""}
          <div class="small">${x.evidence.map((ev) => esc(ev)).join(", ")}</div></div>`,
            )
            .join("")
        : `<p class="muted">Ajan henüz bulgu kaydetmedi.</p>`;
    } else {
      const files = events.filter((e) => e.kind === "file");
      const ev = data.evidence || [];
      body.innerHTML = `
        <h3>Kanıt paketleri</h3>${ev.length ? ev.map((x) => `<div class="small"><b>${esc(x.id)}</b> ${esc(x.label)} — ${x.files.map((f) => `<a href="${fileUrl(f)}" target="_blank">${esc(f.split("/").pop())}</a>`).join(", ")}</div>`).join("") : `<p class="muted small">yok</p>`}
        <h3>Cihazdan gelen dosyalar</h3>${
          files.length
            ? files
                .map((f) => {
                  const rel = `evidence/${f.name}`;
                  return /\.mp4$/.test(f.name)
                    ? `<div><video controls preload="metadata" src="${fileUrl(rel)}"></video><div class="small">${esc(f.name)}</div></div>`
                    : `<div class="small"><a href="${fileUrl(rel)}" target="_blank">${esc(f.name)}</a> (${f.sizeBytes} bayt)</div>`;
                })
                .join("")
            : `<p class="muted small">Loglar oturum kapanınca, kayıtlar durdurulunca gelir.</p>`
        }`;
    }
  };
  document.querySelectorAll("#tabs button").forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab;
      renderTab();
    };
  });
  renderStatus(data);
  renderTab();

  const sse = new EventSource(`/api/sessions/${id}/events`);
  sse.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "session") renderStatus(msg.session);
    if (msg.type === "event") {
      events.push(msg.event);
      if (msg.event.kind === "finding" || msg.event.kind === "evidence") {
        const fresh = await api(`/api/sessions/${id}`).catch(() => null);
        if (fresh) data = { ...data, findings: fresh.findings, evidence: fresh.evidence };
      }
      renderTab();
    }
  };
  cleanup.push(() => sse.close());
  cleanup.push(() => {
    const img = document.getElementById("screen");
    if (img) img.src = "";
  });
}

// ---- Tests ----------------------------------------------------------------------------

const RESULT_TR = { passed: "geçti", failed: "başarısız", error: "hata", skipped: "atlandı" };
const CLASS_TR = {
  regression: "REGRESYON",
  fixed: "düzeldi",
  still_failing: "hâlâ hatalı",
  stable: "kararlı",
  new: "yeni",
};
const buildText = (b) =>
  `${b.appVersion ? `v${b.appVersion}${b.appBuild ? ` (${b.appBuild})` : ""} ` : ""}${b.sha256.slice(0, 8)}`;
const resultChip = (t) =>
  `<span class="chip ${t.status === "passed" ? "ready" : t.status === "skipped" ? "" : "failed"}">${esc(RESULT_TR[t.status] ?? t.status)}</span>${
    t.classification && t.classification !== "new" && t.classification !== "stable"
      ? ` <span class="chip ${t.classification === "regression" ? "failed" : "ready"}">${esc(CLASS_TR[t.classification])}</span>`
      : ""
  }`;

async function renderTests() {
  const el = document.getElementById("tests");
  if (!el) return;
  const { tests, runs } = await api("/api/tests").catch(() => ({ tests: [], runs: [] }));
  if (!tests.length && !runs.length) {
    el.innerHTML =
      "Henüz test yok. Ajan bir akışı <code>test_record</code> ile kaydedince burada görünür.";
    return;
  }
  el.innerHTML = `
    <h3>Testler</h3>
    <table><tr><th>Test</th><th>Platform</th><th>Adım</th><th>Sürüm</th></tr>${tests
      .map(
        (t) =>
          `<tr><td><b>${esc(t.name)}</b><div class="small muted">${esc(t.id)}</div></td><td>${esc(t.platforms.join(", "))}</td><td>${t.steps.length}</td><td>v${t.version}</td></tr>`,
      )
      .join("")}</table>
    <h3>Son çalıştırmalar</h3>
    <table><tr><th>Çalıştırma</th><th>Platform</th><th>Build</th><th>Sonuç</th></tr>${runs
      .map((r) => {
        const passed = r.tests.filter((t) => t.status === "passed").length;
        const reg = r.tests.filter((t) => t.classification === "regression").length;
        return `<tr><td><a href="#/r/${r.id}">${esc(new Date(r.startedAt).toLocaleString())}</a></td><td>${esc(r.platform)}</td><td class="small">${esc(buildText(r.build))}</td><td>${passed}/${r.tests.length} geçti${reg ? ` <span class="chip failed">${reg} regresyon</span>` : ""}${r.state === "running" ? ' <span class="chip">sürüyor</span>' : ""}</td></tr>`;
      })
      .join("")}</table>`;
}

async function runPage(id) {
  let run;
  try {
    run = await api(`/api/test-runs/${id}`);
  } catch (e) {
    $app.innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  const file = (rel) => `/files/${run.sessionId}/${rel}`;
  $app.innerHTML = `
    <section class="panel">
      <h2>Test çalıştırması · ${esc(run.platform)} · build ${esc(buildText(run.build))}</h2>
      <p class="small muted">${esc(run.device ?? "")} · ${esc(run.build.fileName)} · ${esc(new Date(run.startedAt).toLocaleString())} · <a href="#/s/${run.sessionId}">oturum</a></p>
      ${run.tests
        .map(
          (t) => `<div class="finding ${t.status === "passed" ? "low" : "high"}">
            <b>${esc(t.testName)}</b> <span class="small muted">${esc(t.testId)} v${t.testVersion} · ${(t.durationMs / 1000).toFixed(1)} sn</span> ${resultChip(t)}
            ${t.previous ? `<div class="small muted">önceki build ${esc(t.previous.build)}: ${esc(RESULT_TR[t.previous.status] ?? t.previous.status)}</div>` : ""}
            ${t.message ? `<p class="small">${esc(t.message)}</p>` : ""}
            <ol class="small">${t.steps.map((s) => `<li class="${s.status === "passed" ? "" : "err"}">${esc(s.label)} — ${esc(s.status)}${s.message ? `: ${esc(s.message)}` : ""}</li>`).join("")}</ol>
            <div class="seen">${t.evidence
              .filter((e) => /\.jpe?g$/.test(e))
              .map(
                (e) =>
                  `<figure><a href="${file(e)}" target="_blank"><img src="${file(e)}"></a><figcaption>${esc(e.split("/").pop())}</figcaption></figure>`,
              )
              .join("")}</div>
            ${t.evidence
              .filter((e) => !/\.jpe?g$/.test(e))
              .map(
                (e) =>
                  `<a class="small" href="${file(e)}" target="_blank">${esc(e.split("/").pop())}</a> `,
              )
              .join("")}
          </div>`,
        )
        .join("")}
    </section>`;
}

function route() {
  for (const fn of cleanup) fn();
  cleanup = [];
  const m = /^#\/s\/([0-9a-f-]{36})/.exec(location.hash);
  const r = /^#\/r\/([0-9a-f-]{36})/.exec(location.hash);
  if (m) sessionPage(m[1]);
  else if (r) runPage(r[1]);
  else home();
}

window.addEventListener("hashchange", route);
loadInfo();
route();
