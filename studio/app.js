"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const canvas = $("#renderCanvas");
const context = canvas.getContext("2d", { alpha: false });
const demoCanvas = document.createElement("canvas");
const demoContext = demoCanvas.getContext("2d", { alpha: false });
const chromaCanvas = document.createElement("canvas");
const chromaContext = chromaCanvas.getContext("2d", { willReadFrequently: true });

const RATIO_VALUES = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
  "4:5": [4, 5]
};

const FILTERS = {
  none: "none",
  warm: "saturate(1.08) sepia(.18) contrast(1.04)",
  mono: "grayscale(1) contrast(1.08)",
  vivid: "saturate(1.42) contrast(1.1)"
};

const makeTransform = () => ({ scale: 100, x: 0, y: 0, rotation: 0 });
const makeChroma = () => ({ enabled: false, color: "#00ff00", tolerance: 38 });
const makeAdjustments = () => ({ brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0 });
const makeCrop = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
const makeTextStyle = () => ({ family: "system", align: "center", bold: true, italic: false, shadow: true, outlineWidth: 0, outlineColor: "#000000" });

const assets = new Map([
  ["demo-orange", { id: "demo-orange", kind: "video", demo: "tutorial", name: "HANI CUTの使い方.webm", duration: 28.8, width: 1280, height: 720 }],
  ["demo-sky", { id: "demo-sky", kind: "image", demo: 8, name: "サンプル画像.jpg", duration: 5, width: 1920, height: 1080 }]
]);

const initialProject = {
  clips: [
    { id: "guide-intro", assetId: "demo-orange", kind: "video", name: "00 はじめに", start: 0, duration: 3.2, trimStart: 0, demoVariant: 0, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-import", assetId: "demo-orange", kind: "video", name: "01 素材を読み込む", start: 3.2, duration: 3.8, trimStart: 3.2, demoVariant: 1, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-timeline", assetId: "demo-orange", kind: "video", name: "02 トラックを選んで重ねる", start: 7, duration: 3.8, trimStart: 7, demoVariant: 2, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-trim", assetId: "demo-orange", kind: "video", name: "03 カットして整える", start: 10.8, duration: 3.8, trimStart: 10.8, demoVariant: 3, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-text", assetId: "demo-orange", kind: "video", name: "04 テキストを入れる", start: 14.6, duration: 3.8, trimStart: 14.6, demoVariant: 4, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-preview", assetId: "demo-orange", kind: "video", name: "05 再生して確認", start: 18.4, duration: 3.6, trimStart: 18.4, demoVariant: 5, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-export", assetId: "demo-orange", kind: "video", name: "06 動画を書き出す", start: 22, duration: 3.8, trimStart: 22, demoVariant: 6, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-finish", assetId: "demo-orange", kind: "video", name: "さあ、つくろう", start: 25.8, duration: 3, trimStart: 25.8, demoVariant: 7, transform: makeTransform(), filter: "none", volume: 0 }
  ],
  texts: [],
  audios: []
};

const state = {
  clips: structuredClone(initialProject.clips),
  texts: structuredClone(initialProject.texts),
  audios: structuredClone(initialProject.audios),
  ratio: "16:9",
  duration: 28.8,
  time: 0,
  playing: false,
  selectedId: null,
  stageZoom: 66,
  timelineZoom: 100,
  visualLanes: 2,
  textLanes: 1,
  audioLanes: 1,
  history: [],
  future: [],
  exporting: false,
  recorder: null,
  animationFrame: 0,
  clockStartedAt: 0
};

let toastTimer = 0;
let saveTimer = 0;
let databasePromise = null;
let draggedClipId = null;
let audioGraph = null;
let contextMenuReturnFocus = null;
const mediaInstances = new Map();

function projectSnapshot() {
  return structuredClone({
    clips: state.clips,
    texts: state.texts,
    audios: state.audios,
    ratio: state.ratio,
    visualLanes: state.visualLanes,
    textLanes: state.textLanes,
    audioLanes: state.audioLanes
  });
}

function pushHistory() {
  state.history.push(projectSnapshot());
  if (state.history.length > 40) state.history.shift();
  state.future = [];
  updateUndoButtons();
}

function restoreSnapshot(snapshot) {
  pausePlayback();
  disposeAllMediaInstances();
  state.clips = structuredClone(snapshot.clips);
  state.texts = structuredClone(snapshot.texts);
  state.audios = structuredClone(snapshot.audios);
  state.ratio = snapshot.ratio || "16:9";
  state.visualLanes = Math.max(2, Number(snapshot.visualLanes) || 2);
  state.textLanes = Math.max(1, Number(snapshot.textLanes) || 1);
  state.audioLanes = Math.max(1, Number(snapshot.audioLanes) || 1);
  state.selectedId = null;
  applyRatio(state.ratio, false);
  normalizeTimeline();
  renderAll();
  queueSave();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(projectSnapshot());
  restoreSnapshot(state.history.pop());
  updateUndoButtons();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(projectSnapshot());
  restoreSnapshot(state.future.pop());
  updateUndoButtons();
}

function updateUndoButtons() {
  $("#undoButton").disabled = state.history.length === 0;
  $("#redoButton").disabled = state.future.length === 0;
}

function formatTime(value, precise = false) {
  const safe = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const tenth = Math.floor((safe % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${precise ? `.${tenth}` : ""}`;
}

function safeNumber(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}

function ensureItemDefaults(item, track) {
  item.enabled = item.enabled !== false;
  item.fadeIn = safeNumber(item.fadeIn, 0, 0, 60);
  item.fadeOut = safeNumber(item.fadeOut, 0, 0, 60);
  item.speed = safeNumber(item.speed, 1, .25, 4);
  item.loop = Boolean(item.loop);
  item.pan = safeNumber(item.pan, 0, -1, 1);
  if (track === "audio") return item;

  const transform = { ...makeTransform(), ...(item.transform || {}) };
  item.transform = {
    scale: safeNumber(transform.scale, 100, 10, 400),
    x: safeNumber(transform.x, 0, -3000, 3000),
    y: safeNumber(transform.y, 0, -3000, 3000),
    rotation: safeNumber(transform.rotation, 0, -1440, 1440)
  };
  item.opacity = safeNumber(item.opacity, 100, 0, 100);
  item.blendMode = ["source-over", "multiply", "screen", "overlay", "darken", "lighten", "lighter"].includes(item.blendMode) ? item.blendMode : "source-over";
  item.flipX = Boolean(item.flipX);
  item.flipY = Boolean(item.flipY);
  const adjustment = { ...makeAdjustments(), ...(item.adjustments || {}) };
  item.adjustments = {
    brightness: safeNumber(adjustment.brightness, 100, 0, 200),
    contrast: safeNumber(adjustment.contrast, 100, 0, 200),
    saturation: safeNumber(adjustment.saturation, 100, 0, 200),
    hue: safeNumber(adjustment.hue, 0, -180, 180),
    blur: safeNumber(adjustment.blur, 0, 0, 20)
  };
  item.motion ||= {
    enabled: false,
    easing: "ease-in-out",
    end: { ...item.transform, x: item.transform.x + 240, opacity: item.opacity }
  };
  item.motion.enabled = Boolean(item.motion.enabled);
  item.motion.easing = ["linear", "ease-in", "ease-out", "ease-in-out"].includes(item.motion.easing) ? item.motion.easing : "ease-in-out";
  const motionEnd = { ...item.transform, opacity: item.opacity, ...(item.motion.end || {}) };
  item.motion.end = {
    scale: safeNumber(motionEnd.scale, item.transform.scale, 10, 400),
    x: safeNumber(motionEnd.x, item.transform.x + 240, -3000, 3000),
    y: safeNumber(motionEnd.y, item.transform.y, -3000, 3000),
    rotation: safeNumber(motionEnd.rotation, item.transform.rotation, -1440, 1440),
    opacity: safeNumber(motionEnd.opacity, item.opacity, 0, 100)
  };
  if (track === "video") {
    const crop = { ...makeCrop(), ...(item.crop || {}) };
    item.crop = Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, safeNumber(value, 0, 0, 45)]));
    item.chroma = { ...makeChroma(), ...(item.chroma || {}) };
  }
  if (track === "text") {
    item.textStyle = { ...makeTextStyle(), ...(item.textStyle || {}) };
    item.textStyle.family = ["system", "serif", "mono", "rounded"].includes(item.textStyle.family) ? item.textStyle.family : "system";
    item.textStyle.align = ["left", "center", "right"].includes(item.textStyle.align) ? item.textStyle.align : "center";
    item.textStyle.outlineWidth = safeNumber(item.textStyle.outlineWidth, 0, 0, 20);
    item.textStyle.outlineColor = /^#[\da-f]{6}$/i.test(item.textStyle.outlineColor) ? item.textStyle.outlineColor : "#000000";
  }
  return item;
}

function easingValue(value, easing = "linear") {
  const t = clamp(value, 0, 1);
  if (easing === "ease-in") return t * t;
  if (easing === "ease-out") return 1 - (1 - t) ** 2;
  if (easing === "ease-in-out") return t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return t;
}

function visualStateAt(item, time = state.time) {
  const start = { ...(item.transform || makeTransform()), opacity: item.opacity ?? 100 };
  if (!item.motion?.enabled) return start;
  const progress = easingValue((time - item.start) / Math.max(.001, item.duration), item.motion.easing);
  const end = { ...start, ...(item.motion.end || {}) };
  return Object.fromEntries(Object.keys(start).map((key) => [key, start[key] + (safeNumber(end[key], start[key], -10_000, 10_000) - start[key]) * progress]));
}

function fadeFactor(item, time = state.time) {
  const elapsed = clamp(time - item.start, 0, item.duration);
  const remaining = Math.max(0, item.duration - elapsed);
  const fadeIn = item.fadeIn > 0 ? clamp(elapsed / Math.min(item.fadeIn, item.duration), 0, 1) : 1;
  const fadeOut = item.fadeOut > 0 ? clamp(remaining / Math.min(item.fadeOut, item.duration), 0, 1) : 1;
  return Math.min(fadeIn, fadeOut);
}

function mediaSourceTime(item, time, asset) {
  const speed = safeNumber(item.speed, 1, .25, 4);
  const raw = (item.trimStart || 0) + Math.max(0, time - item.start) * speed;
  if (item.loop && asset?.duration > 0) return raw % asset.duration;
  return raw;
}

function canvasFilterFor(item) {
  const adjustment = { ...makeAdjustments(), ...(item.adjustments || {}) };
  return [
    FILTERS[item.filter] || "none",
    `brightness(${safeNumber(adjustment.brightness, 100, 0, 200)}%)`,
    `contrast(${safeNumber(adjustment.contrast, 100, 0, 200)}%)`,
    `saturate(${safeNumber(adjustment.saturation, 100, 0, 200)}%)`,
    `hue-rotate(${safeNumber(adjustment.hue, 0, -180, 180)}deg)`,
    `blur(${safeNumber(adjustment.blur, 0, 0, 20)}px)`
  ].filter((part) => part !== "none").join(" ") || "none";
}

function normalizeTimeline() {
  state.clips.forEach((clip) => {
    ensureItemDefaults(clip, "video");
    clip.start = safeNumber(clip.start, 0, 0, 21_600);
    clip.duration = safeNumber(clip.duration, .5, .5, 21_600);
    clip.lane = Math.floor(safeNumber(clip.lane, 0, 0, 23));
  });
  state.texts.forEach((item) => {
    ensureItemDefaults(item, "text");
    item.start = safeNumber(item.start, 0, 0, 21_600);
    item.duration = safeNumber(item.duration, .5, .5, 21_600);
    item.lane = Math.floor(safeNumber(item.lane, 0, 0, 23));
  });
  state.audios.forEach((item) => {
    ensureItemDefaults(item, "audio");
    item.start = safeNumber(item.start, 0, 0, 21_600);
    item.duration = safeNumber(item.duration, .5, .5, 21_600);
    item.lane = Math.floor(safeNumber(item.lane, 0, 0, 23));
  });
  const visualEnd = state.clips.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
  const textEnd = state.texts.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
  const audioEnd = state.audios.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
  state.visualLanes = Math.min(24, Math.max(2, state.visualLanes || 2, ...state.clips.map((item) => item.lane + 1)));
  state.textLanes = Math.min(24, Math.max(1, state.textLanes || 1, ...state.texts.map((item) => item.lane + 1)));
  state.audioLanes = Math.min(24, Math.max(1, state.audioLanes || 1, ...state.audios.map((item) => item.lane + 1)));
  state.duration = Math.max(1, visualEnd, textEnd, audioEnd);
  state.time = clamp(state.time, 0, state.duration);
  $("#totalTime").textContent = formatTime(state.duration, true);
  $("#clipCount").textContent = `${state.clips.length} クリップ`;
}

function activeClipAt(time) {
  const clips = activeClipsAt(time);
  return clips[clips.length - 1] || null;
}

function activeClipsAt(time) {
  return state.clips
    .filter((clip) => clip.enabled !== false && time >= clip.start && time <= clip.start + clip.duration)
    .sort((left, right) => (left.lane || 0) - (right.lane || 0) || state.clips.indexOf(left) - state.clips.indexOf(right));
}

function selectedItem() {
  if (!state.selectedId) return null;
  for (const [track, items] of [["video", state.clips], ["text", state.texts], ["audio", state.audios]]) {
    const item = items.find((entry) => entry.id === state.selectedId);
    if (item) return { track, item };
  }
  return null;
}

function showToast(message) {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

function closeContextMenu(restoreFocus = false) {
  const menu = $("#contextMenu");
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  if (restoreFocus && contextMenuReturnFocus?.isConnected) contextMenuReturnFocus.focus({ preventScroll: true });
  contextMenuReturnFocus = null;
}

function openContextMenu(title, items, event, returnFocus = null) {
  const menu = $("#contextMenu");
  const heading = document.createElement("p");
  heading.className = "context-menu-heading";
  heading.textContent = title;
  const children = [heading];
  items.forEach((item) => {
    if (item.separator) {
      const separator = document.createElement("div");
      separator.className = "context-menu-separator";
      separator.setAttribute("role", "separator");
      children.push(separator);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `context-menu-item${item.danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.disabled = Boolean(item.disabled);
    const icon = document.createElement("span");
    icon.className = "context-menu-icon";
    icon.textContent = item.icon || "•";
    const label = document.createElement("span");
    label.className = "context-menu-label";
    label.textContent = item.label;
    const shortcut = document.createElement("kbd");
    shortcut.textContent = item.shortcut || "";
    button.append(icon, label, shortcut);
    if (!button.disabled) button.addEventListener("click", () => {
      closeContextMenu();
      item.action?.();
    });
    children.push(button);
  });
  menu.replaceChildren(...children);
  contextMenuReturnFocus = returnFocus;
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const anchorRect = event.target.getBoundingClientRect();
  const requestedX = event.clientX || anchorRect.left + Math.min(24, anchorRect.width / 2);
  const requestedY = event.clientY || anchorRect.top + Math.min(24, anchorRect.height / 2);
  const left = clamp(requestedX, 8, Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  const top = clamp(requestedY, 8, Math.max(8, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function timelineTimeFromClientX(clientX) {
  const rect = $("#timelineContent").getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration;
}

function switchPanel(name) {
  $$(".panel-tab").forEach((tab) => {
    const active = tab.dataset.panel === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $$(".panel-view").forEach((view) => { view.hidden = view.dataset.view !== name; });
}

function renderAssets() {
  const grid = $("#assetGrid");
  grid.replaceChildren();
  assets.forEach((asset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-card";
    button.draggable = true;
    button.title = "クリックしてタイムラインに追加";
    button.dataset.assetId = asset.id;

    const thumb = document.createElement("span");
    thumb.className = "asset-thumb";
    if (asset.id === "demo-orange") thumb.classList.add("thumb-orange");
    else if (asset.id === "demo-sky") thumb.classList.add("thumb-sky");
    else if (asset.kind === "audio") thumb.classList.add("thumb-audio");
    else thumb.classList.add("thumb-imported");

    if (asset.thumbnail) {
      const image = document.createElement("img");
      image.src = asset.thumbnail;
      image.alt = "";
      thumb.append(image);
    } else if (asset.kind === "audio") {
      thumb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13M9 9l10-2"/></svg>';
    }

    const type = document.createElement("i");
    type.className = "asset-kind";
    type.textContent = asset.kind.toUpperCase();
    thumb.append(type);
    if (asset.duration) {
      const duration = document.createElement("i");
      duration.className = "duration-badge";
      duration.textContent = formatTime(asset.duration);
      thumb.append(duration);
    }

    const name = document.createElement("span");
    name.className = "asset-name";
    name.textContent = asset.name;
    const meta = document.createElement("span");
    meta.className = "asset-meta";
    meta.textContent = asset.kind === "audio" ? "オーディオ" : `${asset.width || "–"} × ${asset.height || "–"}`;
    button.append(thumb, name, meta);
    button.addEventListener("click", () => addAssetToTimeline(asset.id));
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/hani-asset", asset.id);
      event.dataTransfer.effectAllowed = "copy";
    });
    grid.append(button);
  });
  $("#assetCount").textContent = `${assets.size}個`;
}

function timelineClass(item, track) {
  if (track === "text") return "clip-text";
  if (track === "audio") return "clip-audio";
  if (item.assetId === "demo-sky" || assets.get(item.assetId)?.kind === "image") return "clip-sky";
  return item.demoVariant === 2 ? "clip-orange clip-alt" : "clip-orange";
}

function timelineClipElement(item, track) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `timeline-clip ${timelineClass(item, track)}`;
  element.classList.toggle("is-selected", state.selectedId === item.id);
  element.classList.toggle("has-motion", Boolean(item.motion?.enabled));
  element.classList.toggle("is-disabled", item.enabled === false);
  element.dataset.id = item.id;
  element.dataset.track = track;
  element.dataset.lane = String(item.lane || 0);
  element.style.left = `${item.start / state.duration * 100}%`;
  element.style.width = `${item.duration / state.duration * 100}%`;
  element.setAttribute("aria-label", `${item.name}、${formatTime(item.duration)}のクリップ`);

  const leftHandle = document.createElement("i");
  const rightHandle = document.createElement("i");
  leftHandle.dataset.handle = "left";
  rightHandle.dataset.handle = "right";
  const copy = document.createElement("span");
  const title = document.createElement("b");
  title.textContent = item.name;
  const meta = document.createElement("small");
  meta.textContent = track === "text" ? "テキスト" : `${formatTime(item.start)} – ${formatTime(item.start + item.duration)}`;
  copy.append(title, meta);
  element.append(leftHandle, copy, rightHandle);

  element.addEventListener("click", (event) => {
    event.stopPropagation();
    selectItem(item.id);
  });
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    draggedClipId = item.id;
    event.dataTransfer.setData("text/hani-item", item.id);
    event.dataTransfer.setData("text/hani-track", track);
    event.dataTransfer.effectAllowed = "move";
  });
  element.addEventListener("dragend", () => {
    draggedClipId = null;
    $$(".track.is-drop-target").forEach((trackElement) => trackElement.classList.remove("is-drop-target"));
  });
  leftHandle.addEventListener("pointerdown", (event) => beginTrim(event, item, track, "left"));
  rightHandle.addEventListener("pointerdown", (event) => beginTrim(event, item, track, "right"));
  return element;
}

function renderRuler() {
  const ruler = $("#timeRuler");
  ruler.replaceChildren();
  const interval = state.duration > 60 ? 10 : state.duration > 28 ? 5 : 2;
  for (let second = 0; second <= state.duration + .01; second += interval) {
    const label = document.createElement("span");
    label.style.left = `${second / state.duration * 100}%`;
    label.textContent = formatTime(second);
    ruler.append(label);
  }
}

function renderTimeline() {
  const trackLabels = $("#trackLabels");
  const timelineContent = $("#timelineContent");
  const trackSpecs = [];
  for (let lane = state.visualLanes - 1; lane >= 0; lane -= 1) trackSpecs.push({ track: "video", lane, code: `V${lane + 1}`, name: lane === 0 ? "映像" : "画像・映像" });
  for (let lane = state.textLanes - 1; lane >= 0; lane -= 1) trackSpecs.push({ track: "text", lane, code: `T${lane + 1}`, name: "字幕" });
  for (let lane = 0; lane < state.audioLanes; lane += 1) trackSpecs.push({ track: "audio", lane, code: `A${lane + 1}`, name: "音声" });

  const rulerLabel = document.createElement("div");
  rulerLabel.className = "ruler-label";
  const timeRuler = document.createElement("div");
  timeRuler.className = "time-ruler";
  timeRuler.id = "timeRuler";
  const labels = [rulerLabel];
  const tracks = [timeRuler];
  trackSpecs.forEach((spec) => {
    const label = document.createElement("div");
    label.className = "track-label";
    label.dataset.track = spec.track;
    label.dataset.lane = String(spec.lane);
    const icon = document.createElement("span");
    icon.className = "track-icon";
    icon.textContent = spec.code;
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = spec.name;
    const note = document.createElement("small");
    note.textContent = spec.track === "video" && spec.lane > 0 ? "重ねる" : spec.track === "audio" ? "ミックス" : "";
    copy.append(title, note);
    label.append(icon, copy);
    labels.push(label);

    const trackElement = document.createElement("div");
    trackElement.className = `track ${spec.track}-track`;
    trackElement.dataset.track = spec.track;
    trackElement.dataset.lane = String(spec.lane);
    const items = spec.track === "video" ? state.clips.filter((item) => item.lane === spec.lane)
      : spec.track === "text" ? state.texts.filter((item) => item.lane === spec.lane)
        : state.audios.filter((item) => item.lane === spec.lane);
    trackElement.replaceChildren(...items.map((item) => timelineClipElement(item, spec.track)));
    tracks.push(trackElement);
  });
  const playhead = document.createElement("div");
  playhead.className = "playhead";
  playhead.id = "playhead";
  playhead.tabIndex = 0;
  playhead.setAttribute("role", "slider");
  playhead.setAttribute("aria-label", "再生位置");
  playhead.setAttribute("aria-valuemin", "0");
  playhead.setAttribute("aria-valuemax", String(state.duration));
  playhead.innerHTML = "<span></span>";
  playhead.addEventListener("pointerdown", beginPlayheadDrag);
  playhead.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || state.exporting) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : .1;
    const nextTime = event.key === "Home" ? 0
      : event.key === "End" ? state.duration
        : state.time + (event.key === "ArrowLeft" ? -step : step);
    setCurrentTime(nextTime);
    if (state.playing) state.clockStartedAt = performance.now() - state.time * 1000;
  });
  tracks.push(playhead);
  trackLabels.replaceChildren(...labels);
  timelineContent.replaceChildren(...tracks);
  trackLabels.style.setProperty("--track-rows", String(trackSpecs.length));
  timelineContent.style.setProperty("--track-rows", String(trackSpecs.length));
  renderRuler();
  document.documentElement.style.setProperty("--timeline-width", `${Math.max(900, 12 * state.duration) * state.timelineZoom / 100}px`);
  updatePlayhead();
}

