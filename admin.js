const CONFIG = window.SFMC_SYNC_CONFIG || {};
const SUPABASE_MODULE = CONFIG.supabaseModule || "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.2/+esm";
const ADMIN_AUTH_KEY = "sfmc-admin-auth-v1";
const ADMIN_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const ui = {
  login: document.getElementById("adminLogin"),
  loginForm: document.getElementById("adminLoginForm"),
  email: document.getElementById("adminEmail"),
  password: document.getElementById("adminPassword"),
  loginStatus: document.getElementById("adminLoginStatus"),
  dashboard: document.getElementById("adminDashboard"),
  scopeTitle: document.getElementById("adminScopeTitle"),
  freshness: document.getElementById("adminFreshness"),
  refresh: document.getElementById("refreshAdmin"),
  signOut: document.getElementById("adminSignOut"),
  userFilter: document.getElementById("adminUserFilter"),
  categoryFilter: document.getElementById("adminCategoryFilter"),
  lengthFilter: document.getElementById("adminLengthFilter"),
  rangeFilter: document.getElementById("adminRangeFilter"),
  metricFilter: document.getElementById("adminMetricFilter"),
  audience: document.getElementById("audienceSummary"),
  stats: document.getElementById("adminStatsGrid"),
  statsNote: document.getElementById("adminStatsNote"),
  trend: document.getElementById("adminScoreTrend"),
  history: document.getElementById("adminHistory"),
  userHeat: document.getElementById("userRegionHeat"),
  deviceHeat: document.getElementById("deviceRegionHeat"),
  insights: document.getElementById("insightGrid"),
  categories: document.getElementById("categoryPerformance"),
  deviceMix: document.getElementById("deviceMix"),
  userComparison: document.getElementById("userComparison"),
  questions: document.getElementById("questionInsights"),
  users: document.getElementById("adminUsersTable")
};

const configured = Boolean(/^https:\/\//i.test(String(CONFIG.supabaseUrl || "")) && String(CONFIG.supabasePublishableKey || "").trim());
let supabase = null;
let profiles = [];
const ADMIN_UI_STATE_KEY = "sfmc-admin-ui-v2";
function readAdminUiState() {
  try { return JSON.parse(sessionStorage.getItem(ADMIN_UI_STATE_KEY) || "{}"); } catch (error) { return {}; }
}
const savedUiState = readAdminUiState();
const initialScrollY = Math.max(0, Math.floor(Number(savedUiState.scrollY) || 0));
let restoredInitialScroll = false;
const view = {
  profileId: String(savedUiState.profileId || "all"),
  category: ["all", "test", "quiz", "study"].includes(savedUiState.category) ? savedUiState.category : "all",
  length: ["all", "10", "20", "50"].includes(String(savedUiState.length)) ? String(savedUiState.length) : "all",
  rangeDays: [0, 1, 7, 30, 90, 180, 365].includes(Number(savedUiState.rangeDays)) ? Number(savedUiState.rangeDays) : 7,
  metric: ["averageScore", "currentPlayers", "averageImprovement", "scoreHistory"].includes(savedUiState.metric) ? savedUiState.metric : "averageScore"
};
const listStates = savedUiState.lists && typeof savedUiState.lists === "object" ? savedUiState.lists : {};

function saveAdminUiState() {
  try { sessionStorage.setItem(ADMIN_UI_STATE_KEY, JSON.stringify({ ...view, lists: listStates, scrollY: Math.max(0, Math.round(window.scrollY || 0)) })); } catch (error) {}
}

function listState(kind) {
  const saved = listStates[kind] || {};
  const state = { limit: Number(saved.limit) === 20 ? 20 : 5, page: Math.max(0, Math.floor(Number(saved.page) || 0)) };
  listStates[kind] = state;
  return state;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { timeZone: ADMIN_TIME_ZONE }) : "—";
}

function shortPreview(value, limit = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function listWindow(kind, rows) {
  const state = listState(kind), pageSize = state.limit;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  state.page = Math.min(state.page, pageCount - 1);
  const start = state.page * pageSize;
  return { rows: rows.slice(start, start + pageSize), start, pageCount, state };
}

function listControls(kind, total) {
  if (total <= 5) return "";
  const state = listState(kind), pageSize = state.limit, pageCount = Math.max(1, Math.ceil(total / pageSize));
  state.page = Math.min(state.page, pageCount - 1);
  const start = state.page * pageSize, end = Math.min(total, start + pageSize);
  return `<div class="admin-list-controls"><span>Showing ${start + 1}–${end} of ${total}</span><div><button type="button" class="secondary" data-list-action="limit" data-list-kind="${kind}">${pageSize === 5 ? "Show 20" : "Show 5"}</button>${pageSize === 20 && total > 20 ? `<button type="button" class="secondary" data-list-action="previous" data-list-kind="${kind}" ${state.page === 0 ? "disabled" : ""}>Previous</button><button type="button" class="secondary" data-list-action="next" data-list-kind="${kind}" ${state.page >= pageCount - 1 ? "disabled" : ""}>Next</button>` : ""}</div></div>`;
}

function bindListControls(target, kind, render) {
  target.querySelectorAll(`[data-list-kind="${kind}"]`).forEach(button => button.addEventListener("click", () => {
    const y = window.scrollY, state = listState(kind), action = button.dataset.listAction;
    if (action === "limit") { state.limit = state.limit === 20 ? 5 : 20; state.page = 0; }
    if (action === "previous") state.page = Math.max(0, state.page - 1);
    if (action === "next") state.page += 1;
    saveAdminUiState();
    render();
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "auto" }));
  }));
}

