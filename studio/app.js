"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const canvas = $("#renderCanvas");
const context = canvas.getContext("2d", { alpha: false });
const demoCanvas = document.createElement("canvas");
const demoContext = demoCanvas.getContext("2d", { alpha: false });

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

const assets = new Map([
  ["demo-orange", { id: "demo-orange", kind: "video", demo: "tutorial", name: "HANI-CUTの使い方.webm", duration: 28.8, width: 1280, height: 720 }],
  ["demo-sky", { id: "demo-sky", kind: "image", demo: 8, name: "サンプル画像.jpg", duration: 5, width: 1920, height: 1080 }]
]);

const initialProject = {
  clips: [
    { id: "guide-intro", assetId: "demo-orange", kind: "video", name: "00 はじめに", start: 0, duration: 3.2, trimStart: 0, demoVariant: 0, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-import", assetId: "demo-orange", kind: "video", name: "01 素材を読み込む", start: 3.2, duration: 3.8, trimStart: 3.2, demoVariant: 1, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-timeline", assetId: "demo-orange", kind: "video", name: "02 タイムラインに並べる", start: 7, duration: 3.8, trimStart: 7, demoVariant: 2, transform: makeTransform(), filter: "none", volume: 0 },
    { id: "guide-trim", assetId: "demo-orange", kind: "video", name: "03 長さを整える", start: 10.8, duration: 3.8, trimStart: 10.8, demoVariant: 3, transform: makeTransform(), filter: "none", volume: 0 },
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

function projectSnapshot() {
  return structuredClone({ clips: state.clips, texts: state.texts, audios: state.audios, ratio: state.ratio });
}

function pushHistory() {
  state.history.push(projectSnapshot());
  if (state.history.length > 40) state.history.shift();
  state.future = [];
  updateUndoButtons();
}

function restoreSnapshot(snapshot) {
  state.clips = structuredClone(snapshot.clips);
  state.texts = structuredClone(snapshot.texts);
  state.audios = structuredClone(snapshot.audios);
  state.ratio = snapshot.ratio || "16:9";
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

function normalizeTimeline() {
  let cursor = 0;
  state.clips.forEach((clip) => {
    clip.start = cursor;
    clip.duration = Math.max(.5, Number(clip.duration) || .5);
    cursor += clip.duration;
  });
  const textEnd = state.texts.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
  const audioEnd = state.audios.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
  state.duration = Math.max(1, cursor, textEnd, audioEnd);
  state.time = clamp(state.time, 0, state.duration);
  $("#totalTime").textContent = formatTime(state.duration, true);
  $("#clipCount").textContent = `${state.clips.length} クリップ`;
}

function activeClipAt(time) {
  return state.clips.find((clip, index) => time >= clip.start && (time < clip.start + clip.duration || (index === state.clips.length - 1 && time <= clip.start + clip.duration)));
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
  element.dataset.id = item.id;
  element.dataset.track = track;
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
  if (track === "video") {
    element.draggable = true;
    element.addEventListener("dragstart", (event) => {
      draggedClipId = item.id;
      event.dataTransfer.setData("text/hani-clip", item.id);
      event.dataTransfer.effectAllowed = "move";
    });
    element.addEventListener("dragend", () => { draggedClipId = null; });
  }
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
  renderRuler();
  const videoTrack = $("#videoTrack");
  const textTrack = $("#textTrack");
  const audioTrack = $("#audioTrack");
  videoTrack.replaceChildren(...state.clips.map((clip) => timelineClipElement(clip, "video")));
  textTrack.replaceChildren(...state.texts.map((text) => timelineClipElement(text, "text")));
  audioTrack.replaceChildren(...state.audios.map((audio) => timelineClipElement(audio, "audio")));
  document.documentElement.style.setProperty("--timeline-width", `${Math.max(900, 12 * state.duration) * state.timelineZoom / 100}px`);
  updatePlayhead();
}

function updatePlayhead() {
  $("#playhead").style.left = `${state.time / state.duration * 100}%`;
  $("#currentTime").textContent = formatTime(state.time, true);
  if (state.exporting) {
    const percent = clamp(state.time / state.duration * 100, 0, 100);
    $("#exportProgressBar").style.width = `${percent}%`;
    $("#exportProgressText").textContent = `書き出し中… ${Math.round(percent)}%`;
  }
}

function beginTrim(event, item, track, edge) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const original = { duration: item.duration, trimStart: item.trimStart || 0, start: item.start };
  const source = assets.get(item.assetId);
  const maxDuration = source && ["video", "audio"].includes(source.kind) ? source.duration : 3600;
  const pixels = $("#timelineContent").getBoundingClientRect().width;
  const originalTotal = state.duration;
  pushHistory();
  selectItem(item.id);

  const move = (moveEvent) => {
    const delta = (moveEvent.clientX - startX) / pixels * originalTotal;
    if (edge === "right") {
      item.duration = clamp(original.duration + delta, .5, Math.max(.5, maxDuration - original.trimStart));
    } else if (track === "video") {
      const allowed = clamp(delta, -original.trimStart, original.duration - .5);
      item.trimStart = original.trimStart + allowed;
      item.duration = original.duration - allowed;
    } else {
      const end = original.start + original.duration;
      item.start = Math.max(0, original.start + delta);
      item.duration = Math.max(.5, end - item.start);
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

function renderInspector() {
  const selected = selectedItem();
  $("#inspectorEmpty").hidden = Boolean(selected);
  $("#inspectorContent").hidden = !selected;
  $("#selectionFrame").hidden = !selected || selected.track === "audio";
  if (!selected) return;

  const { item, track } = selected;
  const visual = track !== "audio";
  $$(".visual-controls").forEach((section) => { section.hidden = !visual; });
  $(".text-controls").hidden = track !== "text";
  $(".volume-controls").hidden = track === "text" || assets.get(item.assetId)?.kind === "image";
  $("#inspectorTitle").textContent = item.name;

  if (visual) {
    item.transform ||= makeTransform();
    $("#scaleControl").value = item.transform.scale;
    $("#scaleValue").textContent = `${Math.round(item.transform.scale)}%`;
    $("#positionX").value = Math.round(item.transform.x);
    $("#positionY").value = Math.round(item.transform.y);
    $("#rotationControl").value = item.transform.rotation;
    $("#rotationValue").textContent = `${Math.round(item.transform.rotation)}°`;
    $$("#filterList button").forEach((button) => button.classList.toggle("is-active", button.dataset.filter === (item.filter || "none")));
  }
  if (track === "text") {
    $("#textContent").value = item.text;
    $("#textColor").value = item.color || "#fff8e9";
    $("#fontSize").value = item.fontSize || 64;
  }
  if (track !== "text") {
    $("#volumeControl").value = Math.round((item.volume ?? 1) * 100);
    $("#volumeValue").textContent = `${Math.round((item.volume ?? 1) * 100)}%`;
  }
}

function mutateSelected(callback, redrawTimeline = false) {
  const selected = selectedItem();
  if (!selected) return;
  callback(selected.item, selected.track);
  if (redrawTimeline) renderTimeline();
  renderFrame();
  queueSave();
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
    write("HANI CUT", 0, -x(38), 84, ink, 900, "center");
    write("基本操作ガイド", 0, x(30), 42, cream, 900, "center");
    write("素材を読み込んで、編集して、動画にするまで。", 0, x(84), 20, muted, 650, "center");
    fillRoundRect(target, -x(70), x(116), x(140), x(34), x(17), "rgba(255,114,94,.14)", "rgba(255,114,94,.45)", x(1));
    write("約30秒", 0, x(140), 14, accent, 850, "center");
    target.restore();
  } else if (variant === 7) {
    write("これで準備完了。", width / 2, height * .35, 58, ink, 900, "center");
    write("さあ、あなたの動画をつくろう。", width / 2, height * .46, 30, cream, 800, "center");
    const chipY = height * .56;
    ["1  素材を追加", "2  並べて編集", "3  書き出す"].forEach((label, index) => {
      const chipX = width / 2 + x((index - 1) * 220);
      fillRoundRect(target, chipX - x(96), chipY, x(192), x(46), x(23), index === 0 ? accent : "#25241f", index === 0 ? null : "#46453e", x(1));
      write(label, chipX, chipY + x(30), 15, index === 0 ? "#211411" : ink, 800, "center");
    });
    write("左の「素材を選ぶ」から、はじめてみてください。", width / 2, height * .75, 17, muted, 650, "center");
  } else {
    const steps = [
      null,
      ["素材を読み込む", "左の「素材を選ぶ」へ、動画・画像・音声をドロップ。"],
      ["タイムラインに並べる", "素材をクリックすると、再生順に追加されます。"],
      ["長さを整える", "クリップの端をドラッグ。再生位置では分割もできます。"],
      ["テキストを入れる", "タイトルや字幕を追加して、文字・色・位置を調整。"],
      ["再生して確認する", "再生ボタンやスペースキーで、いつでもプレビュー。"],
      ["動画を書き出す", "右上の「書き出す」から、完成した動画を保存。"]
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
      write("HD 720p  ・  30 fps", cardX + x(116), cardY + x(177), 12, muted, 700);
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

function drawCover(source, sourceWidth, sourceHeight, transform = makeTransform(), filter = "none") {
  if (!sourceWidth || !sourceHeight) return;
  const baseScale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const scale = baseScale * (transform.scale || 100) / 100;
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const unit = canvas.height / 720;
  context.save();
  context.translate(canvas.width / 2 + (transform.x || 0) * unit, canvas.height / 2 + (transform.y || 0) * unit);
  context.rotate((transform.rotation || 0) * Math.PI / 180);
  context.filter = FILTERS[filter] || "none";
  context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}

function drawWrappedText(item) {
  const unit = canvas.height / 720;
  const transform = item.transform || makeTransform();
  const fontSize = (item.fontSize || 64) * unit;
  const family = item.preset === "label" ? "ui-monospace, monospace" : "system-ui, sans-serif";
  context.save();
  context.translate(canvas.width / 2 + transform.x * unit, canvas.height / 2 + transform.y * unit);
  context.rotate(transform.rotation * Math.PI / 180);
  context.scale(transform.scale / 100, transform.scale / 100);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${item.preset === "subtitle" ? 700 : 900} ${fontSize}px ${family}`;
  context.fillStyle = item.color || "#fff8e9";
  context.shadowColor = "rgba(0,0,0,.38)";
  context.shadowBlur = fontSize * .18;
  context.shadowOffsetY = fontSize * .06;
  const lines = String(item.text || "テキスト").split("\n").slice(0, 4);
  const lineHeight = fontSize * 1.18;
  lines.forEach((line, index) => context.fillText(line, 0, (index - (lines.length - 1) / 2) * lineHeight, canvas.width * .82));
  context.restore();
}

function renderFrame() {
  context.save();
  context.fillStyle = "#141411";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();

  const clip = activeClipAt(state.time);
  if (clip) {
    const asset = assets.get(clip.assetId);
    const localTime = state.time - clip.start + (clip.trimStart || 0);
    if (asset?.demo !== undefined) {
      demoCanvas.width = canvas.width;
      demoCanvas.height = canvas.height;
      drawDemoScene(demoContext, demoCanvas.width, demoCanvas.height, clip.demoVariant ?? asset.demo, localTime);
      drawCover(demoCanvas, demoCanvas.width, demoCanvas.height, clip.transform, clip.filter);
    } else if (asset?.kind === "image" && asset.element?.complete) {
      drawCover(asset.element, asset.width, asset.height, clip.transform, clip.filter);
    } else if (asset?.kind === "video" && asset.element?.readyState >= 2) {
      drawCover(asset.element, asset.width, asset.height, clip.transform, clip.filter);
    } else {
      context.fillStyle = "#8f8c82";
      context.font = `600 ${canvas.height * .022}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.fillText("素材を準備しています…", canvas.width / 2, canvas.height / 2);
    }
  } else {
    context.fillStyle = "#77756c";
    context.font = `600 ${canvas.height * .022}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.fillText("素材をタイムラインに追加してください", canvas.width / 2, canvas.height / 2);
  }

  state.texts.filter((item) => state.time >= item.start && state.time <= item.start + item.duration).forEach(drawWrappedText);
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
  const active = activeClipAt(state.time);
  const activeAsset = active ? assets.get(active.assetId) : null;
  assets.forEach((asset) => {
    if (!asset.element || !["video", "audio"].includes(asset.kind)) return;
    let timelineItem = null;
    if (asset.kind === "video" && activeAsset?.id === asset.id) timelineItem = active;
    if (asset.kind === "audio") timelineItem = state.audios.find((item) => item.assetId === asset.id && state.time >= item.start && state.time < item.start + item.duration);
    const shouldPlay = Boolean(timelineItem && state.playing);
    if (timelineItem) {
      const wanted = (timelineItem.trimStart || 0) + state.time - timelineItem.start;
      if (Number.isFinite(asset.element.duration) && Math.abs(asset.element.currentTime - wanted) > .28) {
        asset.element.currentTime = clamp(wanted, 0, Math.max(0, asset.element.duration - .02));
      }
      const volume = timelineItem.volume ?? 1;
      if (asset.gainNode) asset.gainNode.gain.value = volume;
      else asset.element.volume = clamp(volume, 0, 1);
    }
    if (shouldPlay && asset.element.paused) asset.element.play().catch(() => {});
    if (!shouldPlay && !asset.element.paused) asset.element.pause();
  });
}

function setCurrentTime(value, sync = true) {
  state.time = clamp(value, 0, state.duration);
  updatePlayhead();
  renderFrame();
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

function togglePlayback() {
  if (state.exporting) return;
  if (state.playing) {
    pausePlayback();
    return;
  }
  if (state.time >= state.duration - .02) state.time = 0;
  state.playing = true;
  state.clockStartedAt = performance.now() - state.time * 1000;
  updatePlaybackButton();
  updateMediaPlayback();
  state.animationFrame = requestAnimationFrame(playbackTick);
}

function addAssetToTimeline(assetId) {
  const asset = assets.get(assetId);
  if (!asset) return;
  pushHistory();
  let added;
  if (asset.kind === "audio") {
    added = { id: uid("audio"), assetId, kind: "audio", name: asset.name, start: 0, duration: Math.min(asset.duration || state.duration, Math.max(state.duration, .5)), trimStart: 0, volume: .8 };
    state.audios.push(added);
    switchPanel("sound");
  } else {
    const available = asset.kind === "video" ? asset.duration : 5;
    added = { id: uid("clip"), assetId, kind: asset.kind, name: asset.name, start: 0, duration: clamp(available || 5, .5, 600), trimStart: 0, transform: makeTransform(), filter: "none", volume: 1 };
    state.clips.push(added);
  }
  normalizeTimeline();
  state.selectedId = added.id;
  renderTimeline();
  renderInspector();
  renderFrame();
  queueSave();
  showToast(`${asset.name} をタイムラインに追加しました`);
}

function addText(preset = "title") {
  pushHistory();
  const settings = {
    title: { text: "タイトルを入力", size: 64 },
    subtitle: { text: "字幕を入力", size: 32 },
    label: { text: "LABEL / 01", size: 24 }
  }[preset] || { text: "テキストを入力", size: 48 };
  const item = {
    id: uid("text"), kind: "text", name: settings.text, text: settings.text,
    start: Math.min(state.time, Math.max(0, state.duration - .5)), duration: Math.min(4, Math.max(.5, state.duration - state.time)),
    preset, fontSize: settings.size, color: "#fff8e9", transform: makeTransform(), filter: "none"
  };
  state.texts.push(item);
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
  let clip = selected?.track === "video" ? selected.item : activeClipAt(state.time);
  if (!clip) return showToast("分割する映像クリップを選んでください");
  const splitAt = clamp(state.time - clip.start, 0, clip.duration);
  if (splitAt < .25 || clip.duration - splitAt < .25) return showToast("クリップの途中に再生位置を移動してください");
  pushHistory();
  const index = state.clips.findIndex((item) => item.id === clip.id);
  const right = structuredClone(clip);
  right.id = uid("clip");
  right.duration = clip.duration - splitAt;
  right.trimStart = (clip.trimStart || 0) + splitAt;
  clip.duration = splitAt;
  state.clips.splice(index + 1, 0, right);
  state.selectedId = right.id;
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast("再生位置でクリップを分割しました");
}

function deleteSelected() {
  const selected = selectedItem();
  if (!selected) return showToast("削除する項目を選んでください");
  pushHistory();
  const list = selected.track === "video" ? state.clips : selected.track === "text" ? state.texts : state.audios;
  list.splice(list.findIndex((item) => item.id === selected.item.id), 1);
  state.selectedId = null;
  normalizeTimeline();
  renderAll();
  queueSave();
  showToast("選択した項目を削除しました");
}

function jumpToBoundary(direction) {
  const points = [0, state.duration, ...state.clips.flatMap((clip) => [clip.start, clip.start + clip.duration])].sort((a, b) => a - b);
  const target = direction < 0 ? [...points].reverse().find((point) => point < state.time - .05) : points.find((point) => point > state.time + .05);
  setCurrentTime(target ?? (direction < 0 ? 0 : state.duration));
}

function reorderClip(dragId, clientX) {
  const fromIndex = state.clips.findIndex((item) => item.id === dragId);
  if (fromIndex < 0) return;
  const rect = $("#videoTrack").getBoundingClientRect();
  const targetTime = clamp((clientX - rect.left) / rect.width, 0, 1) * state.duration;
  let targetIndex = state.clips.findIndex((item) => targetTime < item.start + item.duration / 2);
  if (targetIndex < 0) targetIndex = state.clips.length;
  pushHistory();
  const [moved] = state.clips.splice(fromIndex, 1);
  if (targetIndex > fromIndex) targetIndex -= 1;
  state.clips.splice(targetIndex, 0, moved);
  normalizeTimeline();
  renderAll();
  queueSave();
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
  $("#volumeControl").addEventListener("input", (event) => mutateSelected((item) => {
    item.volume = Number(event.target.value) / 100;
    $("#volumeValue").textContent = `${event.target.value}%`;
    updateMediaPlayback();
  }));
  $("#textContent").addEventListener("input", (event) => mutateSelected((item, track) => {
    if (track !== "text") return;
    item.text = event.target.value;
    item.name = event.target.value.split("\n")[0] || "テキスト";
  }, true));
  $("#textColor").addEventListener("input", (event) => mutateSelected((item) => { item.color = event.target.value; }));
  $("#fontSize").addEventListener("input", (event) => mutateSelected((item) => { item.fontSize = clamp(Number(event.target.value), 16, 160); }));
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
    const transaction = db.transaction("assets", "readwrite");
    transaction.objectStore("assets").put({ id: asset.id, file: asset.file });
  } catch (_) {}
}

async function saveProject() {
  try {
    localStorage.setItem("hani-cut-project-name", $("#projectName").value);
    const db = await openDatabase();
    const transaction = db.transaction("projects", "readwrite");
    transaction.objectStore("projects").put({ id: "current", templateVersion: 2, ...projectSnapshot() });
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

async function loadSavedProject() {
  try {
    const name = localStorage.getItem("hani-cut-project-name");
    if (name) $("#projectName").value = name;
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
  if (audioGraph) return audioGraph;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const audioContext = new AudioContextClass();
  const destination = audioContext.createMediaStreamDestination();
  audioGraph = { context: audioContext, destination };
  assets.forEach((asset) => connectAssetAudio(asset));
  await audioContext.resume();
  return audioGraph;
}

function connectAssetAudio(asset) {
  if (!audioGraph || !asset.element || !["video", "audio"].includes(asset.kind) || asset.gainNode) return;
  try {
    const source = audioGraph.context.createMediaElementSource(asset.element);
    const gain = audioGraph.context.createGain();
    source.connect(gain);
    gain.connect(audioGraph.context.destination);
    gain.connect(audioGraph.destination);
    asset.gainNode = gain;
    asset.element.volume = 1;
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
    assets.forEach((asset) => connectAssetAudio(asset));
    setCanvasSize(resolution);
    const canvasStream = canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks(), ...(graph ? graph.destination.stream.getAudioTracks() : [])];
    const stream = new MediaStream(tracks);
    const mimeType = supportedRecorderType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: resolution >= 1080 ? 10_000_000 : 5_000_000 } : undefined);
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
  $("#playButton").addEventListener("click", togglePlayback);
  $("#previousButton").addEventListener("click", () => jumpToBoundary(-1));
  $("#nextButton").addEventListener("click", () => jumpToBoundary(1));
  $("#splitButton").addEventListener("click", splitSelected);
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
  const videoTrack = $("#videoTrack");
  videoTrack.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = draggedClipId ? "move" : "copy"; });
  videoTrack.addEventListener("drop", (event) => {
    event.preventDefault();
    const clipId = event.dataTransfer.getData("text/hani-clip");
    const assetId = event.dataTransfer.getData("text/hani-asset");
    if (clipId) reorderClip(clipId, event.clientX);
    else if (assetId) addAssetToTimeline(assetId);
  });
  $("#audioTrack").addEventListener("dragover", (event) => event.preventDefault());
  $("#audioTrack").addEventListener("drop", (event) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("text/hani-asset");
    if (assets.get(assetId)?.kind === "audio") addAssetToTimeline(assetId);
  });

  $("#snapButton").addEventListener("click", (event) => {
    const active = event.currentTarget.classList.toggle("is-active");
    event.currentTarget.setAttribute("aria-pressed", String(active));
    showToast(active ? "スナップをオンにしました" : "スナップをオフにしました");
  });
  $("#addTrackButton").addEventListener("click", () => showToast("映像・テキスト・音声の3トラックを使用できます"));

  const timelineZoom = $("#timelineZoom");
  timelineZoom.addEventListener("input", () => { state.timelineZoom = Number(timelineZoom.value); renderTimeline(); });
  $("#timelineZoomOut").addEventListener("click", () => { timelineZoom.value = clamp(Number(timelineZoom.value) - 20, 60, 180); timelineZoom.dispatchEvent(new Event("input")); });
  $("#timelineZoomIn").addEventListener("click", () => { timelineZoom.value = clamp(Number(timelineZoom.value) + 20, 60, 180); timelineZoom.dispatchEvent(new Event("input")); });
  const applyStageZoom = () => { $("#previewCanvas").style.transform = `scale(${state.stageZoom / 66})`; $("#zoomLabel").textContent = `${state.stageZoom}%`; };
  $("#zoomOut").addEventListener("click", () => { state.stageZoom = clamp(state.stageZoom - 10, 36, 96); applyStageZoom(); });
  $("#zoomIn").addEventListener("click", () => { state.stageZoom = clamp(state.stageZoom + 10, 36, 96); applyStageZoom(); });

  $("#exportButton").addEventListener("click", () => { $("#exportModal").hidden = false; });
  $$('[data-close-modal]').forEach((element) => element.addEventListener("click", () => { if (!state.exporting) $("#exportModal").hidden = true; }));
  $("#startExportButton").addEventListener("click", startExport);

  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (event.code === "Space" && !typing) { event.preventDefault(); togglePlayback(); }
    if ((event.key === "Delete" || event.key === "Backspace") && !typing) deleteSelected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
  });

  setupInspectorControls();
}

setCanvasSize(720);
setupEvents();
renderAll();
loadSavedProject();
