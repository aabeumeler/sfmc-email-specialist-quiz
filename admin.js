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
const view = { profileId: "all", category: "all", length: "all" };
const rowLimits = { questions: 5, users: 5 };

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

function tableControls(kind, total) {
  if (total <= 5) return "";
  const expanded = rowLimits[kind] === 20;
  return `<div class="admin-table-controls"><span>Showing ${Math.min(total, expanded ? 20 : 5)} of ${total}</span><button type="button" class="secondary" data-table-limit="${kind}">${expanded ? "Show 5" : "Show 20"}</button></div>`;
}

function bindTableLimit(target, kind, render) {
  target.querySelector(`[data-table-limit="${kind}"]`)?.addEventListener("click", () => {
    rowLimits[kind] = rowLimits[kind] === 20 ? 5 : 20;
    render();
  });
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
  const max = Math.max(1, Number(options.maxValue) || Math.max(...rows.map(item => Number(item.value))));
  const endLabel = options.axisLabel || String(Math.round(max));
  target.innerHTML = `<div class="comparison-chart"><div class="comparison-axis" aria-hidden="true"><span>0</span><span>${escapeHtml(endLabel)}</span></div><div class="performance-list">${rows.map(item => `<div class="performance-row"><strong title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</strong><div class="performance-bar" role="img" aria-label="${escapeHtml(`${item.label}: ${item.detail}`)}"><span style="width:${Math.max(0,Math.min(100,Number(item.value)/max*100))}%"></span></div><span>${escapeHtml(item.detail)}</span></div>`).join("")}</div>${options.legend ? `<div class="chart-legend"><span><i class="legend-bar"></i>${escapeHtml(options.legend)}</span></div>` : ""}</div>`;
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

function trendBucketConfig(spanMs) {
  const hour = 60 * 60 * 1000, day = 24 * hour, days = spanMs / day;
  if (days <= 2) return { unit: "hour", step: 3, label: "3-hour UTC averages" };
  if (days <= 14) return { unit: "day", step: 1, label: "Daily UTC averages" };
  if (days <= 90) return { unit: "week", step: 1, label: "Weekly UTC averages" };
  if (days <= 730) return { unit: "month", step: 1, label: "Monthly UTC averages" };
  return { unit: "quarter", step: 1, label: "Quarterly UTC averages" };
}

function utcBucketBounds(time, config) {
  const hour = 60 * 60 * 1000, day = 24 * hour, date = new Date(time);
  let start, end;
  if (config.unit === "hour") {
    const size = config.step * hour;
    start = Math.floor(time / size) * size;
    end = start + size;
  } else if (config.unit === "day") {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    end = start + config.step * day;
  } else if (config.unit === "week") {
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    start = dayStart - ((date.getUTCDay() + 6) % 7) * day;
    end = start + 7 * config.step * day;
  } else if (config.unit === "month") {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + config.step, 1);
  } else {
    const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    start = Date.UTC(date.getUTCFullYear(), quarterMonth, 1);
    end = Date.UTC(date.getUTCFullYear(), quarterMonth + 3 * config.step, 1);
  }
  return { start, end };
}

function sessionIdentity(session) {
  const profile = session.__profileId || "profile";
  return `${profile}|${session.id || [session.date, session.sampleType || session.mode, session.correct, session.totalQuestions, session.durationSeconds].join("|")}`;
}

function bucketTrendSessions(sessions) {
  const seen = new Set();
  const valid = sessions.filter(session => { const key = sessionIdentity(session); if (seen.has(key)) return false; seen.add(key); return true; }).map(session => ({ session, time: new Date(session.date).getTime(), score: Number(session.scorePercent) })).filter(item => Number.isFinite(item.time) && Number.isFinite(item.score)).sort((a, b) => a.time - b.time);
  if (!valid.length) return null;
  const day = 24 * 60 * 60 * 1000, rawStart = valid[0].time, rawEnd = valid[valid.length - 1].time;
  const start = rawStart === rawEnd ? rawStart - day / 2 : rawStart;
  const end = rawStart === rawEnd ? rawEnd + day / 2 : rawEnd;
  const config = trendBucketConfig(end - start), buckets = new Map();
  valid.forEach(item => {
    const bounds = utcBucketBounds(item.time, config), key = bounds.start;
    const bucket = buckets.get(key) || { sum: 0, count: 0, time: bounds.start + (bounds.end - bounds.start) / 2 };
    bucket.sum += Math.max(0, Math.min(100, item.score));
    bucket.count++;
    buckets.set(key, bucket);
  });
  return { start, end, config, rows: [...buckets.values()].sort((a, b) => a.time - b.time).map(bucket => ({ ...bucket, time: Math.max(start, Math.min(end, bucket.time)), pct: Math.round(bucket.sum / bucket.count) })) };
}