function categoryOf(session) {
  if (session.category) return session.category;
  const match = String(session.sampleType || session.mode || "").toLowerCase().match(/^(test|quiz|study)/);
  return match ? match[1] : "quiz";
}

function lengthOf(session) {
  return Number(session.questionCount || session.totalQuestions) || 0;
}

function filteredSessions(stats) {
  return (stats?.sessions || []).filter(session =>
    (view.category === "all" || categoryOf(session) === view.category) &&
    (view.length === "all" || lengthOf(session) === Number(view.length))
  ).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function selectedProfiles() {
  return view.profileId === "all" ? profiles : profiles.filter(profile => profile.profileId === view.profileId);
}

function localDayNumber(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function activePracticeStreak(stats) {
  const streak = stats?.practiceStreak || {};
  const today = localDayNumber();
  const lastDay = Number(streak.lastDay);
  const gap = today - lastDay;
  return Number.isFinite(lastDay) && gap >= 0 && gap <= 1 ? Math.max(0, Math.floor(Number(streak.current) || 0)) : 0;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function kpi(value, label, detail = "") {
  return `<div class="admin-kpi"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
}

function renderComparisonBars(target, items, options = {}) {
  const rows = items.filter(item => Number.isFinite(Number(item.value)));
  if (!rows.length) {
    target.innerHTML = `<div class="region-empty">${escapeHtml(options.empty || "No comparison data is available for this view.")}</div>`;
    return;
  }
  const page = options.listKey ? listWindow(options.listKey, rows) : { rows };
  const max = Math.max(1, Number(options.maxValue) || Math.max(...rows.map(item => Number(item.value))));
  const endLabel = options.axisLabel || String(Math.round(max));
  target.innerHTML = `<div class="comparison-chart"><div class="comparison-axis" aria-hidden="true"><span>0</span><span>${escapeHtml(endLabel)}</span></div><div class="performance-list">${page.rows.map(item => `<div class="performance-row"><strong title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</strong><div class="performance-bar" role="img" aria-label="${escapeHtml(`${item.label}: ${item.detail}`)}"><span style="width:${Math.max(0,Math.min(100,Number(item.value)/max*100))}%"></span></div><span>${escapeHtml(item.detail)}</span></div>`).join("")}</div>${options.legend ? `<div class="chart-legend"><span><i class="legend-bar"></i>${escapeHtml(options.legend)}</span></div>` : ""}${options.listKey ? listControls(options.listKey, rows.length) : ""}</div>`;
  if (options.listKey) bindListControls(target, options.listKey, options.render);
}

function smoothGraphPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  if (points.length === 2) {
    const mid = (points[0].x + points[1].x) / 2;
    return `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} C${mid.toFixed(1)} ${points[0].y.toFixed(1)}, ${mid.toFixed(1)} ${points[1].y.toFixed(1)}, ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }
  const h = [], slopes = [], tangents = new Array(points.length).fill(0);
  for (let index = 0; index < points.length - 1; index++) {
    h[index] = Math.max(.001, points[index + 1].x - points[index].x);
    slopes[index] = (points[index + 1].y - points[index].y) / h[index];
  }
  tangents[0] = slopes[0];
  tangents[points.length - 1] = slopes[slopes.length - 1];
  for (let index = 1; index < points.length - 1; index++) {
    if (slopes[index - 1] === 0 || slopes[index] === 0 || Math.sign(slopes[index - 1]) !== Math.sign(slopes[index])) tangents[index] = 0;
    else {
      const firstWeight = 2 * h[index] + h[index - 1], secondWeight = h[index] + 2 * h[index - 1];
      tangents[index] = (firstWeight + secondWeight) / ((firstWeight / slopes[index - 1]) + (secondWeight / slopes[index]));
    }
  }
  let path = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const segment = h[index];
    path += ` C${(points[index].x + segment / 3).toFixed(1)} ${(points[index].y + tangents[index] * segment / 3).toFixed(1)}, ${(points[index + 1].x - segment / 3).toFixed(1)} ${(points[index + 1].y - tangents[index + 1] * segment / 3).toFixed(1)}, ${points[index + 1].x.toFixed(1)} ${points[index + 1].y.toFixed(1)}`;
  }
  return path;
}

function sessionIdentity(session) {
  const profile = session.__profileId || "profile";
  return `${profile}|${session.id || [session.date, session.sampleType || session.mode, session.correct, session.totalQuestions, session.durationSeconds].join("|")}`;
}

