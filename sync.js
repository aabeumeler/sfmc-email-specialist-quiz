const CONFIG = window.SFMC_SYNC_CONFIG || {};
const CLOUD_STATE_KEY = "sfmcCloudSyncState_v1";
const PLAYER_AUTH_KEY = "sfmc-player-auth-v1";
const SUPABASE_MODULE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.2/+esm";

const elements = {
  setup: document.getElementById("syncSetupBtn"),
  syncNow: document.getElementById("syncNowBtn"),
  showPairing: document.getElementById("showPairingBtn"),
  status: document.getElementById("syncStatus"),
  pairingPanel: document.getElementById("pairingPanel"),
  pairingQr: document.getElementById("pairingQr"),
  copyPairing: document.getElementById("copyPairingLink"),
  hidePairing: document.getElementById("hidePairingBtn"),
  analytics: document.getElementById("analyticsConsentToggle"),
  analyticsLabel: document.querySelector(".switch-label")
};

let bridge = window.SFMC_QUIZ_BRIDGE;
if (!bridge) {
  await new Promise(resolve => window.addEventListener("sfmc:bridge-ready", resolve, { once: true }));
  bridge = window.SFMC_QUIZ_BRIDGE;
}

let supabase = null;
let cloudState = readCloudState();
let pendingPair = readPairingHash();
let syncing = false;
let syncTimer = null;
let lastPairingLink = "";

const configured = Boolean(
  /^https:\/\//i.test(String(CONFIG.supabaseUrl || "")) &&
  String(CONFIG.supabasePublishableKey || "").trim()
);

function readCloudState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLOUD_STATE_KEY) || "null");
    return parsed && parsed.profileId && parsed.syncKey ? parsed : null;
  } catch (error) {
    console.warn("Cloud sync settings could not be read.", error);
    return null;
  }
}

function saveCloudState() {
  if (!cloudState) return;
  localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify(cloudState));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value).length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function encodePairPayload(payload) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePairPayload(value) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    return parsed && parsed.v === 1 && parsed.p && parsed.t && parsed.k ? parsed : null;
  } catch (error) {
    return null;
  }
}

function readPairingHash() {
  const match = location.hash.match(/^#pair=([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const payload = decodePairPayload(match[1]);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (payload) {
    bridge.openSettings();
    setStatus("A pairing invitation is ready. Choose Pair This Device to combine its activity.");
  }
  return payload;
}

function randomSecret(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function deviceClass() {
  const width = Math.max(screen.width || 0, innerWidth || 0);
  if (width < 600) return "mobile";
  if (width < 1000 || matchMedia("(pointer:coarse)").matches) return "tablet";
  return "desktop";
}

function setStatus(message, kind = "") {
  if (!elements.status) return;
  elements.status.textContent = message;
  elements.status.classList.toggle("sync-status-good", kind === "good");
  elements.status.classList.toggle("sync-status-error", kind === "error");
}

function readableError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  return fallback;
}

function updateConsentControl(enabled) {
  if (!elements.analytics) return;
  elements.analytics.checked = Boolean(enabled);
  elements.analytics.disabled = !configured || !cloudState || syncing;
  if (elements.analyticsLabel) elements.analyticsLabel.textContent = enabled ? "On" : "Off";
}

function renderControls() {
  if (!elements.setup) return;
  elements.setup.disabled = !configured || syncing;
  elements.setup.textContent = pendingPair ? "Pair This Device" : cloudState ? "Sync Enabled" : "Enable Sync";
  elements.setup.classList.toggle("hidden", Boolean(cloudState && !pendingPair));
  elements.syncNow?.classList.toggle("hidden", !cloudState);
  elements.showPairing?.classList.toggle("hidden", !cloudState);
  if (elements.syncNow) elements.syncNow.disabled = syncing;
  if (elements.showPairing) elements.showPairing.disabled = syncing;
  updateConsentControl(Boolean(cloudState && cloudState.analyticsConsent));
  if (!configured) {
    setStatus("Cloud sync is awaiting its one-time secure service setup.");
  } else if (pendingPair) {
    setStatus("A pairing invitation is ready. Pairing will preserve this device's offline activity and combine it with the anonymous user.");
  } else if (!cloudState) {
    setStatus("Sync is off. Your information remains in this browser.");
  }
}