function updatePlayhead() {
  const playhead = $("#playhead");
  playhead.style.left = `${state.time / state.duration * 100}%`;
  playhead.setAttribute("aria-valuemax", String(state.duration));
  playhead.setAttribute("aria-valuenow", state.time.toFixed(2));
  playhead.setAttribute("aria-valuetext", `${formatTime(state.time, true)} / ${formatTime(state.duration, true)}`);
  $("#currentTime").textContent = formatTime(state.time, true);
  if (state.exporting) {
    const percent = clamp(state.time / state.duration * 100, 0, 100);
    $("#exportProgressBar").style.width = `${percent}%`;
    $("#exportProgressText").textContent = `書き出し中… ${Math.round(percent)}%`;
  }
}

function beginPlayheadDrag(event) {
  if (event.button !== 0 || state.exporting) return;
  event.preventDefault();
  event.stopPropagation();
  const playhead = event.currentTarget;
  const timeline = $("#timelineContent");
  const wasPlaying = state.playing;
  if (wasPlaying) pausePlayback();
  playhead.classList.add("is-dragging");

  const seek = (pointerEvent) => {
    const rect = timeline.getBoundingClientRect();
    const ratio = clamp((pointerEvent.clientX - rect.left) / rect.width, 0, 1);
    setCurrentTime(ratio * state.duration);
  };
  const finishDrag = (pointerEvent, commitPosition) => {
    if (commitPosition) seek(pointerEvent);
    playhead.classList.remove("is-dragging");
    playhead.removeEventListener("pointermove", seek);
    playhead.removeEventListener("pointerup", finish);
    playhead.removeEventListener("pointercancel", cancel);
    if (playhead.hasPointerCapture(pointerEvent.pointerId)) playhead.releasePointerCapture(pointerEvent.pointerId);
    if (wasPlaying && state.time < state.duration - .02) {
      state.playing = true;
      state.clockStartedAt = performance.now() - state.time * 1000;
      updatePlaybackButton();
      updateMediaPlayback();
      state.animationFrame = requestAnimationFrame(playbackTick);
    }
  };
  const finish = (pointerEvent) => finishDrag(pointerEvent, true);
  const cancel = (pointerEvent) => finishDrag(pointerEvent, false);

  seek(event);
  playhead.setPointerCapture(event.pointerId);
  playhead.addEventListener("pointermove", seek);
  playhead.addEventListener("pointerup", finish);
  playhead.addEventListener("pointercancel", cancel);
}

function beginTrim(event, item, track, edge) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const original = { duration: item.duration, trimStart: item.trimStart || 0, start: item.start };
  const source = assets.get(item.assetId);
  const speed = safeNumber(item.speed, 1, .25, 4);
  const trimsSource = source && ["video", "audio"].includes(source.kind);
  const maxDuration = trimsSource && !item.loop ? Math.max(.5, (source.duration - original.trimStart) / speed) : 3600;
  const pixels = $("#timelineContent").getBoundingClientRect().width;
  const originalTotal = state.duration;
  pushHistory();
  selectItem(item.id);

  const move = (moveEvent) => {
    const delta = (moveEvent.clientX - startX) / pixels * originalTotal;
    if (edge === "right") {
      item.duration = clamp(original.duration + delta, .5, maxDuration);
    } else {
      const lowerBound = trimsSource && !item.loop ? Math.max(-original.start, -original.trimStart / speed) : -original.start;
      const allowed = clamp(delta, lowerBound, original.duration - .5);
      item.start = original.start + allowed;
      item.duration = original.duration - allowed;
      if (trimsSource) item.trimStart = item.loop && source.duration > 0
        ? (original.trimStart + allowed * speed + source.duration) % source.duration
        : original.trimStart + allowed * speed;
    }
    normalizeTimeline();
    renderTimeline();
    renderFrame();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    queueSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}