function completedScoreHistory(sessions, days) {
  const seen = new Set();
  const now = Date.now(), cutoff = Number(days) > 0 ? now - Number(days) * 86400000 : -Infinity;
  return sessions.filter(session => {
    const key = sessionIdentity(session);
    if (seen.has(key)) return false;
    seen.add(key);
    const answered = Number(session.answered), total = Number(session.totalQuestions || session.questionCount);
    const time = new Date(session.date).getTime();
    return answered > 0 && answered === total && Number.isFinite(time) && time >= cutoff && time <= now;
  }).map(session => {
    const answered = Number(session.answered), saved = Number(session.scorePercent);
    return { session, time: new Date(session.date).getTime(), pct: Math.max(0, Math.min(100, Number.isFinite(saved) ? saved : (Number(session.correct) || 0) / answered * 100)) };
  }).sort((a, b) => a.time - b.time);
}

const GRAPH_METRICS = {
  averageScore: { label: "Average User Score", description: "Average score per user in each shared UTC time bucket", chart: "line", unit: "%" },
  currentPlayers: { label: "Current Players", description: "Distinct active users in each shared UTC time bucket", chart: "bar", unit: "" },
  averageImprovement: { label: "Average Score Improvement", description: "Average score change from each user's previous completed attempt", chart: "line", unit: " pts" },
  scoreHistory: { label: "Score History", description: "Every completed score in chronological order", chart: "line", unit: "%" }
};

function graphBucketConfig(days, rows = []) {
  const spanDays = Number(days) > 0 ? Number(days) : Math.max(1, rows.length > 1 ? (rows[rows.length - 1].time - rows[0].time) / 86400000 : 1);
  if (spanDays <= 2) return { kind: "hour", hours: 3, label: "3-hour UTC buckets" };
  if (spanDays <= 31) return { kind: "day", label: "Daily UTC buckets" };
  if (spanDays <= 180) return { kind: "week", label: "Weekly UTC buckets" };
  if (spanDays <= 730) return { kind: "month", label: "Monthly UTC buckets" };
  return { kind: "quarter", label: "Quarterly UTC buckets" };
}

function utcBucketStart(time, config) {
  const date = new Date(time), dayMs = 86400000;
  if (config.kind === "hour") return Math.floor(time / (config.hours * 3600000)) * config.hours * 3600000;
  if (config.kind === "day") return Math.floor(time / dayMs) * dayMs;
  if (config.kind === "week") {
    const day = Math.floor(time / dayMs), mondayOffset = (day + 3) % 7;
    return (day - mondayOffset) * dayMs;
  }
  if (config.kind === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1);
}

function nextUtcBucket(time, config) {
  if (config.kind === "hour") return time + config.hours * 3600000;
  if (config.kind === "day") return time + 86400000;
  if (config.kind === "week") return time + 7 * 86400000;
  const date = new Date(time), months = config.kind === "quarter" ? 3 : 1;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
}

function buildGraphMetric(sessions) {
  const completed = completedScoreHistory(sessions, view.rangeDays), metric = GRAPH_METRICS[view.metric] || GRAPH_METRICS.averageScore;
  if (!completed.length) return { metric, rows: [], config: graphBucketConfig(view.rangeDays), history: view.metric === "scoreHistory" };
  if (view.metric === "scoreHistory") return { metric, rows: completed.map(row => ({ ...row, value: row.pct, detail: `${Math.round(row.pct)}%` })), config: graphBucketConfig(view.rangeDays, completed), history: true };
  const config = graphBucketConfig(view.rangeDays, completed), buckets = new Map();
  const bucketFor = time => {
    const key = utcBucketStart(time, config);
    if (!buckets.has(key)) buckets.set(key, { time: key, profiles: new Map(), players: new Set(), improvements: [] });
    return buckets.get(key);
  };
  completed.forEach(row => {
    const profileId = row.session.__profileId || "profile", bucket = bucketFor(row.time);
    bucket.players.add(profileId);
    const scores = bucket.profiles.get(profileId) || [];
    scores.push(row.pct);
    bucket.profiles.set(profileId, scores);
  });
  if (view.metric === "averageImprovement") {
    const byProfile = new Map();
    completed.forEach(row => {
      const profileId = row.session.__profileId || "profile", previous = byProfile.get(profileId);
      if (previous) bucketFor(row.time).improvements.push(row.pct - previous.pct);
      byProfile.set(profileId, row);
    });
  }
  let rows = [...buckets.values()].sort((a, b) => a.time - b.time).map(bucket => {
    if (view.metric === "currentPlayers") return { time: bucket.time, value: bucket.players.size, detail: `${bucket.players.size} active user${bucket.players.size === 1 ? "" : "s"}` };
    if (view.metric === "averageImprovement") return { time: bucket.time, value: average(bucket.improvements), detail: `${bucket.improvements.length} score change${bucket.improvements.length === 1 ? "" : "s"}` };
    const userAverages = [...bucket.profiles.values()].map(scores => average(scores));
    return { time: bucket.time, value: average(userAverages), detail: `${userAverages.length} user${userAverages.length === 1 ? "" : "s"}` };
  }).filter(row => row.value != null);
  if (view.metric === "currentPlayers" && Number(view.rangeDays) > 0) {
    const now = Date.now(), first = utcBucketStart(now - Number(view.rangeDays) * 86400000, config), last = utcBucketStart(now, config), indexed = new Map(rows.map(row => [row.time, row]));
    rows = [];
    for (let time = first, guard = 0; time <= last && guard < 1000; time = nextUtcBucket(time, config), guard++) rows.push(indexed.get(time) || { time, value: 0, detail: "0 active users" });
  }
  return { metric, rows, config, history: false };
}