async function getSupabase() {
  if (supabase) return supabase;
  if (!configured) throw new Error("Cloud sync has not been configured yet.");
  const { createClient } = await import(SUPABASE_MODULE);
  supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey, {
    auth: {
      storageKey: PLAYER_AUTH_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });
  return supabase;
}

async function ensureAnonymousSession() {
  const client = await getSupabase();
  const sessionResult = await client.auth.getSession();
  if (sessionResult.error) throw sessionResult.error;
  if (sessionResult.data.session) return sessionResult.data.session;
  const signInResult = await client.auth.signInAnonymously();
  if (signInResult.error) throw signInResult.error;
  return signInResult.data.session;
}

async function rpc(name, args = {}) {
  const client = await getSupabase();
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
}

async function createProfile() {
  await ensureAnonymousSession();
  const joinToken = randomSecret();
  const profileId = await rpc("create_quiz_profile", {
    p_join_token_hash: await sha256Hex(joinToken),
    p_device_id: bridge.getDeviceId(),
    p_device_class: deviceClass()
  });
  cloudState = {
    profileId,
    joinToken,
    syncKey: randomSecret(),
    appearanceUpdatedAt: new Date().toISOString(),
    analyticsConsent: false,
    statsGeneration: 0
  };
  saveCloudState();
}

async function joinProfile(pair) {
  await ensureAnonymousSession();
  const joined = await rpc("join_quiz_profile", {
    p_profile_id: pair.p,
    p_join_token_hash: await sha256Hex(pair.t),
    p_device_id: bridge.getDeviceId(),
    p_device_class: deviceClass()
  });
  if (!joined) throw new Error("This pairing code has expired. Create a new QR code on the other device.");
  const nextJoinToken = randomSecret();
  await rpc("rotate_quiz_pairing_token", {
    p_profile_id: pair.p,
    p_join_token_hash: await sha256Hex(nextJoinToken)
  });
  const profileStatus = await rpc("get_quiz_profile_status", { p_profile_id: pair.p });
  cloudState = {
    profileId: pair.p,
    joinToken: nextJoinToken,
    syncKey: pair.k,
    appearanceUpdatedAt: null,
    analyticsConsent: Boolean(profileStatus?.analytics_consent),
    statsGeneration: Number(profileStatus?.stats_generation) || 0
  };
  pendingPair = null;
  saveCloudState();
}

