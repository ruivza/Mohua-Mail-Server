let bearer = "",
  me,
  health,
  poll,
  busy = false,
  epoch = 0;
const $ = (id) => document.getElementById(id),
  message = (text) => {
    $("message").textContent = t(text);
  };
const statusLabels = {
  ok: "正常",
  error: "失败",
  external_error: "外部连接异常",
  unknown: "未知",
  running: "进行中",
};
const stageLabels = {
  account: "准备测试账号",
  smtp_connect: "连接 SMTP",
  smtp_submit: "提交测试邮件",
  imap_connect: "连接 IMAP",
  imap_read: "读取并核对",
  cleanup: "清理测试邮件",
  complete: "完成",
  interrupted: "服务重启中断",
};
const time = (t) => new Date(t).toLocaleString(language);
async function api(path, method = "GET", data) {
  const response = await fetch("/api" + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) lock();
    throw Error(t(body.error));
  }
  return body;
}
function lock() {
  epoch++;
  clearInterval(poll);
  bearer = "";
  me = null;
  health = null;
  invitationCode = "";
  sessionData = [];
  userData = [];
  message("");
  $("login").reset();
  pushConfig = null;
  $("push-settings").reset();
  $("push-result").textContent = "";
  document.body.classList.add("signed-out");
  $("auth-shell").hidden = false;
  $("connection-state").textContent = t("等待登录");
  $("connection-state").classList.remove("connected");
  route();
  $("dashboard").hidden = true;
  $("logout").hidden = true;
  for (const id of [
    "cards",
    "latest-run",
    "status-bars",
    "runs",
    "user-list",
    "devices",
    "invitation",
  ])
    $(id).replaceChildren();
}
function row(container, title, subtitle, label, action) {
  const e = document.createElement("div");
  e.className = "row";
  const text = document.createElement("div");
  text.textContent = title;
  const hint = document.createElement("small");
  hint.textContent = subtitle;
  text.append(hint);
  e.append(text);
  if (action) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action();
      } catch (err) {
        message(err.message);
      } finally {
        b.disabled = false;
      }
    };
    e.append(b);
  }
  container.append(e);
}
function route() {
  let page = location.hash.slice(1) || "overview";
  if (!["overview", "status", "users", "settings"].includes(page))
    page = "overview";
  if (me && me.role !== "admin") page = "settings";
  document
    .querySelectorAll(".page")
    .forEach((el) => (el.hidden = el.id !== page));
  document.querySelectorAll("nav a").forEach((a) => {
    a.classList.toggle("active", a.hash === "#" + page);
    if (a.hash === "#" + page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    a.hidden = !!me && me.role !== "admin" && a.hash !== "#settings";
  });
  $("schedule-section").hidden = me?.role !== "admin";
  $("push-section").hidden = me?.role !== "admin";
  $("page-title").textContent = {
    overview: t("服务概览"),
    status: t("运行状态"),
    users: t("用户管理"),
    settings: t("设置与会话"),
  }[page];
  if (!me) $("page-title").textContent = t("欢迎来到 Mohua");
}
window.addEventListener("hashchange", route);
function bars(target) {
  target.replaceChildren();
  for (const [key, name] of [
    ["api", t("API 进程心跳")],
    ["db", t("数据库读写")],
    ["worker", t("后台调度心跳")],
    ["mail", t("外部邮件链路")],
  ]) {
    const wrap = document.createElement("div");
    wrap.className = "service-bar";
    const title = document.createElement("strong");
    title.textContent = name;
    wrap.append(title);
    const bar = document.createElement("div");
    bar.className = "uptime";
    const width = 30 * 60000,
      end = Math.ceil(health.now / width) * width;
    for (let i = 0; i < 48; i++) {
      const from = end - (48 - i) * width,
        to = from + width;
      const records = (key === "mail" ? health.runs : health.samples).filter(
        (r) => (r.started ?? r.at) >= from && (r.started ?? r.at) < to,
      );
      let state = "unknown";
      if (records.length) {
        const states = records.map((r) => (key === "mail" ? r.status : r[key]));
        state = states.includes("error")
          ? "error"
          : states.includes("external_error")
            ? "external_error"
            : states.includes("running")
              ? "running"
              : states.every((s) => s === "ok")
                ? "ok"
                : "unknown";
      }
      const cell = document.createElement("button");
      cell.className = "cell " + state;
      cell.title =
        time(from) +
        " — " +
        time(to) +
        " · " +
        t(statusLabels[state]) +
        " · " +
        records.length +
        t(" 次采样");
      cell.setAttribute("aria-label", cell.title);
      cell.onclick = () => message(cell.title);
      bar.append(cell);
    }
    wrap.append(bar);
    target.append(wrap);
  }
}
function chart(id, field) {
  const target = $(id);
  target.replaceChildren();
  const points = health.samples;
  if (!points.length) {
    target.textContent = t("等待采样");
    return;
  }
  const max = Math.max(1, ...points.map((p) => p[field]));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 500 110");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", field + t(" 最近24小时趋势，最高 ") + max);
  let segment = [];
  const draw = () => {
    if (!segment.length) return;
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", segment.join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#398767");
    line.setAttribute("stroke-width", "2");
    svg.append(line);
    segment = [];
  };
  points.forEach((p, i) => {
    if (i && p.at - points[i - 1].at > 150000) draw();
    const x = 5 + ((p.at - (health.now - 86400000)) / 86400000) * 490,
      y = 100 - (p[field] / max) * 90;
    segment.push(x + "," + y);
    const dot = document.createElementNS(svg.namespaceURI, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", "2");
    dot.setAttribute("fill", "#398767");
    svg.append(dot);
  });
  draw();
  target.append(svg);
  const p = document.createElement("p");
  p.textContent =
    t("当前 ") + points.at(-1)[field] + t(" · 最高 ") + max + t(" · 空缺表示无数据");
  target.append(p);
}
function renderHealth() {
  const latest = health.latest;
  $("updated-at").textContent = t("更新于 ") + new Date(health.now).toLocaleTimeString(language);
  $("cards").replaceChildren();
  for (const [title, value, sub] of [
    [
      t("托管用户"),
      health.counts.users + t(" 位"),
      t("启用 ") + health.counts.activeUsers + t(" 位"),
    ],
    [
      t("托管邮箱"),
      health.counts.mailboxes + t(" 个"),
      t("已添加的邮箱配置 · 不含自检账号"),
    ],
    [
      t("运行时间"),
      Math.floor(health.uptimeSeconds / 60) + t(" 分钟"),
      t("当前进程 · Server v0.8.0"),
    ],
    [t("进程资源"), latest.memory + " MB", "CPU " + latest.cpu + "%"],
  ]) {
    const card = document.createElement("section");
    const s = document.createElement("small");
    s.textContent = title;
    const h = document.createElement("h2");
    h.textContent = value;
    const p = document.createElement("p");
    p.textContent = sub;
    card.append(s, h, p);
    $("cards").append(card);
  }
  bars($("status-bars"));
  chart("memory-chart", "memory");
  chart("cpu-chart", "cpu");
  const last = health.runs[0];
  $("latest-run").textContent = last
    ? t(statusLabels[last.status]) +
      " · " +
      t(stageLabels[last.stage]) +
      " · " +
      time(last.started)
    : t("尚未运行自检，首次点击会创建独立测试账号。");
  $("runs").replaceChildren();
  if (!health.runs.length) $("runs").textContent = t("尚无自检记录");
  for (const r of health.runs)
    row(
      $("runs"),
      t(statusLabels[r.status]) + " · " + time(r.started),
      t(stageLabels[r.stage]) +
        " · " +
        (r.duration / 1000).toFixed(1) +
        t(" 秒 · ") +
        t(r.detail),
    );
  document.querySelectorAll(".run-test").forEach((b) => {
    b.disabled = health.running;
    b.textContent = health.running ? t("自检进行中…") : t("立即自检");
  });
  $("account-status").textContent = health.settings.accountReady
    ? t("独立测试账号已加密保存")
    : t("尚未创建测试账号");
}
async function refreshHealth() {
  if (me?.role !== "admin" || busy) return;
  busy = true;
  const current = epoch;
  try {
    const value = await api("/admin/health");
    if (current !== epoch) return;
    health = value;
    renderHealth();
  } finally {
    busy = false;
  }
}
let sessionData = [], userData = [], invitationCode = "";
async function refreshSessions() {
  const current = epoch;
  const devices = await api("/devices");
  if (current !== epoch || !me) return;
  sessionData = devices;
  renderSessions();
}
function renderSessions() {
  const devices = sessionData;
  $("devices").replaceChildren();
  for (const d of devices)
    row(
      $("devices"),
      d.name,
      d.id === me.sessionId ? t("当前会话") : t("到期 ") + time(d.expires),
      t("撤销"),
      async () => {
        await api("/devices/" + d.id, "DELETE");
        if (d.id === me.sessionId) lock();
        else await refreshSessions();
      },
    );
}
async function refreshUsers() {
  const current = epoch;
  const users = await api("/admin/users");
  if (current !== epoch || !me) return;
  userData = users;
  renderUsers();
}
function renderUsers() {
  const users = userData;
  $("user-list").replaceChildren();
  if (!users.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("还没有用户。生成邀请，让第一位用户加入你的 Mohua。");
    $("user-list").append(empty);
  }
  for (const u of users)
    row(
      $("user-list"),
      u.email,
      t(u.role) + " · " + (u.active ? t("已启用") : t("已停用")),
      u.active ? t("停用") : t("启用"),
      u.id === me.id
        ? null
        : async () => {
            await api("/admin/users/" + u.id, "PATCH", { active: !u.active });
            await refreshUsers();
          },
    );
}
async function enter() {
  me = await api("/me");
  document.body.classList.remove("signed-out");
  $("auth-shell").hidden = true;
  $("connection-state").textContent = t("已登录");
  $("connection-state").classList.add("connected");
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  route();
  await refreshSessions();
  if (me.role === "admin") {
    await refreshUsers();
    await refreshHealth();
    renderPush(await api("/admin/push"));
    $("schedule").elements.enabled.checked = health.settings.enabled;
    $("schedule").elements.intervalMinutes.value = String(
      health.settings.intervalMinutes,
    );
    clearInterval(poll);
    poll = setInterval(
      () => refreshHealth().catch((e) => message(t("状态更新失败：") + e.message)),
      5000,
    );
  }
}
$("login").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api(
      "/login",
      "POST",
      Object.fromEntries(new FormData(e.target)),
    );
    bearer = r.token;
    e.target.password.value = "";
    e.target.setupToken.value = "";
    message("");
    await enter();
  } catch (err) {
    message(err.message);
  }
};
$("setup").onclick = async () => {
  if (!$("login").reportValidity()) return;
  try {
    await api("/setup", "POST", Object.fromEntries(new FormData($("login"))));
    $("login").setupToken.value = "";
    message(t("管理员已创建，请登录。"));
  } catch (e) {
    message(e.message);
  }
};
$("logout").onclick = async () => {
  try {
    await api("/logout", "POST", {});
  } finally {
    lock();
  }
};
$("invite").onclick = async () => {
  try {
    const r = await api("/admin/invites", "POST", {}, bearer);
    invitationCode = r.invite;
    $("invitation").textContent = t("一次性邀请码（24 小时有效）：") + invitationCode;
  } catch (e) {
    message(e.message);
  }
};
document.querySelectorAll(".run-test").forEach(
  (b) =>
    (b.onclick = async () => {
      document
        .querySelectorAll(".run-test")
        .forEach((x) => (x.disabled = true));
      try {
        await api("/admin/health/run", "POST", {});
        message(t("自检已启动，结果会自动更新。"));
      } catch (e) {
        message(e.message);
      } finally {
        await refreshHealth();
      }
    }),
);
$("schedule").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/admin/health/settings", "PATCH", {
      enabled: e.target.elements.enabled.checked,
      intervalMinutes: Number(e.target.elements.intervalMinutes.value),
    });
    message(t("自检计划已保存。"));
    await refreshHealth();
  } catch (err) {
    message(err.message);
  }
};