function graphAxis(rows, metricKey) {
  const values = rows.map(row => Number(row.value)).filter(Number.isFinite);
  if (metricKey === "averageScore" || metricKey === "scoreHistory") return { min: 0, max: 100, ticks: [0,25,50,75,100], suffix: "%" };
  if (metricKey === "currentPlayers") {
    const max = Math.max(1, ...values), step = Math.max(1, Math.ceil(max / 4)), ceiling = Math.max(step, Math.ceil(max / step) * step);
    return { min: 0, max: ceiling, ticks: [...new Set([0, step, step * 2, step * 3, ceiling].filter(value => value <= ceiling))], suffix: "" };
  }
  const extent = Math.max(5, ...values.map(value => Math.abs(value))), step = Math.max(1, Math.ceil(extent / 2 / 5) * 5), bound = Math.ceil(extent / step) * step;
  return { min: -bound, max: bound, ticks: [-bound, -bound / 2, 0, bound / 2, bound], suffix: "" };
}

function scoreHistoryTicks(rows, days, left, plotWidth) {
  const count = Math.min(6, rows.length);
  if (!count) return [];
  const indexes = [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * (rows.length - 1) / Math.max(1, count - 1))))];
  const effectiveDays = Number(days) > 0 ? Number(days) : Math.max(1, (rows[rows.length - 1].time - rows[0].time) / 86400000);
  return indexes.map((rowIndex, index) => {
    const date = new Date(rows[rowIndex].time);
    const label = effectiveDays <= 1 ? date.toLocaleTimeString(undefined, { hour: "numeric", timeZone: ADMIN_TIME_ZONE }) : effectiveDays <= 14 ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: ADMIN_TIME_ZONE }) : effectiveDays <= 365 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: ADMIN_TIME_ZONE }) : date.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: ADMIN_TIME_ZONE });
    const ratio = rows.length === 1 ? .5 : rowIndex / (rows.length - 1);
    return { x: left + plotWidth * ratio, rowIndex, label, anchor: rows.length === 1 ? "middle" : index === 0 ? "start" : index === indexes.length - 1 ? "end" : "middle" };
  });
}

function latestDeviceLocation(profile) {
  return (profile.devices || []).filter(device => Number(device.quizCount) > 0 && (device.regionCode || device.regionName)).sort((a, b) =>
    new Date(b.locationUpdatedAt || b.lastSeenAt) - new Date(a.locationUpdatedAt || a.lastSeenAt)
  )[0] || null;
}

function locationKey(device) {
  if (!device) return null;
  const country = String(device.countryCode || "").toUpperCase();
  const region = String(device.regionCode || device.regionName || "").toUpperCase();
  return region ? `${country || "--"}|${region}` : null;
}

function locationLabel(device) {
  if (!device) return "Unknown";
  const country = String(device.countryCode || "").toUpperCase();
  const region = device.regionName || device.regionCode || "Unknown";
  return country && country !== "US" ? `${region}, ${country}` : String(region);
}

function renderHeat(target, items, listKey) {
  const counts = new Map();
  items.forEach(item => {
    const device = item.device || item;
    const key = locationKey(device);
    if (!key) return;
    const existing = counts.get(key) || { count: 0, label: locationLabel(device) };
    existing.count += 1;
    counts.set(key, existing);
  });
  const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  renderComparisonBars(target, rows.map(row => ({ label: row.label, value: row.count, detail: String(row.count) })), { legend: "Count by approximate region", empty: "No opted-in region data is available for this view yet.", listKey, render: () => renderHeat(target, items, listKey) });
}

function renderAudience(scope) {
  const quizUsers = scope.filter(profile => (profile.stats?.sessions || []).length > 0);
  const quizDevices = scope.flatMap(profile => (profile.devices || []).filter(device => Number(device.quizCount) > 0));
  const allSessions = scope.flatMap(profile => profile.stats?.sessions || []);
  const questionsAnswered = allSessions.reduce((sum, session) => sum + (Number(session.answered) || 0), 0);
  ui.audience.innerHTML = [
    kpi(quizUsers.length, "Users", "paired users count once"),
    kpi(quizDevices.length, "Devices", "each installation counts once"),
    kpi(allSessions.length, "Quiz Attempts"),
    kpi(questionsAnswered.toLocaleString(), "Questions Answered")
  ].join("");
}