async function importSyncKey() {
  return crypto.subtle.importKey("raw", base64UrlToBytes(cloudState.syncKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptPayload(value) {
  const key = await importSyncKey();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptPayload(value) {
  const [ivPart, dataPart] = String(value || "").split(".");
  if (!ivPart || !dataPart) throw new Error("A synced record is incomplete.");
  const key = await importSyncKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(ivPart) }, key, base64UrlToBytes(dataPart));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function syncAppearance() {
  const rows = await rpc("get_quiz_profile_settings", { p_profile_id: cloudState.profileId });
  const server = Array.isArray(rows) ? rows[0] : rows;
  if (server?.encrypted_payload) {
    const remote = await decryptPayload(server.encrypted_payload);
    const remoteTime = new Date(remote.updatedAt || 0).getTime();
    const localTime = new Date(cloudState.appearanceUpdatedAt || 0).getTime();
    if (remoteTime > localTime && remote.themePreference) {
      bridge.setThemePreferenceFromSync(remote.themePreference);
      cloudState.appearanceUpdatedAt = remote.updatedAt;
      saveCloudState();
      return;
    }
  }
  const updatedAt = cloudState.appearanceUpdatedAt || new Date().toISOString();
  const encrypted = await encryptPayload({ themePreference: bridge.getThemePreference(), updatedAt });
  await rpc("upsert_quiz_profile_settings", { p_profile_id: cloudState.profileId, p_encrypted_payload: encrypted });
  cloudState.appearanceUpdatedAt = updatedAt;
  saveCloudState();
}

async function readApproximateRegion() {
  if (!/^https:\/\//i.test(String(CONFIG.regionEndpoint || ""))) return null;
  try {
    const response = await fetch(CONFIG.regionEndpoint, { method: "GET", mode: "cors", cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      countryCode: String(data.countryCode || "").slice(0, 2).toUpperCase() || null,
      regionCode: String(data.regionCode || "").slice(0, 12).toUpperCase() || null,
      regionName: String(data.regionName || "").slice(0, 80) || null
    };
  } catch (error) {
    console.warn("Approximate region was unavailable.", error);
    return null;
  }
}

async function uploadOptedInAnalytics(mergedStats) {
  await rpc("upsert_quiz_analytics", { p_profile_id: cloudState.profileId, p_stats: mergedStats });
  const region = await readApproximateRegion();
  await rpc("upsert_quiz_device_location", {
    p_profile_id: cloudState.profileId,
    p_device_id: bridge.getDeviceId(),
    p_country_code: region?.countryCode || null,
    p_region_code: region?.regionCode || null,
    p_region_name: region?.regionName || null
  });
}

async function syncNow({ quiet = false } = {}) {
  if (!cloudState || syncing || !configured) return;
  syncing = true;
  renderControls();
  if (!quiet) setStatus("Syncing securely…");
  try {
    await ensureAnonymousSession();
    const profileStatus = await rpc("get_quiz_profile_status", { p_profile_id: cloudState.profileId });
    const serverGeneration = Number(profileStatus?.stats_generation) || 0;
    if (serverGeneration > (Number(cloudState.statsGeneration) || 0)) {
      bridge.clearStatsFromSync();
      cloudState.statsGeneration = serverGeneration;
      saveCloudState();
    }
    const localDeviceStats = bridge.getDeviceStats();
    await rpc("upsert_quiz_device_sync", {
      p_profile_id: cloudState.profileId,
      p_device_id: bridge.getDeviceId(),
      p_encrypted_payload: await encryptPayload(localDeviceStats),
      p_quiz_count: (localDeviceStats.sessions || []).length,
      p_device_class: deviceClass()
    });
    const rows = await rpc("get_quiz_profile_sync", { p_profile_id: cloudState.profileId });
    const snapshots = [];
    for (const row of rows || []) {
      try { snapshots.push(await decryptPayload(row.encrypted_payload)); }
      catch (error) { console.warn("A paired device record could not be decrypted and was skipped.", error); }
    }
    if (!snapshots.length) snapshots.push(localDeviceStats);
    const merged = bridge.mergeStatsSnapshots(snapshots);
    bridge.replaceMergedStats(merged);
    await syncAppearance();
    const consent = Boolean(profileStatus?.analytics_consent);
    cloudState.analyticsConsent = consent;
    saveCloudState();
    if (consent) await uploadOptedInAnalytics(merged);
    setStatus(`Synced ${snapshots.length} device${snapshots.length === 1 ? "" : "s"}. Offline activity is combined under one anonymous user.`, "good");
  } catch (error) {
    console.error("Quiz sync failed.", error);
    setStatus(`Sync could not finish: ${error.message || "Please try again."}`, "error");
  } finally {
    syncing = false;
    renderControls();
  }
}

function scheduleSync(delay = 900) {
  if (!cloudState || !configured) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }), delay);
}

function makePairingLink() {
  const url = new URL(location.href);
  url.search = "";
  url.hash = `pair=${encodePairPayload({ v: 1, p: cloudState.profileId, t: cloudState.joinToken, k: cloudState.syncKey })}`;
  return url.href;
}

function renderPairingQr(link) {
  if (typeof window.QRCode !== "function") throw new Error("The built-in QR generator did not load.");
  elements.pairingQr.replaceChildren();
  new window.QRCode(elements.pairingQr, {
    text: link,
    width: 240,
    height: 240,
    colorDark: "#111827",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M
  });
  if (!elements.pairingQr.firstElementChild) throw new Error("This browser could not draw the QR image.");
}

function showPairingLinkFallback() {
  elements.pairingQr.replaceChildren();
  const fallback = document.createElement("p");
  fallback.className = "pairing-qr-fallback";
  fallback.textContent = "QR image unavailable. Use Copy Pairing Link below.";
  elements.pairingQr.appendChild(fallback);
}

async function showPairingCode() {
  if (!cloudState || syncing) return;
  syncing = true;
  renderControls();
  try {
    const freshToken = randomSecret();
    await rpc("rotate_quiz_pairing_token", {
      p_profile_id: cloudState.profileId,
      p_join_token_hash: await sha256Hex(freshToken)
    });
    cloudState.joinToken = freshToken;
    saveCloudState();
    lastPairingLink = makePairingLink();
    elements.pairingPanel?.classList.remove("hidden");
    try {
      renderPairingQr(lastPairingLink);
      setStatus("Pairing code ready. For safety, it expires as soon as one device uses it.", "good");
    } catch (qrError) {
      console.error(qrError);
      showPairingLinkFallback();
      setStatus("The QR image could not be displayed. Use Copy Pairing Link instead.", "error");
    }
  } catch (error) {
    console.error(error);
    setStatus(`The pairing code could not be created: ${readableError(error, "The secure service did not return an error message.")}`, "error");
  } finally {
    syncing = false;
    renderControls();
  }
}

elements.setup?.addEventListener("click", async () => {
  if (!configured || syncing) return;
  syncing = true;
  renderControls();
  setStatus(pendingPair ? "Pairing this device…" : "Enabling secure sync…");
  try {
    if (pendingPair) await joinProfile(pendingPair);
    else if (!cloudState) await createProfile();
    setStatus("Secure sync is enabled.", "good");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Sync could not be enabled.", "error");
  } finally {
    syncing = false;
    renderControls();
  }
  if (cloudState) await syncNow();
});

elements.syncNow?.addEventListener("click", () => syncNow());
elements.showPairing?.addEventListener("click", showPairingCode);
elements.hidePairing?.addEventListener("click", () => elements.pairingPanel?.classList.add("hidden"));
elements.copyPairing?.addEventListener("click", async () => {
  if (!lastPairingLink) return;
  try {
    await navigator.clipboard.writeText(lastPairingLink);
    elements.copyPairing.textContent = "Copied";
    setTimeout(() => { elements.copyPairing.textContent = "Copy Pairing Link"; }, 1600);
  } catch (error) {
    prompt("Copy this pairing link:", lastPairingLink);
  }
});

elements.analytics?.addEventListener("change", async () => {
  if (!cloudState || syncing) return;
  const enabled = elements.analytics.checked;
  syncing = true;
  renderControls();
  setStatus(enabled ? "Enabling anonymous analytics…" : "Removing shared analytics…");
  try {
    await ensureAnonymousSession();
    await rpc("set_quiz_analytics_consent", { p_profile_id: cloudState.profileId, p_enabled: enabled });
    cloudState.analyticsConsent = enabled;
    saveCloudState();
    if (enabled) {
      await uploadOptedInAnalytics(bridge.getStats());
      setStatus("Anonymous analytics is on. The complete saved statistics record and approximate region are shared.", "good");
    } else {
      setStatus("Anonymous analytics is off. Previously shared statistics and location were deleted.", "good");
    }
  } catch (error) {
    console.error(error);
    cloudState.analyticsConsent = !enabled;
    elements.analytics.checked = !enabled;
    setStatus(`Analytics preference could not be changed: ${error.message}`, "error");
  } finally {
    syncing = false;
    renderControls();
  }
});

window.addEventListener("sfmc:stats-changed", () => scheduleSync());
window.addEventListener("sfmc:appearance-changed", event => {
  if (!cloudState) return;
  cloudState.appearanceUpdatedAt = new Date().toISOString();
  saveCloudState();
  scheduleSync();
});
window.addEventListener("sfmc:stats-reset", async () => {
  if (!cloudState || !configured) return;
  try {
    const generation = await rpc("reset_quiz_profile_stats", { p_profile_id: cloudState.profileId });
    cloudState.statsGeneration = Number(generation) || (Number(cloudState.statsGeneration) || 0) + 1;
    saveCloudState();
    scheduleSync(0);
  } catch (error) {
    console.error("Synced statistics could not be reset.", error);
    setStatus("Local statistics were reset, but paired-device data could not be removed yet. Try Sync Now.", "error");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && cloudState) scheduleSync(150);
});

renderControls();
if (cloudState && configured) syncNow({ quiet: true });
setInterval(() => { if (cloudState && !document.hidden) syncNow({ quiet: true }); }, 2 * 60 * 1000);