function selectItem(id) {
  state.selectedId = id;
  renderTimeline();
  renderInspector();
  renderFrame();
}

function updateSelectionFrame(selected = selectedItem()) {
  const frame = $("#selectionFrame");
  const preview = $("#previewCanvas");
  const active = selected && selected.item.enabled !== false && state.time >= selected.item.start && state.time <= selected.item.start + selected.item.duration;
  const visible = Boolean(selected && selected.track !== "audio" && active);
  frame.hidden = !visible;
  preview.classList.toggle("is-movable", Boolean(selected && selected.track === "video" && active));
  if (!visible) {
    frame.style.transform = "";
    return;
  }
  const transform = visualStateAt(selected.item);
  const unit = preview.clientHeight / 720 || 1;
  const scale = (transform.scale || 100) / 100;
  frame.style.transform = `translate(${transform.x * unit}px, ${transform.y * unit}px) rotate(${transform.rotation || 0}deg) scale(${selected.item.flipX ? -scale : scale},${selected.item.flipY ? -scale : scale})`;
}

function renderInspector() {
  const selected = selectedItem();
  $("#inspectorEmpty").hidden = Boolean(selected);
  $("#inspectorContent").hidden = !selected;
  updateSelectionFrame(selected);
  if (!selected) return;

  const { item, track } = selected;
  ensureItemDefaults(item, track);
  const asset = assets.get(item.assetId);
  const visual = track !== "audio";
  $$(".visual-controls").forEach((section) => { section.hidden = !visual; });
  $$(".video-only-controls").forEach((section) => { section.hidden = track !== "video"; });
  $(".chroma-controls").hidden = track !== "video";
  $(".text-controls").hidden = track !== "text";
  $(".volume-controls").hidden = track === "text" || asset?.kind === "image";
  $(".media-speed-controls").hidden = !["video", "audio"].includes(asset?.kind);
  $(".pan-controls").hidden = track === "text" || asset?.kind === "image";
  $("#inspectorTitle").textContent = item.name;
  $("#itemEnabled").checked = item.enabled !== false;
  $("#startTimeControl").value = Number(item.start.toFixed(2));
  $("#durationControl").value = Number(item.duration.toFixed(2));
  $("#fadeIn").value = item.fadeIn;
  $("#fadeOut").value = item.fadeOut;
  $("#speedControl").value = Math.round(item.speed * 100);
  $("#speedValue").textContent = `${Math.round(item.speed * 100)}%`;
  $("#loopPlayback").checked = Boolean(item.loop);

  if (visual) {
    $("#scaleControl").value = item.transform.scale;
    $("#scaleValue").textContent = `${Math.round(item.transform.scale)}%`;
    $("#positionX").value = Math.round(item.transform.x);
    $("#positionY").value = Math.round(item.transform.y);
    $("#rotationControl").value = item.transform.rotation;
    $("#rotationValue").textContent = `${Math.round(item.transform.rotation)}°`;
    $("#opacityControl").value = item.opacity;
    $("#opacityValue").textContent = `${Math.round(item.opacity)}%`;
    $("#flipX").checked = item.flipX;
    $("#flipY").checked = item.flipY;
    $("#blendMode").value = item.blendMode;
    $("#motionEnabled").checked = item.motion.enabled;
    $("#motionEasing").value = item.motion.easing;
    $("#motionX").value = Math.round(item.motion.end.x);
    $("#motionY").value = Math.round(item.motion.end.y);
    $("#motionScale").value = Math.round(item.motion.end.scale);
    $("#motionRotation").value = Math.round(item.motion.end.rotation);
    $("#motionOpacity").value = Math.round(item.motion.end.opacity);
    $("#motionOpacityValue").textContent = `${Math.round(item.motion.end.opacity)}%`;
    const adjustment = item.adjustments;
    $("#brightnessControl").value = adjustment.brightness;
    $("#brightnessValue").textContent = `${Math.round(adjustment.brightness)}%`;
    $("#contrastControl").value = adjustment.contrast;
    $("#contrastValue").textContent = `${Math.round(adjustment.contrast)}%`;
    $("#saturationControl").value = adjustment.saturation;
    $("#saturationValue").textContent = `${Math.round(adjustment.saturation)}%`;
    $("#hueControl").value = adjustment.hue;
    $("#hueValue").textContent = `${Math.round(adjustment.hue)}°`;
    $("#blurControl").value = adjustment.blur;
    $("#blurValue").textContent = `${adjustment.blur}px`;
    $$("#filterList button").forEach((button) => button.classList.toggle("is-active", button.dataset.filter === (item.filter || "none")));
  }
  if (track === "video") {
    $("#chromaEnabled").checked = Boolean(item.chroma.enabled);
    $("#chromaColor").value = item.chroma.color || "#00ff00";
    $("#chromaTolerance").value = safeNumber(item.chroma.tolerance, 38, 5, 100);
    $("#chromaToleranceValue").textContent = `${Math.round(safeNumber(item.chroma.tolerance, 38, 5, 100))}%`;
    $("#cropLeft").value = safeNumber(item.crop.left, 0, 0, 45);
    $("#cropRight").value = safeNumber(item.crop.right, 0, 0, 45);
    $("#cropTop").value = safeNumber(item.crop.top, 0, 0, 45);
    $("#cropBottom").value = safeNumber(item.crop.bottom, 0, 0, 45);
  }
  if (track === "text") {
    $("#textContent").value = item.text;
    $("#textColor").value = item.color || "#fff8e9";
    $("#fontSize").value = item.fontSize || 64;
    $("#fontFamily").value = item.textStyle.family;
    $("#textAlign").value = item.textStyle.align;
    $("#textBold").checked = item.textStyle.bold;
    $("#textItalic").checked = item.textStyle.italic;
    $("#textShadow").checked = item.textStyle.shadow;
    $("#outlineWidth").value = item.textStyle.outlineWidth;
    $("#outlineColor").value = item.textStyle.outlineColor;
  }
  if (track !== "text") {
    $("#volumeControl").value = Math.round((item.volume ?? 1) * 100);
    $("#volumeValue").textContent = `${Math.round((item.volume ?? 1) * 100)}%`;
    $("#panControl").value = Math.round(item.pan * 100);
    $("#panValue").textContent = Math.abs(item.pan) < .01 ? "中央" : item.pan < 0 ? `左 ${Math.round(Math.abs(item.pan) * 100)}` : `右 ${Math.round(item.pan * 100)}`;
  }
}

function mutateSelected(callback, redrawTimeline = false) {
  const selected = selectedItem();
  if (!selected) return;
  callback(selected.item, selected.track);
  if (redrawTimeline) renderTimeline();
  renderFrame();
  updateSelectionFrame(selected);
  queueSave();
}

function beginStageDrag(event) {
  if (event.button !== 0 || state.exporting) return;
  let selected = selectedItem();
  const selectedIsActive = selected?.track === "video"
    && state.time >= selected.item.start && state.time <= selected.item.start + selected.item.duration;
  const item = selectedIsActive ? selected.item : activeClipAt(state.time);
  if (!item) return;
  if (state.selectedId !== item.id) {
    selectItem(item.id);
    selected = selectedItem();
  }

  event.preventDefault();
  const preview = event.currentTarget;
  const rect = preview.getBoundingClientRect();
  const unit = rect.height / 720 || 1;
  item.transform ||= makeTransform();
  const original = { x: item.transform.x || 0, y: item.transform.y || 0 };
  const start = { x: event.clientX, y: event.clientY };
  pushHistory();
  preview.classList.add("is-dragging");

  const move = (pointerEvent) => {
    item.transform.x = clamp(original.x + (pointerEvent.clientX - start.x) / unit, -1440, 1440);
    item.transform.y = clamp(original.y + (pointerEvent.clientY - start.y) / unit, -1440, 1440);
    $("#positionX").value = Math.round(item.transform.x);
    $("#positionY").value = Math.round(item.transform.y);
    renderFrame();
    updateSelectionFrame(selected);
  };
  const finishDrag = (pointerEvent, keepPosition) => {
    if (!keepPosition) {
      item.transform.x = original.x;
      item.transform.y = original.y;
      renderFrame();
      updateSelectionFrame(selected);
    }
    preview.classList.remove("is-dragging");
    preview.removeEventListener("pointermove", move);
    preview.removeEventListener("pointerup", finish);
    preview.removeEventListener("pointercancel", cancel);
    if (preview.hasPointerCapture(pointerEvent.pointerId)) preview.releasePointerCapture(pointerEvent.pointerId);
    queueSave();
  };
  const finish = (pointerEvent) => finishDrag(pointerEvent, true);
  const cancel = (pointerEvent) => finishDrag(pointerEvent, false);

  preview.setPointerCapture(event.pointerId);
  preview.addEventListener("pointermove", move);
  preview.addEventListener("pointerup", finish);
  preview.addEventListener("pointercancel", cancel);
}

function fillRoundRect(target, x, y, width, height, radius, fill, stroke = null, lineWidth = 1) {
  target.beginPath();
  if (typeof target.roundRect === "function") target.roundRect(x, y, width, height, radius);
  else target.rect(x, y, width, height);
  if (fill) {
    target.fillStyle = fill;
    target.fill();
  }
  if (stroke) {
    target.strokeStyle = stroke;
    target.lineWidth = lineWidth;
    target.stroke();
  }
}