function renderStats(scope) {
  const sessionsByProfile = scope.map(profile => ({ profile, sessions: filteredSessions(profile.stats).map(session => ({ ...session, __profileId: profile.profileId, __profileLabel: profile.label })) }));
  const sessions = sessionsByProfile.flatMap(item => item.sessions);
  const studySeconds = view.category === "all" && view.length === "all"
    ? scope.reduce((sum, profile) => sum + (Number(profile.stats?.totalStudySeconds) || 0), 0)
    : sessions.reduce((sum, session) => sum + (Number(session.durationSeconds) || 0), 0);
  const latestScores = sessionsByProfile.map(item => item.sessions[item.sessions.length - 1]?.scorePercent).filter(value => value !== undefined);
  const averageScore = average(sessions.map(session => session.scorePercent));
  const practiceValues = scope.map(profile => activePracticeStreak(profile.stats));
  const currentValues = scope.map(profile => Number(profile.stats?.answerStreak?.current) || 0);
  const bestValues = scope.map(profile => Number(profile.stats?.answerStreak?.best) || 0);
  const single = scope.length === 1;
  const lastScore = single ? latestScores[0] : average(latestScores);
  const practice = single ? practiceValues[0] : average(practiceValues);
  const current = single ? currentValues[0] : average(currentValues);
  const best = single ? bestValues[0] : Math.max(0, ...bestValues);
  ui.stats.innerHTML = [
    `<div class="stats-cell"><b>${formatDuration(studySeconds)}</b><span>Study Time</span></div>`,
    `<div class="stats-cell"><b>${lastScore == null ? "—" : `${Math.round(lastScore)}%`}</b><span>Last Score</span></div>`,
    `<div class="stats-cell"><b>${averageScore == null ? "—" : `${Math.round(averageScore)}%`}</b><span>Average Score</span></div>`,
    `<div class="stats-cell"><b>${practice == null ? "0" : Math.round(practice)}</b><span>Practice Day Streak</span></div>`,
    `<div class="stats-cell"><b>${current == null ? "0" : Math.round(current)}</b><span>Current Streak</span></div>`,
    `<div class="stats-cell"><b>${Math.round(best)}</b><span>Best Streak</span></div>`
  ].join("");
  ui.statsNote.textContent = single
    ? "This view matches the anonymous user's in-app statistics. Filters apply to study time and score history; streaks span all modes."
    : "Aggregated view: Last Score, Practice Day Streak, and Current Streak are averages across users; Best Streak is the highest. Other totals combine all selected users.";
  renderTrend(sessions);
  renderHistory(sessions);
}

function renderTrend(sessions) {
  const dataset = buildGraphMetric(sessions), { rows, metric, config } = dataset;
  if (!rows.length) {
    ui.trend.innerHTML = `<div class="graph-card admin-graph-card"><div class="admin-graph-heading"><strong>${escapeHtml(metric.label)}</strong><span>${escapeHtml(metric.description)}</span></div><div class="region-empty">No completed scores are available for this metric and timeframe.</div></div>`;
    return;
  }
  const width = 720, height = 260, left = 42, right = 16, top = 16, bottom = 46;
  const plotWidth = width - left - right, plotHeight = height - top - bottom, axis = graphAxis(rows, view.metric), range = Math.max(.001, axis.max - axis.min);
  const coords = rows.map((row, index) => ({ ...row, x: metric.chart === "bar" ? left + (index + .5) * plotWidth / rows.length : rows.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (rows.length - 1), y: top + (axis.max - row.value) / range * plotHeight }));
  const path = metric.chart === "line" ? smoothGraphPath(coords) : "";
  const marks = metric.chart === "bar" ? coords.map((point, index) => { const slot = plotWidth / Math.max(1, coords.length), barWidth = Math.max(2, Math.min(34, slot * .72)), baseline = top + (axis.max / range) * plotHeight, y = Math.min(point.y, baseline), barHeight = Math.max(1, Math.abs(baseline - point.y)); return `<rect class="graph-bar" x="${(point.x-barWidth/2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"><title>${escapeHtml(`${point.detail} · ${formatDate(point.time)}`)}</title></rect>`; }).join("") : coords.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" class="graph-point"><title>${escapeHtml(`${Number(point.value).toFixed(view.metric === "currentPlayers" ? 0 : 1)}${metric.unit} · ${point.session?.__profileLabel || point.detail} · ${formatDate(point.session?.date || point.time)}`)}</title></circle>`).join("");
  const grid = axis.ticks.map(value => { const y=top+(axis.max-value)/range*plotHeight; return `<line class="graph-grid" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"></line><text class="graph-axis" x="6" y="${y+4}">${Number.isInteger(value)?value:value.toFixed(1)}${axis.suffix}</text>`; }).join("");
  const xTicks = scoreHistoryTicks(rows, view.rangeDays, left, plotWidth).map(tick => `<text class="graph-axis graph-x-axis" text-anchor="${tick.anchor}" x="${(metric.chart === "bar" ? coords[tick.rowIndex].x : tick.x).toFixed(1)}" y="${height-12}">${escapeHtml(tick.label)}</text>`).join("");
  const bands = view.metric === "averageScore" || view.metric === "scoreHistory" ? `<rect class="graph-band-high" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight*.25}"></rect><rect class="graph-band-mid" x="${left}" y="${top+plotHeight*.25}" width="${plotWidth}" height="${plotHeight*.25}"></rect><rect class="graph-band-low" x="${left}" y="${top+plotHeight*.5}" width="${plotWidth}" height="${plotHeight*.5}"></rect>` : "";
  const bucketNote = dataset.history ? `${rows.length} completed score${rows.length === 1 ? "" : "s"}` : config.label;
  ui.trend.innerHTML = `<div class="graph-card admin-graph-card"><div class="admin-graph-heading"><strong>${escapeHtml(metric.label)}</strong><span>${escapeHtml(metric.description)}</span></div><div class="chart-legend" aria-label="Chart legend"><span><i class="${metric.chart === "bar" ? "legend-bar" : "legend-line"}"></i>${escapeHtml(metric.label)}</span><span><i class="legend-point"></i>${escapeHtml(bucketNote)}</span><span class="time-zone-label">Displayed in ${escapeHtml(ADMIN_TIME_ZONE)}</span></div><svg class="admin-score-graph score-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(metric.label)} displayed in ${escapeHtml(ADMIN_TIME_ZONE)}"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="#fffdf6"></rect>${bands}${grid}<line class="graph-grid" x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}"></line><line class="graph-grid" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"></line>${path ? `<path class="graph-line" d="${path}"></path>` : ""}${marks}${xTicks}</svg></div>`;
}