function trendTimeTicks(start, end, left, plotWidth) {
  const spanDays = (end - start) / 86400000, count = spanDays <= 14 ? 5 : 6;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1), date = new Date(start + (end - start) * ratio);
    const label = spanDays <= 2 ? date.toLocaleTimeString(undefined, { hour: "numeric", timeZone: ADMIN_TIME_ZONE }) : spanDays <= 14 ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: ADMIN_TIME_ZONE }) : spanDays <= 365 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: ADMIN_TIME_ZONE }) : date.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: ADMIN_TIME_ZONE });
    return { x: left + plotWidth * ratio, label, anchor: index === 0 ? "start" : index === count - 1 ? "end" : "middle" };
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

function renderHeat(target, items) {
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
  renderComparisonBars(target, rows.map(row => ({ label: row.label, value: row.count, detail: String(row.count) })), { legend: "Count by approximate region", empty: "No opted-in region data is available for this view yet." });
}

function renderAudience(scope) {
  const quizUsers = scope.filter(profile => (profile.stats?.sessions || []).length > 0);
  const quizDevices = scope.flatMap(profile => (profile.devices || []).filter(device => Number(device.quizCount) > 0));
  const allSessions = scope.flatMap(profile => profile.stats?.sessions || []);
  const questionsAnswered = allSessions.reduce((sum, session) => sum + (Number(session.answered) || 0), 0);
  ui.audience.innerHTML = [
    kpi(quizUsers.length, "Users With Quizzes", "paired users count once"),
    kpi(quizDevices.length, "Quiz-Playing Devices", "each installation counts once"),
    kpi(allSessions.length, "Quiz Attempts"),
    kpi(questionsAnswered.toLocaleString(), "Questions Answered")
  ].join("");
}

function renderStats(scope) {
  const sessionsByProfile = scope.map(profile => ({ profile, sessions: filteredSessions(profile.stats).map(session => ({ ...session, __profileId: profile.profileId })) }));
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
    `<div class="stats-cell"><b>${sessions.length}</b><span>Past Scores</span></div>`,
    `<div class="stats-cell"><b>${lastScore == null ? "—" : `${Math.round(lastScore)}%`}</b><span>Last Score</span></div>`,
    `<div class="stats-cell"><b>50</b><span>Study Ready</span></div>`,
    `<div class="stats-cell"><b>${averageScore == null ? "—" : `${Math.round(averageScore)}%`}</b><span>Average Score</span></div>`,
    `<div class="stats-cell"><b>${practice == null ? "0" : Math.round(practice)}</b><span>Practice Streak</span></div>`,
    `<div class="stats-cell"><b>${current == null ? "0" : Math.round(current)}</b><span>Current Streak</span></div>`,
    `<div class="stats-cell"><b>${Math.round(best)}</b><span>Best Streak</span></div>`
  ].join("");
  ui.statsNote.textContent = single
    ? "This view matches the anonymous user's in-app statistics. Filters apply to study time and score history; streaks span all modes."
    : "Aggregated view: Last Score, Practice Streak, and Current Streak are averages across users; Best Streak is the highest. Other totals combine all selected users.";
  renderTrend(sessions);
  renderHistory(sessions);
}