function drawDemoScene(target, width, height, variant, localTime) {
  if (variant === "tutorial") {
    const phases = [3.2, 3.8, 3.8, 3.8, 3.8, 3.6, 3.8, 3];
    let remaining = localTime;
    variant = 7;
    for (let index = 0; index < phases.length; index += 1) {
      if (remaining < phases[index]) {
        variant = index;
        localTime = remaining;
        break;
      }
      remaining -= phases[index];
    }
  }

  const unit = Math.min(width / 1280, height / 720);
  const x = (value) => value * unit;
  const pulse = Math.sin(localTime * 2.4) * .5 + .5;
  const ink = "#f4f1e8";
  const muted = "#a3a096";
  const accent = "#ff725e";
  const cream = "#f0c980";
  const mint = "#85d4b2";

  const write = (text, px, py, size, color = ink, weight = 700, align = "left", maxWidth) => {
    target.fillStyle = color;
    target.font = `${weight} ${x(size)}px system-ui, sans-serif`;
    target.textAlign = align;
    target.textBaseline = "alphabetic";
    target.fillText(text, px, py, maxWidth);
  };

  const line = (x1, y1, x2, y2, color = "#4b4a43", lineWidth = 2) => {
    target.beginPath();
    target.moveTo(x1, y1);
    target.lineTo(x2, y2);
    target.strokeStyle = color;
    target.lineWidth = x(lineWidth);
    target.stroke();
  };

  if (variant === 8) {
    const sampleGradient = target.createLinearGradient(0, 0, width, height);
    sampleGradient.addColorStop(0, "#84b8d4");
    sampleGradient.addColorStop(.52, "#dce8dd");
    sampleGradient.addColorStop(1, "#56715d");
    target.fillStyle = sampleGradient;
    target.fillRect(0, 0, width, height);
    target.fillStyle = "rgba(255,255,255,.76)";
    target.beginPath();
    target.arc(width * .74, height * .24, x(68), 0, Math.PI * 2);
    target.fill();
    write("SAMPLE IMAGE", width * .07, height * .83, 20, "#26453f", 800);
    write("あなたの素材に入れ替えてください", width * .07, height * .9, 42, "#17342e", 900);
    return;
  }

  const backdrop = target.createLinearGradient(0, 0, width, height);
  backdrop.addColorStop(0, "#11110f");
  backdrop.addColorStop(.64, "#181713");
  backdrop.addColorStop(1, "#241b16");
  target.fillStyle = backdrop;
  target.fillRect(0, 0, width, height);

  target.save();
  target.globalAlpha = .14;
  target.strokeStyle = "#5b5446";
  target.lineWidth = 1;
  for (let gridX = 0; gridX < width; gridX += x(64)) line(gridX, 0, gridX, height, "#514c43", 1);
  for (let gridY = 0; gridY < height; gridY += x(64)) line(0, gridY, width, gridY, "#514c43", 1);
  target.restore();

  target.fillStyle = "rgba(9,9,8,.7)";
  target.fillRect(0, 0, width, x(68));
  line(0, x(68), width, x(68), "#34332e", 1);
  fillRoundRect(target, x(32), x(23), x(24), x(20), x(4), accent);
  fillRoundRect(target, x(43), x(27), x(24), x(12), x(3), cream);
  write("HANI", x(80), x(43), 20, ink, 900);
  write("CUT", x(139), x(43), 20, accent, 900);
  write("BASIC GUIDE", width - x(34), x(42), 12, muted, 800, "right");

  if (variant === 0) {
    target.save();
    target.translate(width / 2, height / 2 + x(12));
    target.scale(.96 + pulse * .04, .96 + pulse * .04);
    write("HANI CUT", 0, -x(38), 76, ink, 900, "center");
    write("基本操作ガイド", 0, x(30), 42, cream, 900, "center");
    write("素材を読み込んで、編集して、動画にするまで。", 0, x(84), 20, muted, 650, "center");
    fillRoundRect(target, -x(70), x(116), x(140), x(34), x(17), "rgba(255,114,94,.14)", "rgba(255,114,94,.45)", x(1));
    write("約30秒", 0, x(140), 14, accent, 850, "center");
    target.restore();
  } else if (variant === 7) {
    write("これで準備完了。", width / 2, height * .35, 58, ink, 900, "center");
    write("さあ、あなたの動画をつくろう。", width / 2, height * .46, 30, cream, 800, "center");
    const chipY = height * .56;
    ["1  素材を追加", "2  重ねて編集", "3  保存・書き出し"].forEach((label, index) => {
      const chipX = width / 2 + x((index - 1) * 220);
      fillRoundRect(target, chipX - x(96), chipY, x(192), x(46), x(23), index === 0 ? accent : "#25241f", index === 0 ? null : "#46453e", x(1));
      write(label, chipX, chipY + x(30), 15, index === 0 ? "#211411" : ink, 800, "center");
    });
    write("左の「素材を選ぶ」から、はじめてみてください。", width / 2, height * .75, 17, muted, 650, "center");
  } else {
    const steps = [
      null,
      ["素材を読み込む", "左の「素材を選ぶ」へ、動画・画像・音声をドロップ。"],
      ["トラックを選んで重ねる", "＋トラックから、映像・画像、音声、字幕を選べます。"],
      ["カットして整える", "右クリックで分割・削除。リップル削除なら後ろの素材も詰められます。"],
      ["テキストを入れる", "フォント、縁取り、影、位置を調整してタイトルや字幕を追加。"],
      ["再生して確認する", "再生ボタンやスペースキーで、いつでもプレビュー。"],
      ["保存して書き出す", "作業データは再編集用、完成動画は最大60fpsで保存。"]
    ];
    const [title, description] = steps[variant];
    write(`0${variant} / 06`, x(66), x(146), 14, accent, 900);
    write(title, x(66), x(208), 44, ink, 900);
    write(description, x(67), x(252), 16, muted, 650, "left", Math.min(width * .45, x(500)));

    const cardX = Math.max(width * .54, x(600));
    const cardY = x(130);
    const cardW = Math.min(width - cardX - x(54), x(590));
    const cardH = Math.min(height - cardY - x(78), x(470));
    fillRoundRect(target, cardX, cardY, cardW, cardH, x(14), "#20201c", "#45443d", x(1));

    if (variant === 1) {
      target.save();
      target.setLineDash([x(9), x(8)]);
      fillRoundRect(target, cardX + cardW * .16, cardY + x(54), cardW * .68, cardH * .56, x(12), "rgba(255,114,94,.06)", accent, x(2));
      target.restore();
      const arrowY = cardY + x(112 - pulse * 12);
      line(cardX + cardW / 2, arrowY + x(34), cardX + cardW / 2, arrowY, accent, 4);
      line(cardX + cardW / 2, arrowY, cardX + cardW / 2 - x(12), arrowY + x(12), accent, 4);
      line(cardX + cardW / 2, arrowY, cardX + cardW / 2 + x(12), arrowY + x(12), accent, 4);
      write("素材を選ぶ", cardX + cardW / 2, cardY + cardH * .55, 20, ink, 850, "center");
      write("動画・画像・音声", cardX + cardW / 2, cardY + cardH * .64, 12, muted, 650, "center");
      ["MOV", "JPG", "MP3"].forEach((type, index) => {
        const fileX = cardX + cardW * .19 + index * cardW * .22;
        fillRoundRect(target, fileX, cardY + cardH * .78, cardW * .18, x(42), x(6), index === 0 ? "#794339" : index === 1 ? "#456a72" : "#3c6455");
        write(type, fileX + cardW * .09, cardY + cardH * .78 + x(27), 10, ink, 900, "center");
      });
    }

    if (variant === 2) {
      write("タイムライン", cardX + x(28), cardY + x(42), 12, muted, 800);
      for (let track = 0; track < 3; track += 1) {
        const trackY = cardY + x(72 + track * 92);
        fillRoundRect(target, cardX + x(24), trackY, cardW - x(48), x(70), x(6), "#171714", "#31312c", x(1));
      }
      const clips = [
        [cardX + x(38), cardY + x(84), cardW * .28, "#9e4d40"],
        [cardX + x(48) + cardW * .28, cardY + x(84), cardW * .22, "#6b95aa"],
        [cardX + x(58) + cardW * .5, cardY + x(84), cardW * .32, "#9e4d40"]
      ];
      clips.forEach(([clipX, clipY, clipW, color], index) => {
        fillRoundRect(target, clipX, clipY, clipW, x(46), x(5), color, index === Math.floor(pulse * 3) ? cream : "rgba(255,255,255,.2)", x(2));
        write(`クリップ ${index + 1}`, clipX + x(12), clipY + x(29), 10, ink, 800);
      });
      fillRoundRect(target, cardX + x(56), cardY + x(186), cardW * .48, x(38), x(5), cream);
      write("タイトル", cardX + x(70), cardY + x(211), 10, "#231d13", 850);
      line(cardX + cardW * (.22 + pulse * .54), cardY + x(64), cardX + cardW * (.22 + pulse * .54), cardY + cardH - x(35), accent, 2);
    }

    if (variant === 3) {
      write("端をつかんでドラッグ", cardX + cardW / 2, cardY + x(74), 15, muted, 750, "center");
      const spread = x(10 + pulse * 22);
      const clipX = cardX + x(74) - spread;
      const clipW = cardW - x(148) + spread * 2;
      fillRoundRect(target, clipX, cardY + x(128), clipW, x(92), x(7), "#8f4537", cream, x(2));
      fillRoundRect(target, clipX + x(7), cardY + x(143), x(7), x(62), x(3), cream);
      fillRoundRect(target, clipX + clipW - x(14), cardY + x(143), x(7), x(62), x(3), cream);
      line(clipX - x(30), cardY + x(174), clipX - x(6), cardY + x(174), cream, 3);
      line(clipX + clipW + x(6), cardY + x(174), clipX + clipW + x(30), cardY + x(174), cream, 3);
      write("00:03.8", cardX + cardW / 2, cardY + x(183), 14, ink, 850, "center");
      line(cardX + cardW / 2, cardY + x(246), cardX + cardW / 2, cardY + x(340), accent, 2);
      target.strokeStyle = accent;
      target.lineWidth = x(3);
      target.beginPath();
      target.arc(cardX + cardW / 2 - x(10), cardY + x(280), x(9), 0, Math.PI * 2);
      target.arc(cardX + cardW / 2 + x(10), cardY + x(280), x(9), 0, Math.PI * 2);
      target.stroke();
      write("再生位置で「分割」", cardX + cardW / 2, cardY + x(335), 14, ink, 800, "center");
    }

    if (variant === 4) {
      fillRoundRect(target, cardX + x(28), cardY + x(34), cardW * .29, cardH - x(68), x(8), "#171714", "#34332e", x(1));
      write("テキスト", cardX + x(48), cardY + x(70), 13, ink, 850);
      ["大きなタイトル", "シンプル字幕", "ラベル"].forEach((label, index) => {
        const buttonY = cardY + x(94 + index * 62);
        fillRoundRect(target, cardX + x(43), buttonY, cardW * .22, x(45), x(6), index === Math.floor(pulse * 3) ? "#3e3525" : "#24241f", index === Math.floor(pulse * 3) ? cream : "#393832", x(1));
        write(label, cardX + x(55), buttonY + x(28), 10, index === Math.floor(pulse * 3) ? cream : muted, 750);
      });
      const screenX = cardX + cardW * .38;
      const screenY = cardY + x(54);
      fillRoundRect(target, screenX, screenY, cardW * .55, cardH - x(108), x(7), "#b85843");
      write("字幕もかんたん", screenX + cardW * .275, screenY + (cardH - x(108)) * .52, 32, "#fff8e9", 900, "center", cardW * .48);
      target.strokeStyle = cream;
      target.lineWidth = x(2);
      target.strokeRect(screenX + cardW * .06, screenY + (cardH - x(108)) * .35, cardW * .43, x(72));
    }

    if (variant === 5) {
      const centerX = cardX + cardW / 2;
      const centerY = cardY + cardH * .43;
      target.fillStyle = "#151512";
      target.beginPath();
      target.arc(centerX, centerY, x(64), 0, Math.PI * 2);
      target.fill();
      target.fillStyle = cream;
      target.beginPath();
      target.moveTo(centerX - x(15), centerY - x(24));
      target.lineTo(centerX + x(28), centerY);
      target.lineTo(centerX - x(15), centerY + x(24));
      target.closePath();
      target.fill();
      write("SPACE", centerX, cardY + cardH * .7, 18, ink, 900, "center");
      write("再生 / 一時停止", centerX, cardY + cardH * .78, 12, muted, 650, "center");
      ["16:9", "9:16", "1:1", "4:5"].forEach((ratio, index) => {
        const chipX = centerX + x((index - 1.5) * 82);
        fillRoundRect(target, chipX - x(34), cardY + cardH * .86, x(68), x(28), x(14), index === Math.floor(pulse * 4) ? accent : "#292923");
        write(ratio, chipX, cardY + cardH * .86 + x(19), 9, index === Math.floor(pulse * 4) ? "#251512" : muted, 850, "center");
      });
    }

    if (variant === 6) {
      fillRoundRect(target, cardX + cardW - x(154), cardY + x(28), x(124), x(38), x(7), accent);
      write("書き出す", cardX + cardW - x(92), cardY + x(53), 13, "#251512", 900, "center");
      fillRoundRect(target, cardX + x(86), cardY + x(92), cardW - x(172), cardH - x(132), x(11), "#282721", "#4b4a42", x(1));
      write("動画を書き出す", cardX + x(116), cardY + x(138), 22, ink, 900);
      write("Full HD  ・  最大60 fps", cardX + x(116), cardY + x(177), 12, muted, 700);
      fillRoundRect(target, cardX + x(116), cardY + x(210), cardW - x(232), x(8), x(4), "#141411");
      fillRoundRect(target, cardX + x(116), cardY + x(210), (cardW - x(232)) * (.16 + pulse * .78), x(8), x(4), mint);
      fillRoundRect(target, cardX + x(116), cardY + x(250), cardW - x(232), x(44), x(7), accent);
      write("WebMで書き出す", cardX + cardW / 2, cardY + x(279), 13, "#251512", 900, "center");
      write("素材は端末の外へ送られません", cardX + cardW / 2, cardY + x(329), 10, mint, 750, "center");
    }

    for (let index = 1; index <= 6; index += 1) {
      target.fillStyle = index === variant ? accent : "#48473f";
      target.beginPath();
      target.arc(width / 2 + x((index - 3.5) * 24), height - x(34), index === variant ? x(5) : x(3), 0, Math.PI * 2);
      target.fill();
    }
  }
}

function hexToRgb(value) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value || "");
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : [0, 255, 0];
}

function drawCover(source, sourceWidth, sourceHeight, item, currentTime = state.time) {
  if (!sourceWidth || !sourceHeight) return;
  const transform = visualStateAt(item, currentTime);
  const crop = { ...makeCrop(), ...(item.crop || {}) };
  const left = safeNumber(crop.left, 0, 0, 45) / 100;
  const right = safeNumber(crop.right, 0, 0, 45) / 100;
  const top = safeNumber(crop.top, 0, 0, 45) / 100;
  const bottom = safeNumber(crop.bottom, 0, 0, 45) / 100;
  const sourceX = sourceWidth * left;
  const sourceY = sourceHeight * top;
  const croppedWidth = sourceWidth * Math.max(.1, 1 - left - right);
  const croppedHeight = sourceHeight * Math.max(.1, 1 - top - bottom);
  const opacity = clamp((transform.opacity ?? 100) / 100 * fadeFactor(item, currentTime), 0, 1);
  if (opacity <= .001) return;
  const chroma = item.chroma || makeChroma();
  const useChroma = Boolean(chroma?.enabled);
  const target = useChroma ? chromaContext : context;
  if (useChroma) {
    if (chromaCanvas.width !== canvas.width || chromaCanvas.height !== canvas.height) {
      chromaCanvas.width = canvas.width;
      chromaCanvas.height = canvas.height;
    }
    target.clearRect(0, 0, chromaCanvas.width, chromaCanvas.height);
  }
  const baseScale = Math.max(canvas.width / croppedWidth, canvas.height / croppedHeight);
  const scale = baseScale * (transform.scale || 100) / 100;
  const drawWidth = croppedWidth * scale;
  const drawHeight = croppedHeight * scale;
  const unit = canvas.height / 720;
  target.save();
  if (!useChroma) {
    target.globalAlpha = opacity;
    target.globalCompositeOperation = item.blendMode || "source-over";
  }
  target.translate(canvas.width / 2 + (transform.x || 0) * unit, canvas.height / 2 + (transform.y || 0) * unit);
  target.rotate((transform.rotation || 0) * Math.PI / 180);
  target.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
  target.filter = canvasFilterFor(item);
  target.drawImage(source, sourceX, sourceY, croppedWidth, croppedHeight, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  target.restore();
  if (!useChroma) return;

  try {
    const frame = target.getImageData(0, 0, chromaCanvas.width, chromaCanvas.height);
    const pixels = frame.data;
    const [red, green, blue] = hexToRgb(chroma.color);
    const threshold = safeNumber(chroma.tolerance, 38, 5, 100) / 100 * 360;
    const softness = Math.max(12, threshold * .2);
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue;
      const distance = Math.hypot(pixels[index] - red, pixels[index + 1] - green, pixels[index + 2] - blue);
      if (distance <= threshold) pixels[index + 3] = 0;
      else if (distance < threshold + softness) pixels[index + 3] *= (distance - threshold) / softness;
    }
    target.putImageData(frame, 0, 0);
  } catch (_) {}
  context.save();
  context.globalAlpha = opacity;
  context.globalCompositeOperation = item.blendMode || "source-over";
  context.drawImage(chromaCanvas, 0, 0);
  context.restore();
}