function renderHistory(sessions) {
  const recent = sessions.slice().reverse(), page = listWindow("history", recent);
  ui.history.innerHTML = recent.length ? `<h3>Recent Score History</h3>${listControls("history", recent.length)}<ol class="admin-history-list" start="${page.start + 1}">${page.rows.map(session => `<li>${escapeHtml(formatDate(session.date))} — ${escapeHtml(categoryOf(session))} ${lengthOf(session)}: <strong>${escapeHtml(session.scorePercent)}%</strong>, ${escapeHtml(formatDuration(session.durationSeconds))}</li>`).join("")}</ol>` : "";
  bindListControls(ui.history, "history", () => renderHistory(sessions));
}

function renderInsights(scope) {
  const now = Date.now();
  const latestTimes = scope.map(profile => Math.max(0, ...(profile.stats?.sessions || []).map(session => new Date(session.date).getTime()).filter(Number.isFinite)));
  const active7 = latestTimes.filter(time => time >= now - 7 * 86400000).length;
  const active30 = latestTimes.filter(time => time >= now - 30 * 86400000).length;
  const sessions = scope.flatMap(profile => filteredSessions(profile.stats));
  const completed = sessions.filter(session => Number(session.answered) > 0 && Number(session.answered) === Number(session.totalQuestions)).length;
  const repeatUsers = scope.filter(profile => filteredSessions(profile.stats).length >= 2).length;
  const improvements = scope.map(profile => {
    const playerSessions = filteredSessions(profile.stats);
    if (playerSessions.length < 2) return null;
    const first = average(playerSessions.slice(0, 3).map(session => session.scorePercent));
    const last = average(playerSessions.slice(-3).map(session => session.scorePercent));
    return first == null || last == null ? null : last - first;
  }).filter(value => value != null);
  ui.insights.innerHTML = [
    kpi(active7, "Active Users · 7 Days"),
    kpi(active30, "Active Users · 30 Days"),
    kpi(sessions.length ? `${Math.round(completed / sessions.length * 100)}%` : "—", "Completion Rate"),
    kpi(scope.length ? `${Math.round(repeatUsers / scope.length * 100)}%` : "—", "Repeat User Rate"),
    kpi(improvements.length ? `${average(improvements) >= 0 ? "+" : ""}${Math.round(average(improvements))} pts` : "—", "Average Improvement")
  ].join("");
  renderPerformanceLists(scope);
}

function renderPerformanceLists(scope) {
  const categories = ["test", "quiz", "study"].map(category => {
    const sessions = scope.flatMap(profile => (profile.stats?.sessions || []).filter(session => categoryOf(session) === category));
    return { label: category[0].toUpperCase() + category.slice(1), count: sessions.length, score: average(sessions.map(session => session.scorePercent)) };
  });
  renderComparisonBars(ui.categories, categories.filter(item => item.score != null).map(item => ({ label: item.label, value: item.score, detail: `${Math.round(item.score)}% · ${item.count} attempt${item.count === 1 ? "" : "s"}` })), { maxValue: 100, axisLabel: "100%", legend: "Average score and attempt count", empty: "No category performance is available for this view." });
  const devices = scope.flatMap(profile => (profile.devices || []).filter(device => Number(device.quizCount) > 0));
  const types = ["mobile", "tablet", "desktop", "unknown"].map(type => ({ type, count: devices.filter(device => String(device.deviceClass || "unknown") === type).length })).filter(item => item.count);
  renderComparisonBars(ui.deviceMix, types.map(item => ({ label: item.type, value: item.count, detail: String(item.count) })), { legend: "Devices", empty: "No devices are available in this view." });
  const users = scope.map(profile => { const sessions = filteredSessions(profile.stats); return { label: profile.label, score: average(sessions.map(session => session.scorePercent)), count: sessions.length }; }).filter(item => item.score != null).sort((a, b) => b.score - a.score || b.count - a.count);
  renderComparisonBars(ui.userComparison, users.map(item => ({ label: item.label, value: item.score, detail: `${Math.round(item.score)}% · ${item.count} attempt${item.count === 1 ? "" : "s"}` })), { maxValue: 100, axisLabel: "100%", legend: "Average score by anonymous user", empty: "No user comparison is available for this view.", listKey: "userComparison", render: () => renderPerformanceLists(scope) });
}