function renderTrend(sessions) {
  const series = bucketTrendSessions(sessions);
  if (!series) {
    ui.trend.innerHTML = `<div class="graph-card admin-graph-card"><div class="region-empty">No score trend is available for this view.</div></div>`;
    return;
  }
  const width = 720, height = 260, left = 42, right = 16, top = 16, bottom = 46;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const coords = series.rows.map(bucket => ({ ...bucket, x: left + (bucket.time - series.start) / (series.end - series.start) * plotWidth, y: top + (1 - bucket.pct / 100) * plotHeight }));
  const path = smoothGraphPath(coords);
  const circles = coords.map(point => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" class="graph-point"><title>${escapeHtml(`${point.pct}% average · ${point.count} unique attempt${point.count === 1 ? "" : "s"}`)}</title></circle>`).join("");
  const yValues = coords.length > 8 ? [0,25,50,75,100] : [0,50,100];
  const grid = yValues.map(value => { const y=top+(1-value/100)*plotHeight; return `<line class="graph-grid" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"></line><text class="graph-axis" x="6" y="${y+4}">${value}%</text>`; }).join("");
  const xTicks = trendTimeTicks(series.start, series.end, left, plotWidth).map(tick => `<text class="graph-axis graph-x-axis" text-anchor="${tick.anchor}" x="${tick.x.toFixed(1)}" y="${height-12}">${escapeHtml(tick.label)}</text>`).join("");
  ui.trend.innerHTML = `<div class="graph-card admin-graph-card"><div class="chart-legend" aria-label="Chart legend"><span><i class="legend-line"></i>Average score</span><span><i class="legend-point"></i>${escapeHtml(series.config.label)}</span><span class="time-zone-label">Displayed in ${escapeHtml(ADMIN_TIME_ZONE)}</span></div><svg class="admin-score-graph score-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Filtered score trend displayed in ${escapeHtml(ADMIN_TIME_ZONE)}"><rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="#fffdf6"></rect><rect class="graph-band-high" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight*.25}"></rect><rect class="graph-band-mid" x="${left}" y="${top+plotHeight*.25}" width="${plotWidth}" height="${plotHeight*.25}"></rect><rect class="graph-band-low" x="${left}" y="${top+plotHeight*.5}" width="${plotWidth}" height="${plotHeight*.5}"></rect>${grid}<line class="graph-grid" x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}"></line><line class="graph-grid" x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}"></line><path class="graph-line" d="${path}"></path>${circles}${xTicks}</svg></div>`;
}

function renderHistory(sessions) {
  const recent = sessions.slice(-10).reverse();
  ui.history.innerHTML = recent.length ? `<h3>Recent score history</h3><ol class="admin-history-list">${recent.map(session => `<li>${escapeHtml(formatDate(session.date))} — ${escapeHtml(categoryOf(session))} ${lengthOf(session)}: <strong>${escapeHtml(session.scorePercent)}%</strong>, ${escapeHtml(formatDuration(session.durationSeconds))}</li>`).join("")}</ol>` : "";
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
  renderComparisonBars(ui.deviceMix, types.map(item => ({ label: item.type, value: item.count, detail: String(item.count) })), { legend: "Quiz-playing devices", empty: "No quiz-playing devices in this view." });
  const users = scope.map(profile => { const sessions = filteredSessions(profile.stats); return { label: profile.label, score: average(sessions.map(session => session.scorePercent)), count: sessions.length }; }).filter(item => item.score != null).sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 10);
  renderComparisonBars(ui.userComparison, users.map(item => ({ label: item.label, value: item.score, detail: `${Math.round(item.score)}% · ${item.count} attempt${item.count === 1 ? "" : "s"}` })), { maxValue: 100, axisLabel: "100%", legend: "Average score by anonymous user (top 10)", empty: "No user comparison is available for this view." });
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
  const rows = Object.values(mergeQuestionBuckets(scope)).filter(item => item.timesSeen > 0).map(item => ({ ...item, accuracy: item.timesCorrect / item.timesSeen * 100 })).sort((a, b) => a.accuracy - b.accuracy || b.timesSeen - a.timesSeen).slice(0, 20);
  const visibleRows = rows.slice(0, rowLimits.questions);
  ui.questions.innerHTML = rows.length ? `${tableControls("questions", rows.length)}<div class="admin-table-scroll ${rowLimits.questions === 20 ? "expanded" : ""}"><table class="admin-table"><thead><tr><th>Question</th><th>Seen</th><th>Wrong</th><th>Accuracy</th></tr></thead><tbody>${visibleRows.map(item => `<tr><td><strong>${escapeHtml(item.test || "Question")} ${escapeHtml(item.number || "")}</strong><br><span class="question-preview" title="${escapeHtml(item.question || "")}">${escapeHtml(shortPreview(item.question))}</span></td><td>${item.timesSeen}</td><td>${item.timesWrong}</td><td>${Math.round(item.accuracy)}%</td></tr>`).join("")}</tbody></table></div>` : `<div class="region-empty">No question-performance data is available for this view.</div>`;
  bindTableLimit(ui.questions, "questions", () => renderQuestionInsights(scope));
}