function drawWrappedText(item, currentTime = state.time) {
  const unit = canvas.height / 720;
  const transform = visualStateAt(item, currentTime);
  const style = { ...makeTextStyle(), ...(item.textStyle || {}) };
  const fontSize = (item.fontSize || 64) * unit;
  const families = {
    system: 'system-ui, "Yu Gothic UI", Meiryo, sans-serif',
    serif: '"Yu Mincho", "Hiragino Mincho ProN", serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    rounded: '"Arial Rounded MT Bold", "BIZ UDPGothic", system-ui, sans-serif'
  };
  const family = families[style.family] || families.system;
  context.save();
  context.globalAlpha = clamp((transform.opacity ?? 100) / 100 * fadeFactor(item, currentTime), 0, 1);
  context.globalCompositeOperation = item.blendMode || "source-over";
  context.filter = canvasFilterFor(item);
  context.translate(canvas.width / 2 + transform.x * unit, canvas.height / 2 + transform.y * unit);
  context.rotate(transform.rotation * Math.PI / 180);
  context.scale((item.flipX ? -1 : 1) * transform.scale / 100, (item.flipY ? -1 : 1) * transform.scale / 100);
  context.textAlign = ["left", "center", "right"].includes(style.align) ? style.align : "center";
  context.textBaseline = "middle";
  context.font = `${style.italic ? "italic " : ""}${style.bold ? 800 : 400} ${fontSize}px ${family}`;
  context.fillStyle = item.color || "#fff8e9";
  context.shadowColor = style.shadow ? "rgba(0,0,0,.55)" : "transparent";
  context.shadowBlur = style.shadow ? fontSize * .18 : 0;
  context.shadowOffsetY = style.shadow ? fontSize * .06 : 0;
  context.lineJoin = "round";
  context.strokeStyle = style.outlineColor || "#000000";
  context.lineWidth = safeNumber(style.outlineWidth, 0, 0, 20) * unit * 2;
  const lines = String(item.text || "テキスト").split("\n").slice(0, 4);
  const lineHeight = fontSize * 1.18;
  const maxWidth = canvas.width * .82;
  const textX = style.align === "left" ? -maxWidth / 2 : style.align === "right" ? maxWidth / 2 : 0;
  lines.forEach((line, index) => {
    const y = (index - (lines.length - 1) / 2) * lineHeight;
    if (context.lineWidth > 0) context.strokeText(line, textX, y, maxWidth);
    context.fillText(line, textX, y, maxWidth);
  });
  context.restore();
}

function timelineMediaInstance(item, asset = assets.get(item.assetId)) {
  if (!asset || asset.demo !== undefined || !["video", "audio"].includes(asset.kind)) return null;
  if (mediaInstances.has(item.id)) return mediaInstances.get(item.id);
  const element = document.createElement(asset.kind);
  element.src = asset.url || asset.element?.src || "";
  element.preload = "auto";
  element.playsInline = true;
  if (!asset.url?.startsWith("blob:")) element.crossOrigin = "anonymous";
  element.addEventListener("loadedmetadata", () => {
    updateMediaPlayback();
    if (asset.kind === "video") renderFrame();
  }, { once: true });
  if (asset.kind === "video") element.addEventListener("seeked", () => { if (!state.playing) renderFrame(); });
  const instance = { element, sourceNode: null, gainNode: null, panNode: null };
  mediaInstances.set(item.id, instance);
  if (audioGraph) connectTimelineAudio(instance);
  return instance;
}

function disposeMediaInstance(itemId) {
  const instance = mediaInstances.get(itemId);
  if (!instance) return;
  instance.element.pause();
  instance.element.removeAttribute("src");
  instance.element.load();
  try { instance.sourceNode?.disconnect(); } catch (_) {}
  try { instance.gainNode?.disconnect(); } catch (_) {}
  try { instance.panNode?.disconnect(); } catch (_) {}
  mediaInstances.delete(itemId);
}

function disposeAllMediaInstances() {
  [...mediaInstances.keys()].forEach(disposeMediaInstance);
}

function renderFrame() {
  context.save();
  context.fillStyle = "#141411";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const activeClips = activeClipsAt(state.time);
  let drewVisual = false;
  activeClips.forEach((clip) => {
    const asset = assets.get(clip.assetId);
    const localTime = mediaSourceTime(clip, state.time, asset);
    if (asset?.demo !== undefined) {
      demoCanvas.width = canvas.width;
      demoCanvas.height = canvas.height;
      drawDemoScene(demoContext, demoCanvas.width, demoCanvas.height, clip.demoVariant ?? asset.demo, localTime);
      drawCover(demoCanvas, demoCanvas.width, demoCanvas.height, clip, state.time);
      drewVisual = true;
    } else if (asset?.kind === "image" && asset.element?.complete) {
      drawCover(asset.element, asset.width, asset.height, clip, state.time);
      drewVisual = true;
    } else if (asset?.kind === "video") {
      const instance = timelineMediaInstance(clip, asset);
      if (instance?.element.readyState >= 2) {
        drawCover(instance.element, asset.width, asset.height, clip, state.time);
        drewVisual = true;
      }
    }
  });
  if (!drewVisual) {
    context.fillStyle = "#77756c";
    context.font = `600 ${canvas.height * .022}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.fillText(activeClips.length ? "素材を準備しています…" : "素材をタイムラインに追加してください", canvas.width / 2, canvas.height / 2);
  }

  state.texts
    .filter((item) => item.enabled !== false && state.time >= item.start && state.time <= item.start + item.duration)
    .sort((left, right) => (left.lane || 0) - (right.lane || 0))
    .forEach((item) => drawWrappedText(item, state.time));
}

function setCanvasSize(shortSide = 720) {
  const [ratioWidth, ratioHeight] = RATIO_VALUES[state.ratio];
  if (ratioWidth >= ratioHeight) {
    canvas.height = shortSide;
    canvas.width = Math.round(shortSide * ratioWidth / ratioHeight);
  } else {
    canvas.width = shortSide;
    canvas.height = Math.round(shortSide * ratioHeight / ratioWidth);
  }
  renderFrame();
}

function applyRatio(ratio, remember = true) {
  if (!RATIO_VALUES[ratio]) return;
  if (remember && state.ratio !== ratio) pushHistory();
  state.ratio = ratio;
  const preview = $("#previewCanvas");
  preview.className = `preview-canvas ratio-${ratio.replace(":", "-")}`;
  $("#ratioLabel").textContent = ratio;
  $("#ratioMenu").hidden = true;
  setCanvasSize(720);
  queueSave();
}

function updatePlaybackButton() {
  $("#playButton").setAttribute("aria-label", state.playing ? "一時停止" : "再生");
  $("#playIcon").innerHTML = state.playing ? '<path d="M8 6h3v12H8zM13 6h3v12h-3z"/>' : '<path d="m8 5 11 7-11 7V5Z"/>';
}

function updateMediaPlayback() {
  const timelineItems = [
    ...state.clips.filter((item) => assets.get(item.assetId)?.kind === "video" && assets.get(item.assetId)?.demo === undefined),
    ...state.audios
  ];
  const validIds = new Set(timelineItems.map((item) => item.id));
  timelineItems.forEach((item) => {
    const asset = assets.get(item.assetId);
    const instance = timelineMediaInstance(item, asset);
    if (!instance) return;
    const element = instance.element;
    const active = item.enabled !== false && state.time >= item.start && state.time < item.start + item.duration;
    if (active) {
      const wanted = mediaSourceTime(item, state.time, asset);
      if (Number.isFinite(element.duration) && Math.abs(element.currentTime - wanted) > .28) {
        element.currentTime = clamp(wanted, 0, Math.max(0, element.duration - .02));
      }
      element.playbackRate = safeNumber(item.speed, 1, .25, 4);
      element.loop = Boolean(item.loop);
      const volume = (item.volume ?? 1) * fadeFactor(item);
      if (instance.gainNode) instance.gainNode.gain.value = volume;
      else element.volume = clamp(volume, 0, 1);
      if (instance.panNode) instance.panNode.pan.value = safeNumber(item.pan, 0, -1, 1);
    }
    const shouldPlay = active && state.playing;
    if (shouldPlay && element.paused) element.play().catch(() => {});
    if (!shouldPlay && !element.paused) element.pause();
  });
  [...mediaInstances.keys()].filter((id) => !validIds.has(id)).forEach(disposeMediaInstance);
}

function setCurrentTime(value, sync = true) {
  state.time = clamp(value, 0, state.duration);
  updatePlayhead();
  renderFrame();
  updateSelectionFrame();
  if (sync) updateMediaPlayback();
}

function pausePlayback() {
  state.playing = false;
  cancelAnimationFrame(state.animationFrame);
  updatePlaybackButton();
  updateMediaPlayback();
}

function playbackTick(now) {
  if (!state.playing) return;
  const nextTime = (now - state.clockStartedAt) / 1000;
  if (nextTime >= state.duration) {
    setCurrentTime(state.duration, false);
    state.playing = false;
    updatePlaybackButton();
    updateMediaPlayback();
    if (state.exporting && state.recorder?.state !== "inactive") state.recorder.stop();
    return;
  }
  setCurrentTime(nextTime, false);
  updateMediaPlayback();
  state.animationFrame = requestAnimationFrame(playbackTick);
}

async function togglePlayback() {
  if (state.exporting) return;
  if (state.playing) {
    pausePlayback();
    return;
  }
  await ensureAudioGraph().catch(() => null);
  if (state.time >= state.duration - .02) state.time = 0;
  state.playing = true;
  state.clockStartedAt = performance.now() - state.time * 1000;
  updatePlaybackButton();
  updateMediaPlayback();
  state.animationFrame = requestAnimationFrame(playbackTick);
}

function itemsOverlap(leftStart, leftDuration, rightStart, rightDuration) {
  return leftStart < rightStart + rightDuration - .01 && rightStart < leftStart + leftDuration - .01;
}

function findAvailableLane(items, start, duration, firstLane = 0) {
  let lane = clamp(Math.floor(firstLane), 0, 23);
  while (lane < 23 && items.some((item) => item.lane === lane && itemsOverlap(start, duration, item.start, item.duration))) lane += 1;
  return Math.min(23, lane);
}

function snappedTime(value) {
  const safe = Math.max(0, value);
  return $("#snapButton")?.classList.contains("is-active") ? Math.round(safe * 2) / 2 : safe;
}

function addAssetToTimeline(assetId, placement = {}) {
  const asset = assets.get(assetId);
  if (!asset) return;
  pushHistory();
  let added;
  if (asset.kind === "audio") {
    const start = snappedTime(placement.start ?? state.time);
    const duration = clamp(asset.duration || Math.max(state.duration - start, .5), .5, 3600);
    const lane = Number.isInteger(placement.lane) ? placement.lane : findAvailableLane(state.audios, start, duration);
    added = { id: uid("audio"), assetId, kind: "audio", name: asset.name, start, duration, trimStart: 0, volume: .8, lane };
    state.audios.push(added);
    state.audioLanes = Math.max(state.audioLanes, lane + 1);
    switchPanel("sound");
  } else {
    const available = asset.kind === "video" ? asset.duration : 5;
    const duration = clamp(available || 5, .5, 600);
    const hasPlacement = Number.isFinite(placement.start);
    const defaultStart = asset.kind === "video"
      ? state.clips.filter((item) => item.lane === 0).reduce((max, item) => Math.max(max, item.start + item.duration), 0)
      : state.time;
    const start = snappedTime(hasPlacement ? placement.start : defaultStart);
    const firstLane = asset.kind === "image" ? 1 : 0;
    const lane = Number.isInteger(placement.lane) ? placement.lane : findAvailableLane(state.clips, start, duration, firstLane);
    added = { id: uid("clip"), assetId, kind: asset.kind, name: asset.name, start, duration, trimStart: 0, transform: makeTransform(), chroma: makeChroma(), filter: "none", volume: 1, lane };
    state.clips.push(added);
    state.visualLanes = Math.max(state.visualLanes, lane + 1);
  }
  normalizeTimeline();
  state.selectedId = added.id;
  renderTimeline();
  renderInspector();
  renderFrame();
  queueSave();
  const trackName = asset.kind === "audio" ? `A${added.lane + 1}` : `V${added.lane + 1}`;
  showToast(`${asset.name} を ${trackName} に追加しました`);
}

function addText(preset = "title", placement = {}) {
  pushHistory();
  const settings = {
    title: { text: "タイトルを入力", size: 64 },
    subtitle: { text: "字幕を入力", size: 32 },
    label: { text: "LABEL / 01", size: 24 }
  }[preset] || { text: "テキストを入力", size: 48 };
  const start = Number.isFinite(placement.start) ? snappedTime(placement.start) : Math.min(state.time, Math.max(0, state.duration - .5));
  const duration = Math.min(4, Math.max(.5, state.duration - start));
  const lane = Number.isInteger(placement.lane) ? placement.lane : findAvailableLane(state.texts, start, duration);
  const item = {
    id: uid("text"), kind: "text", name: settings.text, text: settings.text,
    start, duration, lane,
    preset, fontSize: settings.size, color: "#fff8e9", transform: makeTransform(), filter: "none"
  };
  state.texts.push(item);
  state.textLanes = Math.max(state.textLanes, lane + 1);
  state.selectedId = item.id;
  normalizeTimeline();
  renderTimeline();
  renderInspector();
  renderFrame();
  switchPanel("text");
  $("#textContent").focus();
  $("#textContent").select();
  queueSave();
}

function splitSelected() {
  const selected = selectedItem();
  const selectedTrack = selected?.track === "audio" ? "audio" : "video";
  let clip = ["video", "audio"].includes(selected?.track) ? selected.item : activeClipAt(state.time);
  if (!clip) return showToast("分割する映像または音声を選んでください");
  const splitAt = clamp(state.time - clip.start, 0, clip.duration);
  if (splitAt < .25 || clip.duration - splitAt < .25) return showToast("クリップの途中に再生位置を移動してください");
  pushHistory();
  const list = selectedTrack === "audio" ? state.audios : state.clips;
  const index = list.findIndex((item) => item.id === clip.id);
  const right = structuredClone(clip);
  right.id = uid(selectedTrack === "audio" ? "audio" : "clip");
  right.start = clip.start + splitAt;
  right.duration = clip.duration - splitAt;
  right.trimStart = (clip.trimStart || 0) + splitAt * safeNumber(clip.speed, 1, .25, 4);
  clip.duration = splitAt;
  list.splice(index + 1, 0, right);
  state.selectedId = right.id;
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast("再生位置でクリップを分割しました");
}

function duplicateSelected() {
  const selected = selectedItem();
  if (!selected) return showToast("複製する項目を選んでください");
  pushHistory();
  const list = selected.track === "video" ? state.clips : selected.track === "text" ? state.texts : state.audios;
  const copy = structuredClone(selected.item);
  copy.id = uid(selected.track === "video" ? "clip" : selected.track);
  copy.name = `${selected.item.name} コピー`;
  copy.start = snappedTime(selected.item.start + selected.item.duration);
  copy.lane = findAvailableLane(list, copy.start, copy.duration, selected.item.lane || 0);
  list.push(copy);
  if (selected.track === "video") state.visualLanes = Math.max(state.visualLanes, copy.lane + 1);
  if (selected.track === "text") state.textLanes = Math.max(state.textLanes, copy.lane + 1);
  if (selected.track === "audio") state.audioLanes = Math.max(state.audioLanes, copy.lane + 1);
  state.selectedId = copy.id;
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast(`${selected.item.name} を複製しました`);
}

function saveCurrentFrame() {
  renderFrame();
  try {
    canvas.toBlob((blob) => {
      if (!blob) return showToast("静止画を保存できませんでした");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = ($("#projectName").value || "hani-cut").replace(/[\\/:*?"<>|]/g, "-");
      link.href = url;
      link.download = `${safeName}-${state.time.toFixed(2).replace(".", "-")}s.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast("現在のフレームをPNGで保存しました");
    }, "image/png");
  } catch (_) {
    showToast("静止画を保存できませんでした");
  }
}