function mergeQuestionBuckets(scope) {
  const merged = {};
  scope.forEach(profile => Object.entries(profile.stats?.questions || {}).forEach(([id, item]) => {
    if (!merged[id]) merged[id] = { question: item.question, test: item.test, number: item.number, timesSeen: 0, timesCorrect: 0, timesWrong: 0 };
    merged[id].timesSeen += Number(item.timesSeen) || 0;
    merged[id].timesCorrect += Number(item.timesCorrect) || 0;
    merged[id].timesWrong += Number(item.timesWrong) || 0;
  }));
  return merged;
}

function renderQuestionInsights(scope) {
  const rows = Object.values(mergeQuestionBuckets(scope)).filter(item => item.timesSeen > 0).map(item => ({ ...item, accuracy: item.timesCorrect / item.timesSeen * 100 })).sort((a, b) => a.accuracy - b.accuracy || b.timesSeen - a.timesSeen);
  const page = listWindow("questions", rows);
  ui.questions.innerHTML = rows.length ? `${listControls("questions", rows.length)}<div class="admin-table-scroll ${page.state.limit === 20 ? "expanded" : ""}"><table class="admin-table"><thead><tr><th>Question</th><th>Seen</th><th>Wrong</th><th>Accuracy</th></tr></thead><tbody>${page.rows.map(item => `<tr><td><strong>${escapeHtml(item.test || "Question")} ${escapeHtml(item.number || "")}</strong><br><span class="question-preview" title="${escapeHtml(item.question || "")}">${escapeHtml(shortPreview(item.question))}</span></td><td>${item.timesSeen}</td><td>${item.timesWrong}</td><td>${Math.round(item.accuracy)}%</td></tr>`).join("")}</tbody></table></div>` : `<div class="region-empty">No question-performance data is available for this view.</div>`;
  bindListControls(ui.questions, "questions", () => renderQuestionInsights(scope));
}

function renderUsersTable() {
  const rows = profiles.map(profile => {
    const sessions = profile.stats?.sessions || [];
    const devices = (profile.devices || []).filter(device => Number(device.quizCount) > 0);
    const latest = sessions.slice().sort((a,b)=>new Date(a.date)-new Date(b.date)).slice(-1)[0];
    const location = latestDeviceLocation(profile);
    return `<tr><td><strong>${escapeHtml(profile.label)}</strong></td><td>${sessions.length}</td><td>${devices.length}</td><td>${sessions.length ? `${Math.round(average(sessions.map(session=>session.scorePercent)))}%` : "—"}</td><td>${escapeHtml(locationLabel(location))}</td><td>${escapeHtml(latest ? formatDate(latest.date) : "—")}</td><td><button type="button" data-view-profile="${escapeHtml(profile.profileId)}">View</button></td></tr>`;
  });
  const page = listWindow("users", rows);
  ui.users.innerHTML = rows.length ? `${listControls("users", rows.length)}<div class="admin-table-scroll ${page.state.limit === 20 ? "expanded" : ""}"><table class="admin-table"><thead><tr><th>Anonymous User</th><th>Attempts</th><th>Devices</th><th>Avg Score</th><th>Latest Region</th><th>Last Quiz</th><th></th></tr></thead><tbody>${page.rows.join("")}</tbody></table></div>` : `<div class="region-empty">No users have opted in yet.</div>`;
  ui.users.querySelectorAll("[data-view-profile]").forEach(button => button.addEventListener("click", () => {
    view.profileId = button.dataset.viewProfile;
    ui.userFilter.value = view.profileId;
    saveAdminUiState();
    renderDashboard();
    scrollTo({ top: 0, behavior: "smooth" });
  }));
  bindListControls(ui.users, "users", renderUsersTable);
}