function renderUsersTable() {
  const rows = profiles.map(profile => {
    const sessions = profile.stats?.sessions || [];
    const devices = (profile.devices || []).filter(device => Number(device.quizCount) > 0);
    const latest = sessions.slice().sort((a,b)=>new Date(a.date)-new Date(b.date)).slice(-1)[0];
    const location = latestDeviceLocation(profile);
    return `<tr><td><strong>${escapeHtml(profile.label)}</strong></td><td>${sessions.length}</td><td>${devices.length}</td><td>${sessions.length ? `${Math.round(average(sessions.map(session=>session.scorePercent)))}%` : "—"}</td><td>${escapeHtml(locationLabel(location))}</td><td>${escapeHtml(latest ? formatDate(latest.date) : "—")}</td><td><button type="button" data-view-profile="${escapeHtml(profile.profileId)}">View</button></td></tr>`;
  });
  const visibleRows = rows.slice(0, rowLimits.users);
  ui.users.innerHTML = rows.length ? `${tableControls("users", rows.length)}<div class="admin-table-scroll ${rowLimits.users === 20 ? "expanded" : ""}"><table class="admin-table"><thead><tr><th>Anonymous User</th><th>Attempts</th><th>Devices</th><th>Avg Score</th><th>Latest Region</th><th>Last Quiz</th><th></th></tr></thead><tbody>${visibleRows.join("")}</tbody></table></div>` : `<div class="region-empty">No users have opted in yet.</div>`;
  ui.users.querySelectorAll("[data-view-profile]").forEach(button => button.addEventListener("click", () => {
    view.profileId = button.dataset.viewProfile;
    ui.userFilter.value = view.profileId;
    renderDashboard();
    scrollTo({ top: 0, behavior: "smooth" });
  }));
  bindTableLimit(ui.users, "users", renderUsersTable);
}

function renderFilters() {
  const current = ui.userFilter.value || view.profileId;
  ui.userFilter.innerHTML = `<option value="all">All opted-in users</option>${profiles.map(profile => `<option value="${escapeHtml(profile.profileId)}">${escapeHtml(profile.label)}</option>`).join("")}`;
  ui.userFilter.value = profiles.some(profile => profile.profileId === current) ? current : "all";
  view.profileId = ui.userFilter.value;
  const categoryOptions = [["all","All"],["test","Test"],["quiz","Quiz"],["study","Study"]];
  const lengthOptions = [["all","All"],["10","10"],["20","20"],["50","50"]];
  ui.categoryFilter.innerHTML = categoryOptions.map(([key,label]) => `<button type="button" data-category="${key}" class="${view.category===key?"active":""}">${label}</button>`).join("");
  ui.lengthFilter.innerHTML = lengthOptions.map(([key,label]) => `<button type="button" data-length="${key}" class="${view.length===key?"active":""}">${label}</button>`).join("");
  ui.categoryFilter.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => { view.category=button.dataset.category; renderDashboard(); }));
  ui.lengthFilter.querySelectorAll("[data-length]").forEach(button => button.addEventListener("click", () => { view.length=button.dataset.length; renderDashboard(); }));
}

function renderDashboard() {
  renderFilters();
  const scope = selectedProfiles();
  ui.scopeTitle.textContent = view.profileId === "all" ? "All opted-in users" : scope[0]?.label || "Anonymous user";
  renderAudience(scope);
  renderStats(scope);
  const userLocations = scope.map(profile => ({ profile, device: latestDeviceLocation(profile) })).filter(item => item.device);
  const deviceLocations = scope.flatMap(profile => (profile.devices || []).filter(device => Number(device.quizCount) > 0));
  renderHeat(ui.userHeat, userLocations);
  renderHeat(ui.deviceHeat, deviceLocations);
  renderInsights(scope);
  renderQuestionInsights(scope);
  renderUsersTable();
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
ui.userFilter.addEventListener("change", () => { view.profileId = ui.userFilter.value; renderDashboard(); });
