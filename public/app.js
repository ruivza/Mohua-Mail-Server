// Keep the short-lived session across reloads in this tab; never store login credentials.
function readSession() {
  try { return sessionStorage.getItem('mohua.admin.session') || ''; } catch { return ''; }
}
function saveSession(value) {
  try {
    if (value) sessionStorage.setItem('mohua.admin.session', value);
    else sessionStorage.removeItem('mohua.admin.session');
  } catch { /* Storage can be disabled; the current page can still sign in. */ }
}
let bearer = readSession(),
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
  saveSession('');
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
  route();
  $("dashboard").hidden = true;
  $("logout").hidden = true;
  for (const id of [
    "cards",
    "latest-run",
    "business-health",
    "traffic-summary",
    "recent-errors",
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
  $("push-section").hidden = me?.role !== "admin";
  $("page-title").textContent = {
    overview: t("服务概览"),
    status: t("运行状态"),
    users: t("用户管理"),
    settings: t("设置与会话"),
  }[page];
  if (!me) $("page-title").textContent = t("欢迎来到 Mohua");
  if (health && page === "overview") requestAnimationFrame(() => { chart("memory-chart", "memory"); chart("cpu-chart", "cpu"); });
}
window.addEventListener("hashchange", route);
function chart(id, field) {
  const target = $(id);
  if (target.querySelector("svg") && target.dataset.language === language &&
      (target.matches(":hover") || target.contains(document.activeElement))) return;
  target.dataset.language = language;
  target.replaceChildren();
  const start = health.now - 86400000;
  const points = health.samples.filter(p => Number.isFinite(p[field]) && p[field] >= 0 && p.at >= start && p.at <= health.now).sort((a,b) => a.at-b.at);
  if (!points.length) { target.textContent = t("等待采样"); return; }
  const unit = field === "memory" ? "MB" : "%";
  const peak = Math.max(...points.map(p => p[field]));
  const rawStep = Math.max(peak, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find(n => n * magnitude >= rawStep) * magnitude;
  const ceiling = step * 4;
  const width = Math.max(280, target.clientWidth || 440), height = 220;
  const left = 48, right = width - 14, top = 18, bottom = 174;
  const x = at => left + (at - start) / 86400000 * (right-left);
  const y = value => bottom - value / ceiling * (bottom-top);
  const number = value => new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  const ns = "http://www.w3.org/2000/svg";
  const el = (name, attrs = {}, text) => {
    const node = document.createElementNS(ns, name);
    for (const [key,value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = el("svg", {viewBox:`0 0 ${width} ${height}`, role:"group", tabindex:0,
    "aria-label": (field === "memory" ? t("内存") : "CPU") + " · " + unit + " · " + t("方向键查看采样详情"), class:"resource-chart"});
  svg.append(el("text", {x:left-8,y:12,"text-anchor":"end",class:"axis-label"},unit));
  for(let i=0;i<=4;i++) {
    const value=step*i, yy=y(value);
    svg.append(el("line",{x1:left,x2:right,y1:yy,y2:yy,class:"chart-grid"}));
    svg.append(el("text",{x:left-8,y:yy+4,"text-anchor":"end",class:"axis-label"},number(value)));
  }
  for(let i=0;i<=4;i++) {
    const at=start+i*86400000/4;
    svg.append(el("text",{x:x(at),y:bottom+23,"text-anchor":i===0?"start":i===4?"end":"middle",class:"axis-label"},new Date(at).toLocaleTimeString(language,{hour:"2-digit",minute:"2-digit",hour12:false})));
  }
  let segment=[];
  const draw=()=>{if(segment.length) svg.append(el("polyline",{points:segment.join(" "),class:"chart-line"}));segment=[];};
  points.forEach((p,i)=>{
    if(i && p.at-points[i-1].at>150000) draw();
    segment.push(`${x(p.at)},${y(p[field])}`);
  });draw();
  // Isolated samples remain visible without inventing data across gaps.
  points.forEach((p,i)=>{if((!i || p.at-points[i-1].at>150000) && (i===points.length-1 || points[i+1].at-p.at>150000)) svg.append(el("circle",{cx:x(p.at),cy:y(p[field]),r:2.5,class:"chart-dot"}));});
  const cursor=el("line",{y1:top,y2:bottom,class:"chart-cursor",visibility:"hidden"});
  const dot=el("circle",{r:4,class:"chart-dot",visibility:"hidden"});
  svg.append(cursor,dot);
  const tooltip=document.createElement("div"); tooltip.className="chart-tooltip";tooltip.hidden=true;
  const details=document.createElement("p");details.className="chart-summary";
  details.textContent=t("当前 ")+number(points.at(-1)[field])+" "+unit+t(" · 最高 ")+number(peak)+" "+unit+t(" · 空缺表示无数据");
  const announcement=document.createElement("span");announcement.className="visually-hidden";announcement.setAttribute("aria-live","polite");
  target.classList.add("chart-container");target.append(svg,tooltip,details,announcement);
  let index=points.length-1;
  const hide=()=>{tooltip.hidden=true;cursor.setAttribute("visibility","hidden");dot.setAttribute("visibility","hidden");};
  const show=(i,keyboard=false)=>{
    index=i;const p=points[i];
    const label=time(p.at)+" · "+number(p[field])+" "+unit;
    tooltip.textContent=label;tooltip.hidden=false;
    cursor.setAttribute("x1",x(p.at));cursor.setAttribute("x2",x(p.at));cursor.setAttribute("visibility","visible");
    dot.setAttribute("cx",x(p.at));dot.setAttribute("cy",y(p[field]));dot.setAttribute("visibility","visible");
    const rect=svg.getBoundingClientRect();
    tooltip.style.left=Math.max(0,Math.min(rect.width-tooltip.offsetWidth,x(p.at)/width*rect.width-tooltip.offsetWidth/2))+"px";
    tooltip.style.top=Math.max(0,y(p[field])/height*rect.height-tooltip.offsetHeight-10)+"px";
    if(keyboard) announcement.textContent=label;
  };
  const inspect=event=>{
    const position=svg.createSVGPoint();position.x=event.clientX;position.y=event.clientY;
    const matrix=svg.getScreenCTM();if(!matrix)return;
    const local=position.matrixTransform(matrix.inverse());
    if(local.x<left || local.x>right || local.y<top || local.y>bottom){hide();return;}
    const at=start+(local.x-left)/(right-left)*86400000;
    let closest=0;
    for(let i=1;i<points.length;i++)if(Math.abs(points[i].at-at)<Math.abs(points[closest].at-at))closest=i;
    // Snap within a few pixels; blank historical periods never imply a sample.
    if(Math.abs(x(points[closest].at)-local.x)>8){hide();return;}
    show(closest);
  };
  svg.addEventListener("pointermove",inspect);svg.addEventListener("pointerdown",inspect);
  svg.addEventListener("pointerleave",()=>{if(document.activeElement!==svg)hide();});
  svg.addEventListener("focus",()=>show(index,true));svg.addEventListener("blur",hide);
  svg.addEventListener("keydown",event=>{
    if(event.key==="Escape"){hide();return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();show(event.key==="Home"?0:event.key==="End"?points.length-1:Math.max(0,Math.min(points.length-1,index+(event.key==="ArrowLeft"?-1:1))),true);
  });
}
function renderOperations() {
  const { listeners: l, outgoing: o, notification: n } = health.business;
  const target = $("business-health");
  target.replaceChildren();
  const panels = [
    ["邮箱监听", "仅统计已启用监听的活跃账号；持续异常指超过五分钟未连接。", [
      ["应监听", l.expected], ["已连接", l.connected], ["连接中", l.connecting], ["重连中", l.reconnecting], ["未运行", l.missing], ["持续异常", l.prolonged]]],
    ["发信结果", "最近24小时创建的发送任务；副本异常可能与部分发送重叠。", [
      ["发送失败", o.failed], ["结果未知", o.unknown], ["部分发送", o.partial], ["发送中", o.sending], ["已发送副本异常", o.copy_issues]]],
    ["通知队列", n.enabled ? "仅监控提交网关；正常限流和退避不算超期。" : "推送未启用或未配置", [
      ["待处理", n.pending], ["重试中", n.retrying], ["已到期未处理", n.overdue], ["最长超期（秒）", n.overdueSeconds], ["异常设备", n.failedDevices]]],
  ];
  for (const [panelIndex, [title, note, values]] of panels.entries()) {
    const panel = document.createElement("section"), heading = document.createElement("h2"), help = document.createElement("p");
    heading.textContent = t(title); help.textContent = t(note);
    const content = document.createElement("div"); content.className = "operation-content";
    panel.append(heading, help, content);
    if (panelIndex === 0) {
      const headline = document.createElement("div"); headline.className = "operation-headline";
      headline.textContent = l.expected ? `${l.connected} / ${l.expected}` : t("未启用监听");
      content.append(headline);
      if (l.expected) {
        const caption=document.createElement("p");caption.textContent=t("已连接 / 应监听");content.append(caption);
        const bar=document.createElement("div");bar.className="listener-bar";bar.setAttribute("role","img");
        bar.setAttribute("aria-label", values.slice(1,5).map(([label,count])=>t(label)+": "+count).join(", "));
        for(const [key,label] of [["connected","已连接"],["connecting","连接中"],["reconnecting","重连中"],["missing","未运行"]]) {
          if(!l[key])continue;
          const part=document.createElement("span");part.className=key;part.style.flexGrow=l[key];part.title=t(label)+": "+l[key];bar.append(part);
        }
        content.append(bar);
      }
    }
    if (panelIndex === 2) {
      const headline=document.createElement("div");headline.className="operation-headline queue-headline";
      headline.textContent=!n.enabled?t("推送未启用或未配置"):n.failedDevices||n.overdueSeconds>=60?t("需要处理"):t("队列正常");
      if(n.enabled&&(n.failedDevices||n.overdueSeconds>=60))headline.classList.add("metric-issue");
      content.append(headline);
      values.sort((a,b)=>["最长超期（秒）","异常设备","待处理","重试中","已到期未处理"].indexOf(a[0])-["最长超期（秒）","异常设备","待处理","重试中","已到期未处理"].indexOf(b[0]));
    }
    for (const [label, count] of values) {
      if(panelIndex===0 && (["应监听","已连接"].includes(label)||!l.expected))continue;
      if(panelIndex===2 && (!n.enabled || (!count && !n.pending && !n.failedDevices)))continue;
      row(content, t(label), String(count));
      const issue = ["未运行", "持续异常", "发送失败", "结果未知", "部分发送", "已发送副本异常", "异常设备"].includes(label)
        || (["已到期未处理", "最长超期（秒）"].includes(label) && n.overdueSeconds >= 60);
      if (issue && count > 0) content.lastElementChild.classList.add("metric-issue");
    }
    target.append(panel);
  }
  const traffic = health.traffic;
  $("traffic-summary").replaceChildren();
  for (const [label, value] of [["请求数", traffic.requests], ["服务端错误", traffic.errors], ["连接中断", traffic.aborted], ["平均耗时（毫秒）", traffic.averageMs ?? "—"]]) row($("traffic-summary"), t(label), String(value));
  const recent = $("recent-errors"); recent.replaceChildren();
  if (!traffic.recent.length) { const empty = document.createElement("p"); empty.textContent = t("暂无接口异常"); recent.append(empty); }
  for (const error of traffic.recent) row(recent, `${error.method} · ${error.operation} · ${error.status ?? "—"}`, `${time(error.at)} · ${error.code}`);
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
    [t("监听连接"), health.business.listeners.expected ? health.business.listeners.connected + " / " + health.business.listeners.expected : t("未启用监听"), t("已连接 / 应监听")],
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
  renderOperations();
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
  $("runs").hidden = !health.runs.length;
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
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  route();
  await refreshSessions();
  if (me.role === "admin") {
    await refreshUsers();
    await refreshHealth();
    renderPush(await api("/admin/push"));

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
    saveSession(bearer);
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
  document.title = "Mohua Mail";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-label]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nLabel)); });
  syncPreferenceMenus();
  if (invitationCode) $("invitation").textContent = t("一次性邀请码（24 小时有效）：") + invitationCode;
  route();
  if (health) renderHealth();
  if (me) { renderSessions(); if (me.role === "admin") renderUsers(); }
  pushModeChanged();
}
function syncPreferenceMenus() {
  for (const kind of ["theme", "language"]) {
    document.querySelectorAll(`[data-${kind}-option]`).forEach(button => {
      button.setAttribute("aria-checked", String(button.dataset[kind + "Option"] === (kind === "theme" ? theme : language)));
    });
  }
  document.querySelectorAll("[data-theme-icon]").forEach(icon => { icon.hidden = icon.dataset.themeIcon !== theme; });
}
function closePreferenceMenus() {
  for (const kind of ["theme", "language"]) {
    $(kind + "-menu").hidden = true;
    $(kind).setAttribute("aria-expanded", "false");
  }
}
for (const kind of ["theme", "language"]) {
  const trigger = $(kind), menu = $(kind + "-menu");
  function openMenu(last = false) {
    closePreferenceMenus();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const items = menu.querySelectorAll("button");
    (last ? items[items.length - 1] : menu.querySelector('[aria-checked="true"]') || items[0]).focus();
  }
  trigger.onclick = () => { if (menu.hidden) openMenu(); else closePreferenceMenus(); };
  trigger.onkeydown = event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); openMenu(event.key === "ArrowUp"); }
  };
  menu.onclick = event => {
    const option = event.target.closest(`[data-${kind}-option]`);
    if (!option) return;
    const value = option.dataset[kind + "Option"];
    if (kind === "theme") { theme = value; savePreference(kind, value); applyTheme(); }
    else {
      language = value; savePreference(kind, value);
      message(""); $("push-result").textContent = ""; applyLanguage();
    }
    syncPreferenceMenus(); closePreferenceMenus(); trigger.focus();
  };
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }
  };
}
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const kind = ["theme", "language"].find(kind => !$(kind + "-menu").hidden);
  if (kind) { closePreferenceMenus(); $(kind).focus(); }
});
document.addEventListener("click", event => { if (!event.target.closest(".preference-picker")) closePreferenceMenus(); });
document.addEventListener("focusin", event => { if (!event.target.closest(".preference-picker")) closePreferenceMenus(); });
applyLanguage();

let chartResize;
window.addEventListener("resize", () => { clearTimeout(chartResize); chartResize = setTimeout(() => { if (health) { chart("memory-chart", "memory"); chart("cpu-chart", "cpu"); } }, 120); });

if (bearer) void enter().catch((error) => message(error.message));