function deleteSelected() {
  const selected = selectedItem();
  if (!selected) return showToast("削除する項目を選んでください");
  pushHistory();
  const list = selected.track === "video" ? state.clips : selected.track === "text" ? state.texts : state.audios;
  list.splice(list.findIndex((item) => item.id === selected.item.id), 1);
  disposeMediaInstance(selected.item.id);
  state.selectedId = null;
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast("選択した項目を削除しました");
}

function rippleDeleteFromList(list, target) {
  const index = list.findIndex((item) => item.id === target.id);
  if (index < 0) return 0;
  const lane = Number(target.lane) || 0;
  const removedDuration = Math.max(.5, Number(target.duration) || .5);
  const removedEnd = (Number(target.start) || 0) + removedDuration;
  list.splice(index, 1);
  let shifted = 0;
  list.forEach((item) => {
    if ((Number(item.lane) || 0) !== lane || item.start < removedEnd - .001) return;
    item.start = Math.max(0, item.start - removedDuration);
    shifted += 1;
  });
  return shifted;
}

function rippleDeleteSelected() {
  const selected = selectedItem();
  if (!selected) return showToast("リップル削除する項目を選んでください");
  pushHistory();
  const list = selected.track === "video" ? state.clips : selected.track === "text" ? state.texts : state.audios;
  const removedStart = selected.item.start;
  const shifted = rippleDeleteFromList(list, selected.item);
  disposeMediaInstance(selected.item.id);
  state.selectedId = null;
  state.time = removedStart;
  normalizeTimeline();
  renderAll();
  updateMediaPlayback();
  queueSave();
  showToast(shifted ? `リップル削除して、後ろの${shifted}項目を詰めました` : "リップル削除しました");
}

function toggleSelectedEnabled() {
  const selected = selectedItem();
  if (!selected) return;
  pushHistory();
  selected.item.enabled = selected.item.enabled === false;
  const enabled = selected.item.enabled;
  renderAll();
  queueSave();
  showToast(enabled ? "選択項目を有効にしました" : "選択項目を無効にしました");
}

function addTimelineTrack(kind) {
  const config = kind === "video" ? { key: "visualLanes", prefix: "V", label: "映像・画像" }
    : kind === "audio" ? { key: "audioLanes", prefix: "A", label: "音声" }
      : kind === "text" ? { key: "textLanes", prefix: "T", label: "字幕" } : null;
  if (!config) return false;
  if (state[config.key] >= 24) {
    showToast(`${config.label}トラックは最大24本です`);
    return false;
  }
  pushHistory();
  state[config.key] += 1;
  renderTimeline();
  queueSave();
  showToast(`${config.prefix}${state[config.key]} ${config.label}トラックを追加しました`);
  return true;
}

function jumpToBoundary(direction) {
  const items = [...state.clips, ...state.texts, ...state.audios];
  const points = [0, state.duration, ...items.flatMap((item) => [item.start, item.start + item.duration])].sort((a, b) => a - b);
  const target = direction < 0 ? [...points].reverse().find((point) => point < state.time - .05) : points.find((point) => point > state.time + .05);
  setCurrentTime(target ?? (direction < 0 ? 0 : state.duration));
}

function moveTimelineItem(itemId, clientX, targetTrack, targetLane, trackElement) {
  const selected = [
    { track: "video", items: state.clips },
    { track: "text", items: state.texts },
    { track: "audio", items: state.audios }
  ].find((group) => group.items.some((item) => item.id === itemId));
  if (!selected || selected.track !== targetTrack) return showToast("同じ種類のトラックへ移動してください");
  const item = selected.items.find((entry) => entry.id === itemId);
  const rect = trackElement.getBoundingClientRect();
  const targetTime = snappedTime(clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration);
  pushHistory();
  item.start = targetTime;
  const requestedLane = Math.max(0, Number(targetLane) || 0);
  item.lane = findAvailableLane(selected.items.filter((entry) => entry.id !== item.id), item.start, item.duration, requestedLane);
  if (selected.track === "video") state.visualLanes = Math.max(state.visualLanes, item.lane + 1);
  if (selected.track === "text") state.textLanes = Math.max(state.textLanes, item.lane + 1);
  if (selected.track === "audio") state.audioLanes = Math.max(state.audioLanes, item.lane + 1);
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast(`${item.name} を ${formatTime(item.start, true)} へ移動しました`);
}

function waitForEvent(element, eventName) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("media load failed")); };
    const cleanup = () => { element.removeEventListener(eventName, done); element.removeEventListener("error", fail); };
    element.addEventListener(eventName, done, { once: true });
    element.addEventListener("error", fail, { once: true });
  });
}

async function createAssetFromFile(file, forcedId = null) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const kind = file.type.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(extension) ? "video"
    : file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(extension) ? "image"
      : file.type.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(extension) ? "audio" : null;
  if (!kind) throw new Error("unsupported");
  const id = forcedId || uid("asset");
  const url = URL.createObjectURL(file);
  const asset = { id, kind, name: file.name, file, url, duration: 0, width: 0, height: 0, thumbnail: "" };

  if (kind === "image") {
    const image = new Image();
    image.src = url;
    await image.decode();
    asset.element = image;
    asset.width = image.naturalWidth;
    asset.height = image.naturalHeight;
    asset.duration = 5;
    asset.thumbnail = url;
  } else {
    const media = document.createElement(kind === "video" ? "video" : "audio");
    media.src = url;
    media.preload = "auto";
    media.playsInline = true;
    await waitForEvent(media, "loadedmetadata");
    asset.element = media;
    asset.duration = Number.isFinite(media.duration) ? media.duration : 5;
    if (kind === "video") {
      asset.width = media.videoWidth;
      asset.height = media.videoHeight;
      media.addEventListener("seeked", () => { if (!state.playing) renderFrame(); });
      try {
        media.currentTime = Math.min(.12, asset.duration / 2);
        await waitForEvent(media, "seeked");
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = 240;
        thumbCanvas.height = 135;
        const thumbContext = thumbCanvas.getContext("2d");
        const scale = Math.max(240 / asset.width, 135 / asset.height);
        thumbContext.drawImage(media, (240 - asset.width * scale) / 2, (135 - asset.height * scale) / 2, asset.width * scale, asset.height * scale);
        asset.thumbnail = thumbCanvas.toDataURL("image/jpeg", .76);
        media.currentTime = 0;
      } catch (_) {
        asset.thumbnail = "";
      }
    }
  }
  return asset;
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const zone = $("#importZone");
  zone.classList.add("is-loading");
  let imported = 0;
  for (const file of files) {
    try {
      const asset = await createAssetFromFile(file);
      assets.set(asset.id, asset);
      await saveAssetFile(asset);
      addAssetToTimeline(asset.id);
      imported += 1;
    } catch (_) {
      showToast(`${file.name} は読み込めませんでした`);
    }
  }
  zone.classList.remove("is-loading");
  renderAssets();
  if (imported) showToast(`${imported}個の素材を読み込みました`);
}