function renderFilters() {
  ui.userFilter.innerHTML = `<option value="all">All opted-in users</option>${profiles.map(profile => `<option value="${escapeHtml(profile.profileId)}">${escapeHtml(profile.label)}</option>`).join("")}`;
  ui.userFilter.value = profiles.some(profile => profile.profileId === view.profileId) ? view.profileId : "all";
  view.profileId = ui.userFilter.value;
  const categoryOptions = [["all","All"],["test","Test"],["quiz","Quiz"],["study","Study"]];
  const lengthOptions = [["all","All"],["10","10"],["20","20"],["50","50"]];
  const rangeOptions = [[1,"1 Day"],[7,"1 Week"],[30,"1 Month"],[90,"3 Months"],[180,"6 Months"],[365,"1 Year"],[0,"All Time"]];
  const metricOptions = Object.entries(GRAPH_METRICS);
  ui.categoryFilter.innerHTML = categoryOptions.map(([key,label]) => `<option value="${key}">${label}</option>`).join("");
  ui.lengthFilter.innerHTML = lengthOptions.map(([key,label]) => `<option value="${key}">${label}</option>`).join("");
  ui.rangeFilter.innerHTML = rangeOptions.map(([key,label]) => `<option value="${key}">${label}</option>`).join("");
  ui.metricFilter.innerHTML = metricOptions.map(([key,item]) => `<option value="${key}">${escapeHtml(item.label)}</option>`).join("");
  ui.categoryFilter.value = view.category;
  ui.lengthFilter.value = view.length;
  ui.rangeFilter.value = String(view.rangeDays);
  ui.metricFilter.value = view.metric;
}

function renderDashboard() {
  renderFilters();
  const scope = selectedProfiles();
  ui.scopeTitle.textContent = view.profileId === "all" ? "All opted-in users" : scope[0]?.label || "Anonymous user";
  renderAudience(scope);
  renderStats(scope);
  const userLocations = scope.map(profile => ({ profile, device: latestDeviceLocation(profile) })).filter(item => item.device);
  const deviceLocations = scope.flatMap(profile => (profile.devices || []).filter(device => Number(device.quizCount) > 0));
  renderHeat(ui.userHeat, userLocations, "userRegions");
  renderHeat(ui.deviceHeat, deviceLocations, "deviceRegions");
  renderInsights(scope);
  renderQuestionInsights(scope);
  renderUsersTable();
  saveAdminUiState();
}

async function loadSnapshot() {
  ui.freshness.textContent = "Refreshing analytics…";
  const result = await supabase.rpc("admin_quiz_snapshot");
  if (result.error) throw result.error;
  profiles = Array.isArray(result.data) ? result.data : [];
  ui.login.classList.add("hidden");
  ui.dashboard.classList.remove("hidden");
  ui.freshness.textContent = `Updated ${new Date().toLocaleTimeString()} · ${profiles.length} opted-in user${profiles.length === 1 ? "" : "s"}`;
  renderDashboard();
  if (!restoredInitialScroll) {
    restoredInitialScroll = true;
    requestAnimationFrame(() => window.scrollTo({ top: initialScrollY, behavior: "auto" }));
  }
}

async function showSignedInDashboard() {
  try {
    await loadSnapshot();
  } catch (error) {
    console.error(error);
    ui.login.classList.remove("hidden");
    ui.dashboard.classList.add("hidden");
    ui.loginStatus.textContent = error.message?.toLowerCase().includes("admin") ? "This signed-in account is not authorized as the quiz administrator." : `Dashboard could not load: ${error.message}`;
  }
}

if (!configured) {
  ui.loginStatus.textContent = "The secure analytics service has not been connected yet.";
  ui.loginForm.querySelector("button").disabled = true;
} else {
  const { createClient } = await import(SUPABASE_MODULE);
  supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
    auth: { storageKey: ADMIN_AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  const session = await supabase.auth.getSession();
  if (session.data.session) await showSignedInDashboard();
}

ui.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase) return;
  ui.loginStatus.textContent = "Signing in securely…";
  const result = await supabase.auth.signInWithPassword({ email: ui.email.value.trim(), password: ui.password.value });
  ui.password.value = "";
  if (result.error) {
    ui.loginStatus.textContent = "Sign-in failed. Check the email and password and try again.";
    return;
  }
  await showSignedInDashboard();
});

ui.refresh.addEventListener("click", () => loadSnapshot().catch(error => { ui.freshness.textContent = `Refresh failed: ${error.message}`; }));
ui.signOut.addEventListener("click", async () => {
  await supabase.auth.signOut({ scope: "local" });
  profiles = [];
  ui.dashboard.classList.add("hidden");
  ui.login.classList.remove("hidden");
  ui.loginStatus.textContent = "Signed out.";
});
function updateView(key, value) {
  const y = window.scrollY;
  view[key] = value;
  saveAdminUiState();
  renderDashboard();
  requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "auto" }));
}

ui.userFilter.addEventListener("change", () => updateView("profileId", ui.userFilter.value));
ui.categoryFilter.addEventListener("change", () => updateView("category", ui.categoryFilter.value));
ui.lengthFilter.addEventListener("change", () => updateView("length", ui.lengthFilter.value));
ui.rangeFilter.addEventListener("change", () => updateView("rangeDays", Number(ui.rangeFilter.value)));
ui.metricFilter.addEventListener("change", () => updateView("metric", ui.metricFilter.value));
window.addEventListener("pagehide", saveAdminUiState);
