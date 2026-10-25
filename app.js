"use strict";

(function () {
  const STORAGE = "darkwave-studio-draft-v1";
  const LIBRARY = "darkwave-studio-projects-v1";
  const STEP_COUNT = 64;
  const CELL_WIDTH = 24;
  const CELL_HEIGHT = 19;
  const TOP_NOTE = 72;
  const NOTE_ROWS = 28;
  const COLORS = ["#b99bff", "#ffd98e", "#77ebeb", "#ff92bc", "#9aaeff", "#d0a0ff", "#ffb381", "#7fe2a2"];
  const TRACKS = [
    { name: "Lead dos Sonhos", type: "lead", glyph: "✦", description: "Synth lead", gain: .17 },
    { name: "Teclas Encantadas", type: "keys", glyph: "♢", description: "Piano retrô", gain: .17 },
    { name: "Sinos de Cristal", type: "bell", glyph: "✧", description: "Bells", gain: .12 },
    { name: "Baixo Profundo", type: "bass", glyph: "◈", description: "Bass synth", gain: .18 },
    { name: "Névoa Estelar", type: "pad", glyph: "☾", description: "Ambient pad", gain: .13 },
    { name: "Arpejo Mágico", type: "pluck", glyph: "♫", description: "Arpeggiator", gain: .13 },
    { name: "Coração / Kick", type: "kick", glyph: "♥", description: "Percussão grave", gain: .35 },
    { name: "Estalos / Hat", type: "hat", glyph: "▣", description: "Percussão aguda", gain: .16 }
  ];

  const $ = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const notesName = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const noteLabel = (midi) => notesName[midi % 12] + (Math.floor(midi / 12) - 1);
  const isBlack = (midi) => [1, 3, 6, 8, 10].includes(midi % 12);
  const fresh = () => ({
    version: 1, title: "Minha Nova Trilha", bpm: 132, swing: 0, volume: 74,
    tracks: TRACKS.map(() => ({ notes: [], muted: false, solo: false }))
  });
  let song = fresh();
  let selected = 0;
  let noteDuration = 2;
  let undoStack = [];
  let audioCtx = null;
  let audioMaster = null;
  let playing = false;
  let playStep = 0;
  let heardStep = 0;
  let nextStepTime = 0;
  let schedulerId = null;
  let frameId = null;
  let scheduled = [];
  let savedTimer = null;
  let toastTimer = null;
  let uploadedAudio = null;
  let uploadedName = "";
  let previewUrl = null;
  let previewAudio = null;
  let drawing = false;
  let drawMode = "add";
  let lastPainted = "";
  const canvas = $("roll");
  const cx = canvas.getContext("2d");
  canvas.width = STEP_COUNT * CELL_WIDTH;
  canvas.height = NOTE_ROWS * CELL_HEIGHT;

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3500);
  }

  function validateProject(data) {
    if (!data || !Array.isArray(data.tracks) || data.tracks.length !== TRACKS.length) {
      throw new Error("Formato incompatível: esperado um projeto com 8 faixas.");
    }
    const parsed = fresh();
    parsed.title = String(data.title || "Música importada").slice(0, 55);
    parsed.bpm = clamp(Number(data.bpm) || 132, 50, 240);
    parsed.swing = clamp(Number(data.swing) || 0, 0, 45);
    parsed.volume = clamp(Number(data.volume) || 74, 0, 100);
    parsed.tracks = data.tracks.map((track) => {
      const rawNotes = Array.isArray(track.notes) ? track.notes.slice(0, 2048) : [];
      return {
        muted: !!track.muted,
        solo: !!track.solo,
        notes: rawNotes.filter((n) => Number.isFinite(n.s) && Number.isFinite(n.p) && Number.isFinite(n.d))
          .map((n) => ({ s: clamp(Math.round(n.s), 0, 63), p: clamp(Math.round(n.p), 45, 72), d: clamp(Math.round(n.d), 1, 16), v: .85 }))
      };
    });
    return parsed;
  }

  function remember() {
    undoStack.push(clone(song));
    if (undoStack.length > 45) undoStack.shift();
  }

  function persist() {
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE, JSON.stringify(song)); }
      catch (err) { toast("Armazenamento cheio. Baixe uma cópia do projeto."); }
    }, 200);
  }

  function commitChange() { persist(); drawRoll(); renderTracks(); }
  function replaceSong(next, message) {
    stop();
    remember();
    song = validateProject(next);
    selected = 0;
    syncForm();
    renderTracks();
    renderPiano();
    drawRoll();
    persist();
    if (message) toast(message);
  }

  function syncForm() {
    $("songName").value = song.title;
    $("bpm").value = song.bpm;
    $("swing").value = song.swing;
    $("swingVal").textContent = song.swing + "%";
    $("masterVolume").value = song.volume;
    $("volumeVal").textContent = song.volume + "%";
    $("noteLength").value = String(noteDuration);
    if (audioMaster) audioMaster.gain.setTargetAtTime(song.volume / 100 * .65, audioCtx.currentTime, .04);
  }

  function renderTracks() {
    const list = $("trackList");
    list.replaceChildren();
    $("trackCount").textContent = String(TRACKS.length).padStart(2, "0");
    TRACKS.forEach((config, i) => {
      const node = document.createElement("div");
      node.className = "track-item" + (selected === i ? " selected" : "");
      node.setAttribute("data-track", String(i));
      const badge = document.createElement("span");
      badge.className = "track-badge";
      badge.style.color = COLORS[i];
      badge.textContent = config.glyph;
      const meta = document.createElement("div");
      meta.className = "track-meta";
      const title = document.createElement("strong");
      title.textContent = config.name;
      const subtitle = document.createElement("small");
      subtitle.textContent = config.description + " · " + song.tracks[i].notes.length + " notas";
      meta.append(title, subtitle);
      const mute = document.createElement("button");
      mute.className = "track-tool" + (song.tracks[i].muted ? " on" : "");
      mute.textContent = "M";
      mute.title = "Silenciar";
      mute.setAttribute("data-action", "mute");
      mute.setAttribute("aria-label", "Silenciar faixa " + config.name);
      const solo = document.createElement("button");
      solo.className = "track-tool" + (song.tracks[i].solo ? " on" : "");
      solo.textContent = "S";
      solo.title = "Ouvir somente esta faixa";
      solo.setAttribute("data-action", "solo");
      solo.setAttribute("aria-label", "Solo da faixa " + config.name);
      node.append(badge, meta, mute, solo);
      list.appendChild(node);
    });
    $("editorTrack").textContent = TRACKS[selected].name;
    $("editorTrack").style.color = COLORS[selected];
  }

  function renderPiano() {
    const keys = $("pianoKeys");
    keys.replaceChildren();
    for (let r = 0; r < NOTE_ROWS; r++) {
      const pitch = TOP_NOTE - r;
      const key = document.createElement("div");
      key.className = "piano-key" + (isBlack(pitch) ? " dark" : "") + (pitch % 12 === 0 ? " c-note" : "");
      key.textContent = noteLabel(pitch);
      key.setAttribute("data-pitch", String(pitch));
      key.title = "Ouvir " + noteLabel(pitch);
      keys.appendChild(key);
    }
    $("ruler").replaceChildren();
    for (let i = 0; i < STEP_COUNT / 16; i++) {
      const bar = document.createElement("span");
      bar.textContent = "COMPASSO " + String(i + 1).padStart(2, "0");
      $("ruler").appendChild(bar);
    }
  }

  function drawRoll() {
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.fillStyle = "#141021";
    cx.fillRect(0, 0, canvas.width, canvas.height);
    for (let row = 0; row < NOTE_ROWS; row++) {
      const p = TOP_NOTE - row;
      const y = row * CELL_HEIGHT;
      cx.fillStyle = isBlack(p) ? "#1d172c" : (p % 12 === 0 ? "#21192f" : "#161224");
      cx.fillRect(0, y, canvas.width, CELL_HEIGHT);
      cx.fillStyle = "#2d263a";
      cx.fillRect(0, y + CELL_HEIGHT - 1, canvas.width, 1);
    }
    for (let s = 0; s <= STEP_COUNT; s++) {
      cx.fillStyle = s % 16 === 0 ? "#7d5594" : s % 4 === 0 ? "#50405f" : "#2e263e";
      cx.fillRect(s * CELL_WIDTH, 0, s % 16 === 0 ? 2 : 1, canvas.height);
    }
    const entries = song.tracks[selected].notes;
    const color = COLORS[selected];
    entries.forEach((n) => {
      const x = n.s * CELL_WIDTH + 2;
      const y = (TOP_NOTE - n.p) * CELL_HEIGHT + 2;
      const w = Math.min(n.d, STEP_COUNT - n.s) * CELL_WIDTH - 4;
      cx.fillStyle = "#00000055";
      cx.fillRect(x + 2, y + 3, w, CELL_HEIGHT - 4);
      cx.fillStyle = color;
      cx.fillRect(x, y, w, CELL_HEIGHT - 5);
      cx.fillStyle = "#ffffff66";
      cx.fillRect(x + 2, y + 2, Math.max(2, w - 4), 2);
      cx.fillStyle = "#00000028";
      cx.fillRect(x + w - 5, y + 4, 2, CELL_HEIGHT - 12);
    });
    if (playing || heardStep !== 0) {
      const x = heardStep * CELL_WIDTH;
      cx.fillStyle = "#73ffdd24";
      cx.fillRect(x, 0, CELL_WIDTH, canvas.height);
      cx.fillStyle = "#77ffe0";
      cx.fillRect(x, 0, 2, canvas.height);
    }
  }

  function gridCell(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * canvas.width;
    const y = (e.clientY - rect.top) / rect.height * canvas.height;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
    return { s: Math.floor(x / CELL_WIDTH), p: TOP_NOTE - Math.floor(y / CELL_HEIGHT) };
  }

  function paint(e, first) {
    const cell = gridCell(e);
    if (!cell) return;
    const key = cell.s + ":" + cell.p;
    if (lastPainted === key) return;
    lastPainted = key;
    const notes = song.tracks[selected].notes;
    const existing = notes.findIndex((n) => n.s === cell.s && n.p === cell.p);
    if (first) {
      drawMode = e.button === 2 || e.altKey || existing !== -1 ? "erase" : "add";
      remember();
    }
    if (drawMode === "erase" && existing !== -1) notes.splice(existing, 1);
    else if (drawMode === "add" && existing === -1) {
      notes.push({ s: cell.s, p: cell.p, d: Math.min(noteDuration, STEP_COUNT - cell.s), v: .85 });
      audition(selected, cell.p, .19);
    }
    commitChange();
  }

  function initGridInteractions() {
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      drawing = true;
      lastPainted = "";
      canvas.setPointerCapture(e.pointerId);
      paint(e, true);
    });
    canvas.addEventListener("pointermove", (e) => { if (drawing) paint(e, false); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => canvas.addEventListener(eventName, () => {
      drawing = false;
      lastPainted = "";
    }));
    $("pianoKeys").addEventListener("click", (e) => {
      const key = e.target.closest("[data-pitch]");
      if (key) audition(selected, Number(key.dataset.pitch), .25);
    });
    $("trackList").addEventListener("click", (e) => {
      const track = e.target.closest("[data-track]");
      if (!track) return;
      const i = Number(track.dataset.track);
      const action = e.target.getAttribute("data-action");
      if (action) {
        remember();
        if (action === "mute") song.tracks[i].muted = !song.tracks[i].muted;
        else song.tracks[i].solo = !song.tracks[i].solo;
        persist();
      } else selected = i;
      renderTracks();
      drawRoll();
    });
  }

  function getContext() {
    if (!audioCtx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error("Este navegador não suporta Web Audio.");
      audioCtx = new Context();
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      comp.attack.value = .004;
      comp.release.value = .17;
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = song.volume / 100 * .65;
      audioMaster.connect(comp);
      comp.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function freq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function tone(ctx, out, type, midi, t, duration, gain) {
    duration = Math.max(.055, duration);
    if (type === "kick") {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(145, t);
      o.frequency.exponentialRampToValueAtTime(42, t + .18);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(.001, t + .24);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + .25);
      return;
    }
    if (type === "hat") {
      const length = Math.floor(ctx.sampleRate * .12);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), env = ctx.createGain();
      src.buffer = buffer;
      filter.type = "highpass"; filter.frequency.value = 5900;
      env.gain.setValueAtTime(gain, t);
      env.gain.exponentialRampToValueAtTime(.001, t + .115);
      src.connect(filter); filter.connect(env); env.connect(out); src.start(t); src.stop(t + .12);
      return;
    }
    const envelope = ctx.createGain();
    const f = freq(type === "bass" ? midi - 12 : midi);
    const attack = type === "pad" ? .075 : .006;
    const decay = type === "bell" ? Math.min(duration + .45, 1.7) : type === "pluck" ? Math.min(duration + .2, 1.1) : duration + .12;
    const end = t + Math.max(decay, .12);
    envelope.gain.setValueAtTime(.0001, t);
    envelope.gain.linearRampToValueAtTime(gain, t + attack);
    if (type === "pad") {
      envelope.gain.setValueAtTime(gain * .7, t + Math.max(attack, duration - .08));
      envelope.gain.exponentialRampToValueAtTime(.0001, end + .28);
    } else {
      const hold = (type === "bell" || type === "pluck") ? t + attack : t + Math.max(attack + .01, duration * .8);
      envelope.gain.setValueAtTime(type === "bell" ? gain * .7 : gain * .9, hold);
      envelope.gain.exponentialRampToValueAtTime(.0001, end);
    }
    envelope.connect(out);
    const osc = ctx.createOscillator();
    osc.type = type === "lead" ? "square" : type === "bass" ? "sawtooth" : type === "pluck" ? "triangle" : "sine";
    osc.frequency.setValueAtTime(f, t);
    if (type === "lead") osc.frequency.linearRampToValueAtTime(f * 1.002, t + .08);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = type === "bass" ? 950 : type === "lead" ? 3300 : 8000;
    osc.connect(filter); filter.connect(envelope);
    osc.start(t); osc.stop(end + (type === "pad" ? .3 : .02));
    if (type === "bell" || type === "keys" || type === "pad") {
      const layer = ctx.createOscillator();
      const layerGain = ctx.createGain();
      layer.type = type === "keys" ? "triangle" : "sine";
      layer.frequency.value = f * (type === "bell" ? 2.01 : type === "pad" ? 1.004 : 2);
      layerGain.gain.value = type === "bell" ? .3 : .17;
      layer.connect(layerGain); layerGain.connect(envelope);
      layer.start(t); layer.stop(end + (type === "pad" ? .3 : .02));
    }
  }

  function audible(i) {
    const hasSolo = song.tracks.some((t) => t.solo);
    return !song.tracks[i].muted && (!hasSolo || song.tracks[i].solo);
  }

  function audition(track, pitch, length) {
    try {
      const ctx = getContext();
      if (audible(track)) tone(ctx, audioMaster, TRACKS[track].type, pitch, ctx.currentTime + .007, length, TRACKS[track].gain * .8);
    } catch (err) { toast(err.message); }
  }

  function stepSeconds() { return 60 / song.bpm / 4; }
  function scheduleStep(step, time) {
    song.tracks.forEach((track, i) => {
      if (!audible(i)) return;
      track.notes.forEach((n) => {
        if (n.s === step) tone(audioCtx, audioMaster, TRACKS[i].type, n.p, time, n.d * stepSeconds() * .92, TRACKS[i].gain);
      });
    });
    scheduled.push({ step: step, time: time });
    if (scheduled.length > 120) scheduled.shift();
  }

  function tick() {
    if (!playing || !audioCtx) return;
    while (nextStepTime < audioCtx.currentTime + .16) {
      const shift = playStep % 2 ? song.swing / 100 * stepSeconds() : 0;
      scheduleStep(playStep, nextStepTime + shift);
      nextStepTime += stepSeconds();
      playStep = (playStep + 1) % STEP_COUNT;
    }
  }

  function renderPlayhead() {
    if (!playing) return;
    while (scheduled.length > 1 && scheduled[1].time <= audioCtx.currentTime) scheduled.shift();
    if (scheduled.length && scheduled[0].time <= audioCtx.currentTime) {
      if (heardStep !== scheduled[0].step) {
        heardStep = scheduled[0].step;
        updatePosition();
        drawRoll();
        if (heardStep % 16 === 0) {
          const viewport = $("rollScroll");
          const x = heardStep * CELL_WIDTH;
          if (x < viewport.scrollLeft || x + 130 > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = Math.max(0, x - 25);
        }
      }
    }
    frameId = requestAnimationFrame(renderPlayhead);
  }

  function updatePosition() {
    $("position").textContent = String(Math.floor(heardStep / 16) + 1).padStart(2, "0") + " : " + String(Math.floor((heardStep % 16) / 4) + 1).padStart(2, "0") + " : " + String(heardStep % 4 + 1).padStart(2, "0");
    Array.from($("beatMeter").children).forEach((bar, i) => bar.classList.toggle("lit", playing && i === Math.floor((heardStep % 16) / 4)));
  }

  function start() {
    try { getContext(); } catch (err) { toast(err.message); return; }
    if (playing) return;
    playing = true;
    audioMaster.gain.setTargetAtTime(song.volume / 100 * .65, audioCtx.currentTime, .02);
    nextStepTime = audioCtx.currentTime + .04;
    scheduled = [];
    $("playBtn").textContent = "Ⅱ";
    $("playBtn").setAttribute("aria-label", "Pausar");
    $("transportTitle").textContent = "REPRODUZINDO ✦";
    $("transportSub").textContent = song.title;
    schedulerId = setInterval(tick, 25);
    tick();
    frameId = requestAnimationFrame(renderPlayhead);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    clearInterval(schedulerId);
    cancelAnimationFrame(frameId);
    playStep = heardStep;
    scheduled = [];
    if (audioCtx) {
      audioMaster.gain.setTargetAtTime(.0001, audioCtx.currentTime, .012);
      setTimeout(() => { if (!playing && audioCtx && audioCtx.state === "running") audioMaster.gain.setValueAtTime(.0001, audioCtx.currentTime); }, 60);
    }
    $("playBtn").textContent = "▶";
    $("playBtn").setAttribute("aria-label", "Reproduzir");
    $("transportTitle").textContent = "PAUSADO";
    updatePosition();
    drawRoll();
  }

  function stop() {
    pause();
    playStep = 0; heardStep = 0;
    $("transportTitle").textContent = "PRONTO PARA CRIAR";
    $("transportSub").textContent = "Dê play ou edite as notas na grade.";
    updatePosition(); drawRoll();
  }

  function togglePlay() { playing ? pause() : start(); }

  function toWav(channels, sampleRate) {
    const len = channels[0].length;
    const channelCount = channels.length;
    const raw = new ArrayBuffer(44 + len * channelCount * 2);
    const view = new DataView(raw);
    function textAt(i, value) { for (let n = 0; n < value.length; n++) view.setUint8(i + n, value.charCodeAt(n)); }
    textAt(0, "RIFF"); view.setUint32(4, raw.byteLength - 8, true); textAt(8, "WAVE");
    textAt(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channelCount * 2, true); view.setUint16(32, channelCount * 2, true);
    view.setUint16(34, 16, true); textAt(36, "data"); view.setUint32(40, len * channelCount * 2, true);
    let offset = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < channelCount; c++) {
      const x = clamp(channels[c][i], -1, 1);
      view.setInt16(offset, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      offset += 2;
    }
    return new Blob([raw], { type: "audio/wav" });
  }

  function download(blob, fileName) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function safeFilename(title) {
    return String(title).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 70) || "trilha";
  }

  async function exportWav() {
    const button = $("wavBtn");
    button.disabled = true; button.textContent = "✦ RENDERIZANDO...";
    try {
      const sampleRate = 44100;
      const length = Math.ceil((STEP_COUNT * stepSeconds() + 2) * sampleRate);
      const offline = new OfflineAudioContext(2, length, sampleRate);
      const master = offline.createGain();
      master.gain.value = song.volume / 100 * .65;
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6;
      master.connect(comp); comp.connect(offline.destination);
      song.tracks.forEach((track, i) => {
        if (!audible(i)) return;
        track.notes.forEach((n) => {
          const shift = n.s % 2 ? song.swing / 100 * stepSeconds() : 0;
          tone(offline, master, TRACKS[i].type, n.p, n.s * stepSeconds() + .01 + shift, n.d * stepSeconds() * .92, TRACKS[i].gain);
        });
      });
      const buffer = await offline.startRendering();
      download(toWav([buffer.getChannelData(0), buffer.getChannelData(1)], sampleRate), safeFilename(song.title) + ".wav");
      toast("Trilha WAV exportada! ✦");
    } catch (err) { toast("Erro ao exportar WAV: " + err.message); }
    finally { button.disabled = false; button.textContent = "↓ EXPORTAR WAV"; }
  }

  function exportProject() {
    download(new Blob([JSON.stringify(song, null, 2)], { type: "application/json" }), safeFilename(song.title) + ".darkwave.json");
    toast("Arquivo do projeto baixado.");
  }

  function readLibrary() {
    try { const data = JSON.parse(localStorage.getItem(LIBRARY) || "[]"); return Array.isArray(data) ? data : []; }
    catch (err) { return []; }
  }

  function saveLibrary() {
    song.title = $("songName").value.trim() || "Trilha Sem Nome";
    const list = readLibrary();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.unshift({ id: id, saved: new Date().toISOString(), project: clone(song) });
    try {
      localStorage.setItem(LIBRARY, JSON.stringify(list.slice(0, 30)));
      persist(); renderLibrary(); toast("Projeto salvo no seu estúdio! ✦");
    } catch (err) { toast("Memória cheia. Use BAIXAR PROJETO para guardar o arquivo."); }
  }

  function renderLibrary() {
    const root = $("libraryGrid");
    root.replaceChildren();
    const list = readLibrary();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty-library";
      empty.innerHTML = "<span>✧</span><h3>Seu arquivo está esperando pela primeira melodia.</h3><p>Salve uma música no Estúdio para vê-la aqui!</p>";
      root.appendChild(empty); return;
    }
    list.forEach((item) => {
      const card = document.createElement("article");
      card.className = "panel song-card";
      const art = document.createElement("div"); art.className = "song-art"; art.textContent = "♫";
      const title = document.createElement("h3"); title.textContent = item.project.title;
      const date = document.createElement("p");
      date.textContent = new Date(item.saved).toLocaleString("pt-BR") + " · " + item.project.bpm + " BPM";
      const row = document.createElement("div"); row.className = "song-card-actions";
      const load = document.createElement("button"); load.textContent = "▶ ABRIR";
      load.addEventListener("click", () => { replaceSong(item.project, "Música carregada."); switchPage("studio"); });
      const file = document.createElement("button"); file.textContent = "↓ JSON";
      file.addEventListener("click", () => download(new Blob([JSON.stringify(item.project, null, 2)], { type: "application/json" }), safeFilename(item.project.title) + ".darkwave.json"));
      const del = document.createElement("button"); del.textContent = "✕"; del.title = "Excluir salvamento"; del.className = "danger";
      del.addEventListener("click", () => {
        if (!confirm("Excluir o salvamento \"" + item.project.title + "\"?")) return;
        localStorage.setItem(LIBRARY, JSON.stringify(readLibrary().filter((x) => x.id !== item.id)));
        renderLibrary(); toast("Salvamento removido.");
      });
      row.append(load, file, del); card.append(art, title, date, row); root.appendChild(card);
    });
  }

  function switchPage(name) {
    document.querySelectorAll(".page").forEach((e) => e.classList.toggle("active", e.id === "page-" + name));
    document.querySelectorAll(".nav-btn").forEach((e) => e.classList.toggle("active", e.dataset.page === name));
    if (name === "library") renderLibrary();
    if (name === "studio") drawRoll();
  }

  function addNotes(track, pitches, steps, duration) {
    steps.forEach((step, i) => {
      song.tracks[track].notes.push({ s: step, p: pitches[i % pitches.length], d: duration, v: .85 });
    });
  }

  function chord(track, step, pitches, duration) {
    pitches.forEach((pitch) => song.tracks[track].notes.push({ s: step, p: pitch, d: duration, v: .85 }));
  }

  function makePreset(kind) {
    song = fresh();
    if (kind === "empty") { song.title = "Minha Nova Trilha"; return clone(song); }
    if (kind === "battle") {
      song.title = "Coração Valente"; song.bpm = 166;
      addNotes(0, [64, 67, 71, 69, 67, 64, 62, 64, 67, 71, 72, 71, 69, 67, 64, 62], Array.from({ length: 16 }, (_, i) => i * 4), 2);
      [0, 16, 32, 48].forEach((s, i) => chord(1, s, [[52, 55, 59], [53, 57, 60], [55, 59, 62], [52, 57, 59]][i], 8));
      addNotes(3, [52, 52, 53, 53, 55, 55, 52, 52], Array.from({ length: 8 }, (_, i) => i * 8), 4);
      addNotes(5, [64, 71, 67, 71, 65, 72, 69, 72, 67, 71, 62, 71, 64, 71, 67, 71], Array.from({ length: 16 }, (_, i) => i * 4 + 2), 2);
      addNotes(6, [48], Array.from({ length: 16 }, (_, i) => i * 4), 1);
      addNotes(7, [62], Array.from({ length: 32 }, (_, i) => i * 2), 1);
      addNotes(2, [72, 69, 71, 72], [12, 28, 44, 60], 3);
    } else if (kind === "mystery") {
      song.title = "O Segredo da Floresta"; song.bpm = 92;
      addNotes(0, [60, 63, 67, 66, 63, 60, 58, 60, 62, 65, 69, 67, 65, 62], [0, 4, 8, 14, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60], 3);
      [0, 16, 32, 48].forEach((s, i) => chord(4, s, [[48, 51, 55], [46, 50, 53], [50, 53, 57], [48, 51, 55]][i], 15));
      addNotes(3, [48, 46, 50, 48], [0, 16, 32, 48], 12);
      addNotes(2, [72, 70, 67, 70, 69, 66], [6, 18, 29, 38, 50, 62], 4);
      addNotes(5, [55, 58, 60, 55, 53, 58, 62, 55], [2, 10, 18, 26, 34, 42, 50, 58], 2);
    } else {
      song.title = "Um Novo Começo"; song.bpm = 132;
      addNotes(0, [64, 67, 69, 67, 71, 69, 67, 64, 62, 64, 67, 71, 69, 67, 64, 60], Array.from({ length: 16 }, (_, i) => i * 4), 3);
      [0, 16, 32, 48].forEach((s, i) => chord(1, s, [[52, 55, 59], [53, 57, 60], [55, 59, 62], [52, 55, 59]][i], 12));
      addNotes(3, [52, 52, 53, 53, 55, 55, 52, 52], Array.from({ length: 8 }, (_, i) => i * 8), 7);
      [0, 16, 32, 48].forEach((s, i) => chord(4, s, [[52, 55, 59], [53, 57, 60], [55, 59, 62], [52, 55, 59]][i], 15));
      addNotes(2, [72, 71, 69, 72, 71, 67, 69, 72], [3, 11, 19, 27, 35, 43, 51, 59], 2);
      addNotes(5, [64, 67, 71, 67, 65, 69, 72, 69, 67, 71, 72, 71, 64, 67, 71, 67], Array.from({ length: 16 }, (_, i) => i * 4 + 2), 1);
      addNotes(6, [48], Array.from({ length: 8 }, (_, i) => i * 8), 1);
      addNotes(7, [60], Array.from({ length: 16 }, (_, i) => i * 4 + 2), 1);
    }
    return clone(song);
  }

  async function chooseAudio(file) {
    if (!file) return;
    if (file.size > 45 * 1024 * 1024) { toast("Use um arquivo de até 45 MB."); return; }
    try {
      $("fileInfo").hidden = false;
      $("fileInfo").textContent = "Lendo áudio: " + file.name + "...";
      const ctx = getContext();
      const data = await file.arrayBuffer();
      uploadedAudio = await ctx.decodeAudioData(data);
      uploadedName = file.name;
      $("fileInfo").textContent = "♫ " + file.name + " · " + uploadedAudio.duration.toFixed(1) + " s · " + uploadedAudio.sampleRate + " Hz";
      toast("Áudio carregado! Ajuste os efeitos.");
    } catch (err) {
      uploadedAudio = null; toast("Não foi possível ler este formato de áudio.");
      $("fileInfo").hidden = true;
    }
  }

  function retroAudio() {
    if (!uploadedAudio) throw new Error("Escolha um arquivo de áudio primeiro.");
    const bits = Number($("bits").value);
    const factor = Number($("downsample").value);
    const len = Math.min(uploadedAudio.length, Math.floor(uploadedAudio.sampleRate * 180));
    const channels = [];
    const level = Math.pow(2, bits - 1) - 1;
    for (let c = 0; c < Math.min(uploadedAudio.numberOfChannels, 2); c++) {
      const src = uploadedAudio.getChannelData(c);
      const out = new Float32Array(len);
      let held = 0, filtered = 0;
      for (let i = 0; i < len; i++) {
        if (i % factor === 0) {
          filtered = filtered * .25 + src[i] * .75;
          held = Math.round(clamp(filtered, -1, 1) * level) / level;
        }
        out[i] = held * .92;
      }
      channels.push(out);
    }
    return toWav(channels, uploadedAudio.sampleRate);
  }

  async function listenRetro() {
    try {
      if (previewAudio) { previewAudio.pause(); previewAudio = null; }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(retroAudio());
      previewAudio = new Audio(previewUrl);
      await previewAudio.play();
      toast("Ouvindo a versão retrô...");
    } catch (err) { toast(err.message); }
  }

  async function extractMelody() {
    if (!uploadedAudio) { toast("Escolha um áudio primeiro."); return; }
    const button = $("extractBtn");
    button.disabled = true; button.textContent = "♫ ANALISANDO...";
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rate = uploadedAudio.sampleRate;
      const src = uploadedAudio.getChannelData(0);
      const stepTime = stepSeconds();
      const melody = [];
      let lastPitch = -1;
      for (let step = 0; step < STEP_COUNT; step++) {
        const center = Math.floor((step + .27) * stepTime * rate);
        if (center + 3000 >= src.length) break;
        const windowSize = 1250, targetRate = 11025;
        const ratio = rate / targetRate;
        const wave = new Float32Array(windowSize);
        let rms = 0;
        for (let i = 0; i < windowSize; i++) {
          wave[i] = src[Math.floor(center + i * ratio)] || 0;
          rms += wave[i] * wave[i];
        }
        rms = Math.sqrt(rms / windowSize);
        if (rms < .018) { lastPitch = -1; continue; }
        let bestLag = 0, bestScore = 0;
        for (let lag = 15; lag < 145; lag++) {
          let ab = 0, aa = 0, bb = 0;
          for (let i = 0; i < 950; i += 2) {
            const a = wave[i], b = wave[i + lag];
            ab += a * b; aa += a * a; bb += b * b;
          }
          const score = ab / Math.sqrt(aa * bb + 1e-12);
          if (score > bestScore) { bestScore = score; bestLag = lag; }
        }
        if (bestScore < .75 || !bestLag) { lastPitch = -1; continue; }
        const pitch = Math.round(69 + 12 * Math.log2(targetRate / bestLag / 440));
        if (pitch < 45 || pitch > 72) { lastPitch = -1; continue; }
        if (pitch === lastPitch && melody.length && melody[melody.length - 1].s + melody[melody.length - 1].d === step) {
          melody[melody.length - 1].d++;
        } else melody.push({ s: step, p: pitch, d: 1, v: .85 });
        lastPitch = pitch;
      }
      if (!melody.length) { toast("Não encontrei notas claras. Experimente uma gravação de melodia solo."); return; }
      if (song.tracks[selected].notes.length && !confirm("Substituir as notas da faixa selecionada pela melodia detectada?")) return;
      remember();
      song.tracks[selected].notes = melody;
      commitChange();
      switchPage("studio");
      toast(melody.length + " notas sugeridas. Revise a melodia no piano roll.");
    } catch (err) { toast("Não foi possível extrair a melodia: " + err.message); }
    finally { button.disabled = false; button.textContent = "♫ EXTRAIR MELODIA (BETA)"; }
  }

  function initControls() {
    document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchPage(b.dataset.page)));
    $("playBtn").addEventListener("click", togglePlay);
    $("stopBtn").addEventListener("click", stop);
    $("bpm").addEventListener("change", (e) => {
      song.bpm = clamp(parseInt(e.target.value, 10) || 132, 50, 240);
      e.target.value = song.bpm; persist();
    });
    $("bpmMinus").addEventListener("click", () => { $("bpm").value = clamp(song.bpm - 1, 50, 240); $("bpm").dispatchEvent(new Event("change")); });
    $("bpmPlus").addEventListener("click", () => { $("bpm").value = clamp(song.bpm + 1, 50, 240); $("bpm").dispatchEvent(new Event("change")); });
    $("swing").addEventListener("input", (e) => { song.swing = Number(e.target.value); $("swingVal").textContent = song.swing + "%"; persist(); });
    $("masterVolume").addEventListener("input", (e) => { song.volume = Number(e.target.value); $("volumeVal").textContent = song.volume + "%"; if (audioMaster) audioMaster.gain.setTargetAtTime(song.volume / 100 * .65, audioCtx.currentTime, .03); persist(); });
    $("songName").addEventListener("input", (e) => { song.title = e.target.value; persist(); });
    $("noteLength").addEventListener("change", (e) => { noteDuration = Number(e.target.value); });
    $("undoBtn").addEventListener("click", undo);
    $("clearTrackBtn").addEventListener("click", () => {
      if (!song.tracks[selected].notes.length) return;
      if (!confirm("Apagar todas as notas desta faixa?")) return;
      remember(); song.tracks[selected].notes = []; commitChange(); toast("Faixa limpa.");
    });
    $("resetBtn").addEventListener("click", () => {
      if (confirm("Criar uma nova música? O rascunho atual será substituído. Salve antes se quiser guardá-lo.")) replaceSong(fresh(), "Novo projeto criado.");
    });
    $("demoBtn").addEventListener("click", () => {
      if (confirm("Carregar a música de exemplo original? O rascunho atual será substituído.")) replaceSong(makePreset("dream"), "Exemplo original carregado.");
    });
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      if (confirm("Carregar esta atmosfera? O rascunho atual será substituído.")) replaceSong(makePreset(b.dataset.preset), "Atmosfera carregada. ✦");
    }));
    $("wavBtn").addEventListener("click", exportWav);
    $("exportJsonBtn").addEventListener("click", exportProject);
    $("saveBtn").addEventListener("click", saveLibrary);
    $("saveProjectBtn").addEventListener("click", saveLibrary);
    $("newSongBtn").addEventListener("click", () => { replaceSong(fresh(), "Novo projeto criado."); switchPage("studio"); });
    $("importProjectBtn").addEventListener("click", () => $("projectFile").click());
    $("projectFile").addEventListener("change", async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const loaded = validateProject(JSON.parse(await file.text()));
        replaceSong(loaded, "Projeto importado com sucesso!");
        switchPage("studio");
      } catch (err) { toast("Erro ao importar: " + err.message); }
      e.target.value = "";
    });
    $("selectAudioBtn").addEventListener("click", () => $("audioFile").click());
    $("audioFile").addEventListener("change", (e) => chooseAudio(e.target.files[0]));
    const drop = $("dropArea");
    ["dragenter", "dragover"].forEach((eventName) => drop.addEventListener(eventName, (e) => { e.preventDefault(); drop.classList.add("dragging"); }));
    ["dragleave", "drop"].forEach((eventName) => drop.addEventListener(eventName, (e) => { e.preventDefault(); drop.classList.remove("dragging"); }));
    drop.addEventListener("drop", (e) => chooseAudio(e.dataTransfer.files[0]));
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter") $("audioFile").click(); });
    $("bits").addEventListener("input", (e) => { $("bitsValue").textContent = e.target.value + " BIT"; });
    $("downsample").addEventListener("input", (e) => { $("rateValue").textContent = e.target.value + "×"; });
    $("convertBtn").addEventListener("click", () => {
      try { download(retroAudio(), safeFilename(uploadedName.replace(/\.[^.]+$/, "")) + "_retro.wav"); toast("Versão retrô exportada!"); }
      catch (err) { toast(err.message); }
    });
    $("listenConvertedBtn").addEventListener("click", listenRetro);
    $("extractBtn").addEventListener("click", extractMelody);
    document.addEventListener("keydown", (e) => {
      const editable = e.target.closest("input,select,textarea,button");
      if (e.code === "Space" && !editable) { e.preventDefault(); togglePlay(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveLibrary(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !editable) { e.preventDefault(); undo(); }
      if (!editable && /^[1-8]$/.test(e.key) && !e.ctrlKey) {
        selected = Number(e.key) - 1; renderTracks(); drawRoll();
      }
    });
  }

  function undo() {
    if (!undoStack.length) { toast("Não há alterações para desfazer."); return; }
    stop(); song = undoStack.pop(); syncForm(); renderTracks(); drawRoll(); persist(); toast("Alteração desfeita.");
  }

  function init() {
    try {
      const draft = localStorage.getItem(STORAGE);
      song = draft ? validateProject(JSON.parse(draft)) : makePreset("dream");
    } catch (err) { song = makePreset("dream"); }
    syncForm(); renderPiano(); renderTracks(); drawRoll(); initGridInteractions(); initControls();
    updatePosition();
  }

  init();
})();