function setupInspectorControls() {
  $("#itemEnabled").addEventListener("change", (event) => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.enabled = event.target.checked; }, true);
    updateMediaPlayback();
  });
  $("#duplicateInspectorButton").addEventListener("click", duplicateSelected);
  $("#scaleControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.transform.scale = Number(event.target.value);
    $("#scaleValue").textContent = `${event.target.value}%`;
  }));
  $("#positionX").addEventListener("input", (event) => mutateSelected((item) => { item.transform.x = Number(event.target.value); }));
  $("#positionY").addEventListener("input", (event) => mutateSelected((item) => { item.transform.y = Number(event.target.value); }));
  $("#rotationControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.transform.rotation = Number(event.target.value);
    $("#rotationValue").textContent = `${event.target.value}°`;
  }));
  $("#opacityControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.opacity = Number(event.target.value);
    $("#opacityValue").textContent = `${event.target.value}%`;
  }));
  ["X", "Y"].forEach((axis) => $("#flip" + axis).addEventListener("change", (event) => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item[`flip${axis}`] = event.target.checked; });
  }));
  $("#blendMode").addEventListener("change", (event) => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.blendMode = event.target.value; });
  });
  $("#motionEnabled").addEventListener("change", (event) => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item, track) => {
      if (track === "audio") return;
      ensureItemDefaults(item, track);
      item.motion.enabled = event.target.checked;
    }, true);
  });
  $("#motionEasing").addEventListener("change", (event) => mutateSelected((item) => { item.motion.easing = event.target.value; }));
  const motionInputs = { motionX: "x", motionY: "y", motionScale: "scale", motionRotation: "rotation", motionOpacity: "opacity" };
  Object.entries(motionInputs).forEach(([id, key]) => $("#" + id).addEventListener("input", (event) => mutateSelected((item) => {
    item.motion.end[key] = Number(event.target.value);
    if (key === "opacity") $("#motionOpacityValue").textContent = `${event.target.value}%`;
  })));
  $("#volumeControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.volume = Number(event.target.value) / 100;
    $("#volumeValue").textContent = `${event.target.value}%`;
    updateMediaPlayback();
  }));
  $("#panControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.pan = Number(event.target.value) / 100;
    $("#panValue").textContent = Math.abs(item.pan) < .01 ? "中央" : item.pan < 0 ? `左 ${Math.round(Math.abs(item.pan) * 100)}` : `右 ${Math.round(item.pan * 100)}`;
    updateMediaPlayback();
  }));
  $("#startTimeControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.start = safeNumber(event.target.value, item.start, 0, 21_600);
    normalizeTimeline();
    updateMediaPlayback();
  }, true));
  $("#durationControl").addEventListener("input", (event) => mutateSelected((item) => {
    let duration = safeNumber(event.target.value, item.duration, .5, 21_600);
    const asset = assets.get(item.assetId);
    if (!item.loop && asset?.duration > 0 && ["video", "audio"].includes(asset.kind)) {
      duration = Math.min(duration, Math.max(.5, (asset.duration - (item.trimStart || 0)) / safeNumber(item.speed, 1, .25, 4)));
    }
    item.duration = duration;
    normalizeTimeline();
    updateMediaPlayback();
  }, true));
  ["fadeIn", "fadeOut"].forEach((id) => $("#" + id).addEventListener("input", (event) => mutateSelected((item) => {
    item[id] = safeNumber(event.target.value, 0, 0, 60);
    updateMediaPlayback();
  })));
  $("#speedControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.speed = Number(event.target.value) / 100;
    const asset = assets.get(item.assetId);
    if (!item.loop && asset?.duration > 0) item.duration = Math.min(item.duration, Math.max(.5, (asset.duration - (item.trimStart || 0)) / item.speed));
    $("#speedValue").textContent = `${event.target.value}%`;
    updateMediaPlayback();
    normalizeTimeline();
  }, true));
  $("#loopPlayback").addEventListener("change", (event) => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.loop = event.target.checked; });
    updateMediaPlayback();
  });
  $("#textContent").addEventListener("input", (event) => mutateSelected((item, track) => {
    if (track !== "text") return;
    item.text = event.target.value;
    item.name = event.target.value.split("\n")[0] || "テキスト";
  }, true));
  $("#textColor").addEventListener("input", (event) => mutateSelected((item) => { item.color = event.target.value; }));
  $("#fontSize").addEventListener("input", (event) => mutateSelected((item) => { item.fontSize = clamp(Number(event.target.value), 16, 300); }));
  $("#fontFamily").addEventListener("change", (event) => mutateSelected((item) => { item.textStyle.family = event.target.value; }));
  $("#textAlign").addEventListener("change", (event) => mutateSelected((item) => { item.textStyle.align = event.target.value; }));
  [["textBold", "bold"], ["textItalic", "italic"], ["textShadow", "shadow"]].forEach(([id, key]) => {
    $("#" + id).addEventListener("change", (event) => {
      if (!selectedItem()) return;
      pushHistory();
      mutateSelected((item) => { item.textStyle[key] = event.target.checked; });
    });
  });
  $("#outlineWidth").addEventListener("input", (event) => mutateSelected((item) => { item.textStyle.outlineWidth = Number(event.target.value); }));
  $("#outlineColor").addEventListener("input", (event) => mutateSelected((item) => { item.textStyle.outlineColor = event.target.value; }));
  const adjustmentInputs = {
    brightnessControl: ["brightness", "brightnessValue", "%"],
    contrastControl: ["contrast", "contrastValue", "%"],
    saturationControl: ["saturation", "saturationValue", "%"],
    hueControl: ["hue", "hueValue", "°"],
    blurControl: ["blur", "blurValue", "px"]
  };
  Object.entries(adjustmentInputs).forEach(([id, [key, outputId, suffix]]) => $("#" + id).addEventListener("input", (event) => mutateSelected((item) => {
    item.adjustments[key] = Number(event.target.value);
    $("#" + outputId).textContent = `${event.target.value}${suffix}`;
  })));
  $("#resetAdjustments").addEventListener("click", () => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.adjustments = makeAdjustments(); });
    renderInspector();
  });
  const cropInputs = { cropLeft: "left", cropRight: "right", cropTop: "top", cropBottom: "bottom" };
  Object.entries(cropInputs).forEach(([id, key]) => $("#" + id).addEventListener("input", (event) => mutateSelected((item, track) => {
    if (track !== "video") return;
    item.crop[key] = safeNumber(event.target.value, 0, 0, 45);
  })));
  $("#resetCrop").addEventListener("click", () => {
    const selected = selectedItem();
    if (selected?.track !== "video") return;
    pushHistory();
    mutateSelected((item) => { item.crop = makeCrop(); });
    renderInspector();
  });
  $("#chromaEnabled").addEventListener("change", (event) => {
    const selected = selectedItem();
    if (selected?.track !== "video") return;
    pushHistory();
    mutateSelected((item) => {
      item.chroma ||= makeChroma();
      item.chroma.enabled = event.target.checked;
    });
  });
  $("#chromaColor").addEventListener("input", (event) => mutateSelected((item, track) => {
    if (track !== "video") return;
    item.chroma ||= makeChroma();
    item.chroma.color = event.target.value;
  }));
  $("#chromaTolerance").addEventListener("input", (event) => mutateSelected((item, track) => {
    if (track !== "video") return;
    item.chroma ||= makeChroma();
    item.chroma.tolerance = Number(event.target.value);
    $("#chromaToleranceValue").textContent = `${event.target.value}%`;
  }));
  $("#resetTransform").addEventListener("click", () => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.transform = makeTransform(); });
    renderInspector();
  });
  $$("#filterList button").forEach((button) => button.addEventListener("click", () => {
    if (!selectedItem()) return;
    pushHistory();
    mutateSelected((item) => { item.filter = button.dataset.filter; });
    renderInspector();
  }));
}

function openDatabase() {
  if (!window.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("hani-cut", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function saveAssetFile(asset) {
  if (!asset.file) return;
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("assets", "readwrite");
      transaction.objectStore("assets").put({ id: asset.id, file: asset.file });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (_) {}
}

async function saveProject() {
  try {
    localStorage.setItem("hani-cut-project-name", $("#projectName").value);
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("projects", "readwrite");
      transaction.objectStore("projects").put({ id: "current", templateVersion: 4, ...projectSnapshot() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const saveState = $(".save-state");
    saveState.lastChild.textContent = " 保存しました";
  } catch (_) {}
}

function queueSave() {
  clearTimeout(saveTimer);
  const saveState = $(".save-state");
  saveState.lastChild.textContent = " 保存中…";
  saveTimer = window.setTimeout(saveProject, 450);
}

function dbGet(storeName, key) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function dbGetAll(storeName) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }));
}

function clearStoredAssets() {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction("assets", "readwrite").objectStore("assets").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToFile(data, name, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: type || "application/octet-stream" });
}