let pushConfig;
function renderPush(value) {
  pushConfig = value;
  const form = $("push-settings");
  form.elements.mode.value = value.mode;
  form.elements.customUrl.value = value.customUrl;
  pushModeChanged();
}
function pushModeChanged() {
  const mode = $("push-mode").value;
  $("custom-gateway-field").hidden = mode !== "custom";
  $("push-settings").elements.customUrl.required = mode === "custom";
  $("push-description").textContent =
    mode === "disabled"
      ? t("不联系推送网关，客户端仍可收发邮件和手动刷新。")
      : mode === "official"
        ? pushConfig?.officialUrl
          ? t("官方网关：") + pushConfig.officialUrl
          : t("官方网关地址尚未配置，保存后仍不会发送推送。")
        : t("请填写兼容 Mohua Gateway v1 的 HTTPS 地址，并使用该网关对应的客户端。");
}
$("push-mode").onchange = pushModeChanged;
$("push-settings").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const current = epoch;
  try {
    const value = await api(
      "/admin/push",
      "PATCH",
      Object.fromEntries(new FormData(event.target)),
    );
    if (epoch !== current) return;
    renderPush(value);
    $("push-result").textContent =
      t("已保存。切换配置后，客户端重新打开时登记推送。");
  } catch (error) {
    if (epoch === current) $("push-result").textContent = t(error.message);
  } finally {
    button.disabled = false;
  }
};
$("test-gateway").onclick = async (event) => {
  const button = event.target,
    current = epoch;
  button.disabled = true;
  try {
    const result = await api("/admin/push/test", "POST", {});
    if (epoch === current) $("push-result").textContent = t(result.reason);
  } catch (error) {
    if (epoch === current) $("push-result").textContent = t(error.message);
  } finally {
    button.disabled = false;
  }
};

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = "Mohua · " + t("服务控制台");
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-label]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nLabel)); });
  $("language").value = language;
  $("connection-state").textContent = t(me ? "已登录" : "等待登录");
  if (invitationCode) $("invitation").textContent = t("一次性邀请码（24 小时有效）：") + invitationCode;
  route();
  if (health) renderHealth();
  if (me) { renderSessions(); if (me.role === "admin") renderUsers(); }
  pushModeChanged();
}
$("language").onchange = event => {
  language = event.target.value;
  savePreference("language", language);
  message("");
  $("push-result").textContent = "";
  applyLanguage();
};
$("theme").value = theme;
$("theme").onchange = event => { theme = event.target.value; savePreference("theme", theme); applyTheme(); };
applyLanguage();