async function downloadProjectData() {
  const button = $("#saveProjectButton");
  button.disabled = true;
  showToast("作業データをまとめています…");
  try {
    clearTimeout(saveTimer);
    await saveProject();
    const bundledAssets = [];
    for (const asset of assets.values()) {
      if (!asset.file) continue;
      bundledAssets.push({
        id: asset.id,
        name: asset.file.name || asset.name,
        type: asset.file.type || "application/octet-stream",
        data: arrayBufferToBase64(await asset.file.arrayBuffer())
      });
    }
    const payload = {
      format: "HANI_CUT_PROJECT",
      version: 1,
      appVersion: 6,
      name: $("#projectName").value || "HANI CUT プロジェクト",
      savedAt: new Date().toISOString(),
      project: projectSnapshot(),
      assets: bundledAssets
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/vnd.hani-cut+json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeName = payload.name.replace(/[\\/:*?"<>|]/g, "-");
    link.href = url;
    link.download = `${safeName}.hanicut`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast("再編集用の作業データを保存しました");
  } catch (_) {
    showToast("作業データを保存できませんでした");
  } finally {
    button.disabled = false;
  }
}

async function loadProjectData(file) {
  const button = $("#loadProjectButton");
  button.disabled = true;
  const createdAssets = [];
  try {
    const payload = JSON.parse(await file.text());
    const project = payload?.project;
    if (!["KOMA_STUDIO_PROJECT", "HANI_STUDIO_PROJECT", "HANI_CUT_PROJECT"].includes(payload?.format) || payload.version !== 1 || !project
      || !Array.isArray(project.clips) || !Array.isArray(project.texts) || !Array.isArray(project.audios)
      || !Array.isArray(payload.assets)) throw new Error("invalid project");
    if (!window.confirm("現在の作業内容を閉じて、この作業データを開きますか？")) return;

    const importedIds = new Set();
    for (const record of payload.assets) {
      if (!record?.id || String(record.id).startsWith("demo-") || importedIds.has(record.id)
        || !record?.name || typeof record.data !== "string") throw new Error("invalid asset");
      importedIds.add(record.id);
      const assetFile = base64ToFile(record.data, record.name, record.type);
      createdAssets.push(await createAssetFromFile(assetFile, record.id));
    }
    const availableIds = new Set(["demo-orange", "demo-sky", ...createdAssets.map((asset) => asset.id)]);
    if ([...project.clips, ...project.audios].some((item) => !availableIds.has(item.assetId))) throw new Error("missing asset");

    pausePlayback();
    disposeAllMediaInstances();
    await clearStoredAssets();
    [...assets.entries()].forEach(([assetId, asset]) => {
      if (assetId.startsWith("demo-")) return;
      if (asset.url) URL.revokeObjectURL(asset.url);
      assets.delete(assetId);
    });
    for (const asset of createdAssets) {
      assets.set(asset.id, asset);
      await saveAssetFile(asset);
    }
    state.clips = structuredClone(project.clips);
    state.texts = structuredClone(project.texts);
    state.audios = structuredClone(project.audios);
    state.ratio = RATIO_VALUES[project.ratio] ? project.ratio : "16:9";
    state.visualLanes = Math.max(2, Number(project.visualLanes) || 2);
    state.textLanes = Math.max(1, Number(project.textLanes) || 1);
    state.audioLanes = Math.max(1, Number(project.audioLanes) || 1);
    state.selectedId = null;
    state.history = [];
    state.future = [];
    $("#projectName").value = String(payload.name || "HANI CUT プロジェクト").slice(0, 40);
    localStorage.setItem("hani-cut-project-name", $("#projectName").value);
    applyRatio(state.ratio, false);
    normalizeTimeline();
    renderAll();
    await saveProject();
    showToast("作業データを開きました。編集を再開できます");
  } catch (_) {
    createdAssets.forEach((asset) => { if (asset.url) URL.revokeObjectURL(asset.url); });
    showToast("この作業データを開けませんでした");
  } finally {
    button.disabled = false;
  }
}

async function loadSavedProject() {
  try {
    const savedName = localStorage.getItem("hani-cut-project-name") || localStorage.getItem("koma-studio-project-name") || localStorage.getItem("hani-studio-project-name");
    if (savedName) {
      const displayName = ["KOMA STUDIO 基本ガイド", "HANI STUDIO 基本ガイド"].includes(savedName) ? "HANI CUT 基本ガイド" : savedName;
      $("#projectName").value = displayName;
      localStorage.setItem("hani-cut-project-name", displayName);
    }
    const [project, storedAssets] = await Promise.all([dbGet("projects", "current"), dbGetAll("assets")]);
    for (const record of storedAssets) {
      try {
        const asset = await createAssetFromFile(record.file, record.id);
        assets.set(asset.id, asset);
      } catch (_) {}
    }
    const legacyDefault = project
      && project.templateVersion !== 2
      && ([...(project.clips || []), ...(project.texts || [])].some((item) => ["clip-opening", "clip-memory", "clip-ending", "text-title"].includes(item.id)))
      && (project.clips || []).every((item) => String(item.assetId || "").startsWith("demo-"));
    if (project && !legacyDefault) {
      const exists = (item) => !item.assetId || assets.has(item.assetId);
      state.clips = (project.clips || []).filter(exists);
      state.texts = project.texts || [];
      state.audios = (project.audios || []).filter(exists);
      state.ratio = project.ratio || "16:9";
      state.visualLanes = Math.max(2, Number(project.visualLanes) || 2);
      state.textLanes = Math.max(1, Number(project.textLanes) || 1);
      state.audioLanes = Math.max(1, Number(project.audioLanes) || 1);
      applyRatio(state.ratio, false);
      normalizeTimeline();
    } else if (legacyDefault) {
      $("#projectName").value = "HANI CUT 基本ガイド";
      localStorage.setItem("hani-cut-project-name", "HANI CUT 基本ガイド");
      saveProject();
    }
    renderAll();
  } catch (_) {
    renderAll();
  }
}

async function ensureAudioGraph() {
  if (audioGraph) {
    if (audioGraph.context.state === "suspended") await audioGraph.context.resume().catch(() => {});
    return audioGraph;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const audioContext = new AudioContextClass();
  const destination = audioContext.createMediaStreamDestination();
  audioGraph = { context: audioContext, destination };
  [...state.clips, ...state.audios].forEach((item) => {
    const asset = assets.get(item.assetId);
    const instance = timelineMediaInstance(item, asset);
    if (instance) connectTimelineAudio(instance);
  });
  await audioContext.resume();
  return audioGraph;
}

function connectTimelineAudio(instance) {
  if (!audioGraph || !instance?.element || instance.gainNode) return;
  try {
    const source = audioGraph.context.createMediaElementSource(instance.element);
    const gain = audioGraph.context.createGain();
    source.connect(gain);
    const pan = typeof audioGraph.context.createStereoPanner === "function" ? audioGraph.context.createStereoPanner() : null;
    const output = pan || gain;
    if (pan) gain.connect(pan);
    output.connect(audioGraph.context.destination);
    output.connect(audioGraph.destination);
    instance.sourceNode = source;
    instance.gainNode = gain;
    instance.panNode = pan;
    instance.element.volume = 1;
  } catch (_) {}
}

function supportedRecorderType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startExport() {
  if (!canvas.captureStream || !window.MediaRecorder) return showToast("このブラウザは動画書き出しに対応していません");
  const startButton = $("#startExportButton");
  startButton.disabled = true;
  $("#exportProgress").hidden = false;
  $("#exportProgressText").textContent = "書き出しを準備しています…";
  const previousTime = state.time;
  const resolution = Number($("#exportResolution").value);
  const fps = Number($("#exportFps").value);

  try {
    const graph = await ensureAudioGraph();
    mediaInstances.forEach((instance) => connectTimelineAudio(instance));
    setCanvasSize(resolution);
    const canvasStream = canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks(), ...(graph ? graph.destination.stream.getAudioTracks() : [])];
    const stream = new MediaStream(tracks);
    const mimeType = supportedRecorderType();
    const baseBitrate = resolution >= 1080 ? 10_000_000 : resolution >= 720 ? 5_000_000 : 2_500_000;
    const videoBitsPerSecond = Math.round(baseBitrate * (fps >= 60 ? 1.7 : 1));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond } : undefined);
    const chunks = [];
    state.recorder = recorder;
    state.exporting = true;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => showToast("動画の書き出しに失敗しました");
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = ($("#projectName").value || "hani-cut").replace(/[\\/:*?"<>|]/g, "-");
      link.href = url;
      link.download = `${safeName}.webm`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 3000);
      state.exporting = false;
      state.recorder = null;
      setCanvasSize(720);
      setCurrentTime(previousTime);
      startButton.disabled = false;
      $("#exportProgressText").textContent = "書き出し完了。ダウンロードしました。";
      $("#exportProgressBar").style.width = "100%";
      showToast("動画を書き出しました");
    };
    setCurrentTime(0);
    recorder.start(250);
    state.playing = true;
    state.clockStartedAt = performance.now();
    updatePlaybackButton();
    updateMediaPlayback();
    state.animationFrame = requestAnimationFrame(playbackTick);
  } catch (_) {
    state.exporting = false;
    state.playing = false;
    startButton.disabled = false;
    setCanvasSize(720);
    $("#exportProgressText").textContent = "書き出しを開始できませんでした。";
    showToast("動画の書き出しを開始できませんでした");
  }
}

function renderAll() {
  normalizeTimeline();
  renderAssets();
  renderTimeline();
  renderInspector();
  renderFrame();
  updateUndoButtons();
}

function setupEvents() {
  $$(".panel-tab").forEach((tab) => tab.addEventListener("click", () => switchPanel(tab.dataset.panel)));
  $("#ratioButton").addEventListener("click", () => { $("#ratioMenu").hidden = !$("#ratioMenu").hidden; });
  $$("#ratioMenu button").forEach((button) => button.addEventListener("click", () => applyRatio(button.dataset.ratio)));
  $("#previewCanvas").addEventListener("pointerdown", beginStageDrag);
  window.addEventListener("resize", () => updateSelectionFrame());
  $("#playButton").addEventListener("click", togglePlayback);
  $("#previousButton").addEventListener("click", () => jumpToBoundary(-1));
  $("#nextButton").addEventListener("click", () => jumpToBoundary(1));
  $("#splitButton").addEventListener("click", splitSelected);
  $("#duplicateButton").addEventListener("click", duplicateSelected);
  $("#saveFrameButton").addEventListener("click", saveCurrentFrame);
  $("#deleteButton").addEventListener("click", deleteSelected);
  $("#undoButton").addEventListener("click", undo);
  $("#redoButton").addEventListener("click", redo);
  $("#projectName").addEventListener("input", queueSave);
  $("#addTextButton").addEventListener("click", () => addText("title"));
  $$(".text-presets button").forEach((button) => button.addEventListener("click", () => addText(button.dataset.preset)));

  const mediaInput = $("#mediaInput");
  mediaInput.addEventListener("change", () => { importFiles(mediaInput.files); mediaInput.value = ""; });
  const audioInput = $("#audioInput");
  audioInput.addEventListener("change", () => { importFiles(audioInput.files); audioInput.value = ""; });
  const zone = $("#importZone");
  ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("is-dragging"); }));
  zone.addEventListener("drop", (event) => importFiles(event.dataTransfer.files));

  const timeline = $("#timelineContent");
  timeline.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".timeline-clip")) return;
    const rect = timeline.getBoundingClientRect();
    setCurrentTime((event.clientX - rect.left) / rect.width * state.duration);
  });
  timeline.addEventListener("dragover", (event) => {
    const targetTrack = event.target.closest(".track");
    if (!targetTrack) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = draggedClipId ? "move" : "copy";
    $$(".track.is-drop-target").forEach((element) => element.classList.toggle("is-drop-target", element === targetTrack));
  });
  timeline.addEventListener("dragleave", (event) => {
    if (!timeline.contains(event.relatedTarget)) $$(".track.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
  });
  timeline.addEventListener("drop", (event) => {
    const targetTrack = event.target.closest(".track");
    if (!targetTrack) return;
    event.preventDefault();
    $$(".track.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
    const itemId = event.dataTransfer.getData("text/hani-item");
    const assetId = event.dataTransfer.getData("text/hani-asset");
    const trackType = targetTrack.dataset.track;
    const lane = Number(targetTrack.dataset.lane) || 0;
    if (itemId) {
      moveTimelineItem(itemId, event.clientX, trackType, lane, targetTrack);
      return;
    }
    const asset = assets.get(assetId);
    if (!asset) return;
    const compatible = (asset.kind === "audio" && trackType === "audio") || (asset.kind !== "audio" && trackType === "video");
    if (!compatible) return showToast("素材と同じ種類のトラックへ置いてください");
    const rect = targetTrack.getBoundingClientRect();
    const start = clamp((event.clientX - rect.left) / rect.width, 0, 1) * state.duration;
    addAssetToTimeline(assetId, { start, lane });
  });
  // 公開環境で後から追加されるスクリプトより先に右クリックを受け取る。
  // 対象外では何もしないため、通常のブラウザメニューはそのまま使える。
  document.addEventListener("contextmenu", (event) => {
    const trackLabel = event.target.closest("#trackLabels .track-label");
    const clipElement = event.target.closest(".timeline-clip");
    const trackElement = event.target.closest(".track");
    const rulerElement = event.target.closest(".time-ruler, .playhead");
    const isTimelineTarget = Boolean(event.target.closest("#timelineContent"));
    if (!trackLabel && (!isTimelineTarget || (!clipElement && !trackElement && !rulerElement))) return;
    event.preventDefault();
    event.stopPropagation();
    if (trackLabel) {
      const kind = trackLabel.dataset.track;
      const label = kind === "video" ? "映像・画像" : kind === "audio" ? "音声" : "字幕";
      const lane = Number(trackLabel.dataset.lane) + 1;
      openContextMenu(`${kind === "video" ? "V" : kind === "audio" ? "A" : "T"}${lane} ${label}トラック`, [
        { label: "同じ種類のトラックを追加", icon: "＋", action: () => addTimelineTrack(kind) }
      ], event, trackLabel);
      return;
    }
    const contextTime = event.clientX ? timelineTimeFromClientX(event.clientX) : state.time;
    if (clipElement) {
      selectItem(clipElement.dataset.id);
      const selected = selectedItem();
      if (!selected) return;
      const canSplit = ["video", "audio"].includes(selected.track)
        && contextTime - selected.item.start >= .25
        && selected.item.start + selected.item.duration - contextTime >= .25;
      const items = [];
      if (["video", "audio"].includes(selected.track)) items.push({
        label: "ここで分割", icon: "✂", shortcut: canSplit ? "" : "端では不可", disabled: !canSplit,
        action: () => { setCurrentTime(contextTime); splitSelected(); }
      });
      items.push(
        { label: "複製", icon: "＋", shortcut: "Ctrl+D", action: duplicateSelected },
        { label: selected.item.enabled === false ? "有効にする" : "無効にする", icon: selected.item.enabled === false ? "ON" : "OFF", action: toggleSelectedEnabled },
        { separator: true },
        { label: "リップル削除", icon: "≪", shortcut: "Shift+Delete", danger: true, action: rippleDeleteSelected },
        { label: "削除", icon: "×", shortcut: "Delete", danger: true, action: deleteSelected }
      );
      const typeName = selected.track === "video" ? "映像・画像クリップ" : selected.track === "audio" ? "音声クリップ" : "字幕";
      openContextMenu(`${typeName}：${selected.item.name}`, items, event);
      return;
    }
    if (rulerElement) {
      openContextMenu("時間目盛り", [
        { label: "ここへ再生位置を移動", icon: "▶", action: () => setCurrentTime(contextTime) },
        { separator: true },
        { label: "前のクリップ境界へ", icon: "←", action: () => jumpToBoundary(-1) },
        { label: "次のクリップ境界へ", icon: "→", action: () => jumpToBoundary(1) }
      ], event, $("#playhead"));
      return;
    }
    const kind = trackElement.dataset.track;
    const label = kind === "video" ? "映像・画像" : kind === "audio" ? "音声" : "字幕";
    const lane = Number(trackElement.dataset.lane) + 1;
    const items = [{ label: "ここへ再生位置を移動", icon: "▶", action: () => setCurrentTime(contextTime) }];
    if (kind === "text") items.push({ label: "ここに字幕を追加", icon: "T", action: () => { setCurrentTime(contextTime); addText("subtitle"); } });
    items.push({ separator: true }, { label: `${label}トラックを追加`, icon: "＋", action: () => addTimelineTrack(kind) });
    openContextMenu(`${kind === "video" ? "V" : kind === "audio" ? "A" : "T"}${lane} ${label}トラック`, items, event, trackElement);
  }, { capture: true });

  $("#snapButton").addEventListener("click", (event) => {
    const active = event.currentTarget.classList.toggle("is-active");
    event.currentTarget.setAttribute("aria-pressed", String(active));
    showToast(active ? "スナップをオンにしました" : "スナップをオフにしました");
  });
  const addTrackButton = $("#addTrackButton");
  const trackMenu = $("#trackMenu");
  const setTrackMenu = (open) => {
    trackMenu.hidden = !open;
    addTrackButton.setAttribute("aria-expanded", String(open));
    if (open) $("#trackMenu button")?.focus();
  };
  addTrackButton.addEventListener("click", () => setTrackMenu(trackMenu.hidden));
  $$("#trackMenu button").forEach((button) => button.addEventListener("click", () => {
    addTimelineTrack(button.dataset.trackKind);
    setTrackMenu(false);
  }));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".track-picker") && !trackMenu.hidden) setTrackMenu(false);
    if (!event.target.closest("#contextMenu") && !$("#contextMenu").hidden) closeContextMenu();
  });
  $("#contextMenu").addEventListener("keydown", (event) => {
    const buttons = $$("#contextMenu button:not(:disabled)");
    if (!buttons.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(document.activeElement));
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  $("#timelineScroll").addEventListener("scroll", () => closeContextMenu());
  window.addEventListener("blur", () => closeContextMenu());

  const timelineZoom = $("#timelineZoom");
  timelineZoom.addEventListener("input", () => { state.timelineZoom = Number(timelineZoom.value); renderTimeline(); });
  $("#timelineZoomOut").addEventListener("click", () => { timelineZoom.value = clamp(Number(timelineZoom.value) - 20, 60, 180); timelineZoom.dispatchEvent(new Event("input")); });
  $("#timelineZoomIn").addEventListener("click", () => { timelineZoom.value = clamp(Number(timelineZoom.value) + 20, 60, 180); timelineZoom.dispatchEvent(new Event("input")); });
  const applyStageZoom = () => { $("#previewCanvas").style.transform = `scale(${state.stageZoom / 66})`; $("#zoomLabel").textContent = `${state.stageZoom}%`; };
  $("#zoomOut").addEventListener("click", () => { state.stageZoom = clamp(state.stageZoom - 10, 36, 96); applyStageZoom(); });
  $("#zoomIn").addEventListener("click", () => { state.stageZoom = clamp(state.stageZoom + 10, 36, 96); applyStageZoom(); });

  $("#exportButton").addEventListener("click", () => { $("#exportModal").hidden = false; });
  $("#saveProjectButton").addEventListener("click", downloadProjectData);
  $("#loadProjectButton").addEventListener("click", () => $("#loadProjectInput").click());
  $("#loadProjectInput").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) loadProjectData(file);
    event.target.value = "";
  });
  $$('[data-close-modal]').forEach((element) => element.addEventListener("click", () => { if (!state.exporting) $("#exportModal").hidden = true; }));
  $("#startExportButton").addEventListener("click", startExport);

  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (event.key === "Escape" && !trackMenu.hidden) setTrackMenu(false);
    if (event.key === "Escape" && !$("#contextMenu").hidden) { event.preventDefault(); closeContextMenu(true); }
    if (event.code === "Space" && !typing) { event.preventDefault(); togglePlayback(); }
    if (["ArrowLeft", "ArrowRight"].includes(event.key) && !typing && document.activeElement?.id !== "playhead") {
      event.preventDefault();
      setCurrentTime(state.time + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 1 / 30));
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !typing) { event.preventDefault(); event.shiftKey ? rippleDeleteSelected() : deleteSelected(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && !typing) { event.preventDefault(); duplicateSelected(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  });

  setupInspectorControls();
}

setCanvasSize(720);
setupEvents();
renderAll();
loadSavedProject();
