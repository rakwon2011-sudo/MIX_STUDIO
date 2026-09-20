// MIX STUDIO — client-side audio mixing tool
// All processing happens in the browser via the Web Audio API. No server, no upload of files anywhere.

(() => {
  'use strict';

  const state = {
    tracks: [],       // { id, type:'audio'|'beat', name, buffer, start, end, volume, fadeIn, fadeOut, crossfadeAfter, bpm, beatTimes }
    audioCtx: null,
    activeSources: [],
    videoFile: null,
    trackPreviewSource: null,
    trackPreviewBtn: null,
    clipboard: null, // { name, type, buffer, start, end, volume, fadeIn, fadeOut, crossfadeAfter, bpm, beatTimes }
  };

  let nextId = 1;

  // ---------- DOM ----------
  const fileInput = document.getElementById('fileInput');
  const videoInput = document.getElementById('videoInput');
  const videoSection = document.getElementById('videoSection');
  const videoPreview = document.getElementById('videoPreview');
  const syncVideoToggle = document.getElementById('syncVideoToggle');
  const playBtn = document.getElementById('playBtn');
  const stopBtn = document.getElementById('stopBtn');
  const exportBtn = document.getElementById('exportBtn');
  const statusEl = document.getElementById('status');
  const trackList = document.getElementById('trackList');
  const emptyState = document.getElementById('emptyState');
  const trackTemplate = document.getElementById('trackTemplate');
  const progressOverlay = document.getElementById('progressOverlay');
  const progressText = document.getElementById('progressText');
  const beatBpmInput = document.getElementById('beatBpm');
  const beatBarsInput = document.getElementById('beatBars');
  const timelineTrackEl = document.getElementById('timelineTrack');
  const pasteEndBtn = document.getElementById('pasteEndBtn');
  const exportProjectBtn = document.getElementById('exportProjectBtn');
  const importProjectInput = document.getElementById('importProjectInput');
  const timelinePlayBtn = document.getElementById('timelinePlayBtn');
  const timelineStopBtn = document.getElementById('timelineStopBtn');
  const PX_PER_SEC = 40;

  function setStatus(msg) { statusEl.textContent = msg || ''; }
  function showProgress(msg) { progressText.textContent = msg; progressOverlay.classList.remove('hidden'); }
  function hideProgress() { progressOverlay.classList.add('hidden'); }

  // m:ss.d 형식으로 시간을 표시 (파형 위 마우스 커서 툴팁용)
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  }

  function getAudioCtx() {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return state.audioCtx;
  }

  function updateEmptyState() {
    emptyState.style.display = state.tracks.length === 0 ? 'block' : 'none';
    const hasTracks = state.tracks.length > 0;
    playBtn.disabled = !hasTracks;
    timelinePlayBtn.disabled = !hasTracks;
    exportBtn.disabled = !hasTracks;
    exportProjectBtn.disabled = !hasTracks;
  }

  // ---------- File upload ----------
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      await addAudioFile(file);
    }
    fileInput.value = '';
  });

  videoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.videoFile = file;
    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    videoSection.classList.remove('hidden');
  });

  async function addAudioFile(file) {
    showProgress(`${file.name} 불러오는 중...`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = getAudioCtx();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const track = {
        id: nextId++,
        type: 'audio',
        name: file.name,
        buffer: audioBuffer,
        fileData: arrayBuffer,
        fileType: file.type,
        start: 0,
        end: audioBuffer.duration,
        volume: 100,
        fadeIn: 0,
        fadeOut: 0,
        crossfadeAfter: 2,
        bpm: null,
        beatTimes: [],
      };
      state.tracks.push(track);
      renderTrack(track);
      updateEmptyState();
      renderTimeline();
      markDirty();
      setStatus(`${file.name} 추가됨`);
      detectBpm(track);
    } catch (err) {
      console.error(err);
      setStatus(`${file.name} 불러오기 실패: ${err.message}`);
    } finally {
      hideProgress();
    }
  }

  // ---------- BPM detection ----------
  async function detectBpm(track) {
    const row = trackList.querySelector(`[data-id="${track.id}"]`);
    const bpmEl = row?.querySelector('.track-bpm');
    try {
      const mod = await import('https://esm.sh/web-audio-beat-detector@8');
      // Widen the default 90-180 BPM search range so slower/faster tracks are still detected.
      const result = await mod.guess(track.buffer, undefined, undefined, { minTempo: 60, maxTempo: 200 });
      track.bpm = result.bpm;
      track.beatOffset = result.offset || 0;
      const interval = 60 / track.bpm;
      const beats = [];
      for (let t = track.beatOffset; t < track.buffer.duration; t += interval) {
        beats.push(t);
      }
      // also fill backwards from offset in case offset > 0
      for (let t = track.beatOffset - interval; t >= 0; t -= interval) {
        beats.unshift(t);
      }
      track.beatTimes = beats;
      if (bpmEl) bpmEl.textContent = `BPM ${track.bpm.toFixed(1)}`;
    } catch (err) {
      console.warn('BPM detection failed', err);
      track.bpm = null;
      track.beatTimes = [];
      if (bpmEl) bpmEl.textContent = 'BPM 감지 실패 (수동 조정 가능)';
    }
    markDirty();
  }

  // ---------- Beat library (synthesized loops, no external files) ----------
  const beatButtons = document.querySelectorAll('.beat-add');
  beatButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const bpm = parseFloat(beatBpmInput.value) || 120;
      const bars = parseInt(beatBarsInput.value, 10) || 8;
      const type = btn.dataset.beat;
      const track = synthesizeBeat(type, bpm, bars);
      track.beatType = type;
      track.beatBpm = bpm;
      track.beatBars = bars;
      state.tracks.push(track);
      renderTrack(track);
      updateEmptyState();
      renderTimeline();
      markDirty();
      setStatus(`${track.name} 추가됨`);
    });
  });

  function synthesizeBeat(type, bpm, bars) {
    const ctx = getAudioCtx();
    const beatsPerBar = 4;
    const totalBeats = bars * beatsPerBar;
    const secPerBeat = 60 / bpm;
    const duration = totalBeats * secPerBeat + 0.5;
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(2, Math.ceil(duration * sampleRate), sampleRate);

    const writeKick = (data, startSample) => {
      const len = Math.floor(sampleRate * 0.15);
      for (let i = 0; i < len && startSample + i < data.length; i++) {
        const t = i / sampleRate;
        const freq = 150 * Math.exp(-t * 25) + 40;
        const env = Math.exp(-t * 18);
        data[startSample + i] += Math.sin(2 * Math.PI * freq * t) * env * 0.9;
      }
    };
    const writeHat = (data, startSample) => {
      const len = Math.floor(sampleRate * 0.05);
      for (let i = 0; i < len && startSample + i < data.length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 90);
        data[startSample + i] += (Math.random() * 2 - 1) * env * 0.35;
      }
    };
    const writeClap = (data, startSample) => {
      const len = Math.floor(sampleRate * 0.12);
      for (let i = 0; i < len && startSample + i < data.length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 22) * (0.6 + 0.4 * Math.sin(t * 90));
        data[startSample + i] += (Math.random() * 2 - 1) * env * 0.6;
      }
    };

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let beat = 0; beat < totalBeats; beat++) {
        const startSample = Math.floor(beat * secPerBeat * sampleRate);
        const beatInBar = beat % beatsPerBar;
        if (type === 'fourFloor') {
          writeKick(data, startSample);
        } else if (type === 'hihat') {
          writeHat(data, startSample);
          if (beatInBar % 2 === 0) writeHat(data, startSample + Math.floor(secPerBeat * sampleRate / 2));
        } else if (type === 'clap') {
          if (beatInBar === 1 || beatInBar === 3) writeClap(data, startSample);
        } else if (type === 'full') {
          writeKick(data, startSample);
          writeHat(data, startSample);
          writeHat(data, startSample + Math.floor(secPerBeat * sampleRate / 2));
          if (beatInBar === 1 || beatInBar === 3) writeClap(data, startSample);
        }
      }
    }

    const labelMap = {
      fourFloor: '4-on-the-floor 킥',
      hihat: '하이햇 그루브',
      clap: '클랩 스네어',
      full: '풀비트',
    };

    const interval = 60 / bpm;
    const beatTimes = [];
    for (let t = 0; t < duration; t += interval) beatTimes.push(t);

    return {
      id: nextId++,
      type: 'beat',
      name: `[비트] ${labelMap[type]} ${bpm}BPM`,
      buffer,
      start: 0,
      end: duration,
      volume: 100,
      fadeIn: 0,
      fadeOut: 0,
      crossfadeAfter: 0,
      bpm,
      beatTimes,
    };
  }

  // ---------- Render track row ----------
  function renderTrack(track) {
    const node = trackTemplate.content.cloneNode(true);
    const row = node.querySelector('.track-row');
    row.dataset.id = track.id;

    const nameInput = row.querySelector('.track-name');
    nameInput.value = track.name;
    nameInput.addEventListener('input', () => { track.name = nameInput.value; renderTimeline(); markDirty(); });
    row.querySelector('.track-bpm').textContent = track.bpm ? `BPM ${track.bpm.toFixed(1)}` : 'BPM 분석 중...';

    const canvas = row.querySelector('.waveform');
    drawWaveform(canvas, track.buffer);

    const startInput = row.querySelector('.in-start');
    const endInput = row.querySelector('.in-end');
    startInput.value = track.start.toFixed(2);
    endInput.value = track.end.toFixed(2);
    startInput.max = track.buffer.duration.toFixed(2);
    endInput.max = track.buffer.duration.toFixed(2);

    const fadeInInput = row.querySelector('.in-fadein');
    const fadeOutInput = row.querySelector('.in-fadeout');
    const volumeInput = row.querySelector('.in-volume');
    const volumeValue = row.querySelector('.volume-value');
    const crossfadeInput = row.querySelector('.in-crossfade');
    crossfadeInput.value = track.crossfadeAfter;

    const handleStart = row.querySelector('.handle-start');
    const handleEnd = row.querySelector('.handle-end');
    const dimLeft = row.querySelector('.region-dim-left');
    const dimRight = row.querySelector('.region-dim-right');
    const wrap = row.querySelector('.waveform-wrap');

    // 마우스를 파형 위에 올리면 세로선 커서 + 시간 표시가 따라다님
    const waveCursor = document.createElement('div');
    waveCursor.className = 'wave-cursor';
    const waveCursorLabel = document.createElement('div');
    waveCursorLabel.className = 'wave-cursor-time';
    wrap.appendChild(waveCursor);
    wrap.appendChild(waveCursorLabel);

    // 이 곡이 재생될 때 실제 재생 위치를 보여주는 선 (미리듣기 진행 상황 표시용)
    const wavePlayhead = document.createElement('div');
    wavePlayhead.className = 'wave-playhead';
    wrap.appendChild(wavePlayhead);

    wrap.addEventListener('mousemove', (e) => {
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < 0 || x > rect.width) return;
      const t = (x / rect.width) * track.buffer.duration;
      waveCursor.style.left = x + 'px';
      waveCursor.style.display = 'block';
      waveCursorLabel.style.left = x + 'px';
      waveCursorLabel.textContent = formatTime(t);
      waveCursorLabel.style.display = 'block';
    });
    wrap.addEventListener('mouseleave', () => {
      waveCursor.style.display = 'none';
      waveCursorLabel.style.display = 'none';
    });

    // 파형 위 아무 지점이나 클릭하면 그 지점부터 바로 들어볼 수 있음 (핸들 드래그는 제외)
    [handleStart, handleEnd].forEach((h) => {
      h.addEventListener('click', (e) => e.stopPropagation());
    });
    wrap.addEventListener('click', (e) => {
      if (e.target === handleStart || e.target === handleEnd) return;
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = (x / rect.width) * track.buffer.duration;
      playFromOffset(track, t);
    });

    function positionHandles() {
      const width = wrap.clientWidth;
      const dur = track.buffer.duration;
      const xStart = (track.start / dur) * width;
      const xEnd = (track.end / dur) * width;
      handleStart.style.left = xStart + 'px';
      handleEnd.style.left = xEnd + 'px';
      dimLeft.style.left = '0px';
      dimLeft.style.width = xStart + 'px';
      dimRight.style.left = xEnd + 'px';
      dimRight.style.width = (width - xEnd) + 'px';
    }

    function setStart(val) {
      val = Math.max(0, Math.min(val, track.end - 0.05));
      track.start = val;
      startInput.value = val.toFixed(2);
      positionHandles();
      renderTimeline();
      markDirty();
    }
    function setEnd(val) {
      val = Math.min(track.buffer.duration, Math.max(val, track.start + 0.05));
      track.end = val;
      endInput.value = val.toFixed(2);
      positionHandles();
      renderTimeline();
      markDirty();
    }

    startInput.addEventListener('input', () => setStart(parseFloat(startInput.value) || 0));
    endInput.addEventListener('input', () => setEnd(parseFloat(endInput.value) || track.buffer.duration));
    fadeInInput.addEventListener('input', () => { track.fadeIn = parseFloat(fadeInInput.value) || 0; markDirty(); });
    fadeOutInput.addEventListener('input', () => { track.fadeOut = parseFloat(fadeOutInput.value) || 0; markDirty(); });
    volumeInput.addEventListener('input', () => {
      track.volume = parseFloat(volumeInput.value);
      volumeValue.textContent = track.volume + '%';
      markDirty();
    });
    crossfadeInput.addEventListener('input', () => {
      track.crossfadeAfter = Math.max(0, parseFloat(crossfadeInput.value) || 0);
      renderTimeline();
      markDirty();
    });

    row.querySelector('.snap-start').addEventListener('click', () => {
      setStart(nearestBeat(track, track.start));
    });
    row.querySelector('.snap-end').addEventListener('click', () => {
      setEnd(nearestBeat(track, track.end));
    });

    // Drag logic for handles
    function makeDraggable(handle, isStart) {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
          const rect = wrap.getBoundingClientRect();
          const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
          const t = (x / rect.width) * track.buffer.duration;
          if (isStart) setStart(t); else setEnd(t);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
    makeDraggable(handleStart, true);
    makeDraggable(handleEnd, false);

    row.querySelector('.btn-remove').addEventListener('click', () => {
      state.tracks = state.tracks.filter(t => t.id !== track.id);
      row.remove();
      updateEmptyState();
      renumberTracks();
      renderTimeline();
      markDirty();
    });

    row.querySelector('.move-up').addEventListener('click', () => moveTrack(track.id, -1));
    row.querySelector('.move-down').addEventListener('click', () => moveTrack(track.id, 1));
    row.querySelector('.btn-duplicate').addEventListener('click', () => duplicateTrack(track));

    row.querySelector('.btn-copy').addEventListener('click', () => {
      state.clipboard = {
        name: track.name,
        type: track.type,
        buffer: track.buffer,
        start: track.start,
        end: track.end,
        volume: track.volume,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
        crossfadeAfter: track.crossfadeAfter,
        bpm: track.bpm,
        beatOffset: track.beatOffset,
        beatTimes: track.beatTimes,
        fileData: track.fileData,
        fileType: track.fileType,
        beatType: track.beatType,
        beatBpm: track.beatBpm,
        beatBars: track.beatBars,
      };
      refreshPasteButtons();
      setStatus(`${track.name} 구간 (${(track.end - track.start).toFixed(1)}초) 복사됨 — 원하는 곡 옆 "붙여넣기"를 누르세요`);
    });

    const pasteBtn = row.querySelector('.btn-paste');
    pasteBtn.addEventListener('click', () => {
      if (!state.clipboard) return;
      const idx = state.tracks.findIndex(t => t.id === track.id);
      pasteClipboardAt(idx + 1);
    });

    const playTrackBtn = row.querySelector('.btn-play-track');
    playTrackBtn.addEventListener('click', async () => {
      if (state.trackPreviewBtn === playTrackBtn) {
        stopTrackPreview();
        return;
      }
      await playFromOffset(track, track.start);
    });

    trackList.appendChild(row);
    requestAnimationFrame(positionHandles);
    window.addEventListener('resize', positionHandles);

    renumberTracks();
  }

  function nearestBeat(track, t) {
    if (!track.beatTimes || track.beatTimes.length === 0) return t;
    let best = track.beatTimes[0];
    let bestDiff = Math.abs(t - best);
    for (const bt of track.beatTimes) {
      const d = Math.abs(t - bt);
      if (d < bestDiff) { bestDiff = d; best = bt; }
    }
    return best;
  }

  function renumberTracks() {
    const rows = Array.from(trackList.children);
    rows.forEach((row, i) => {
      row.querySelector('.track-index').textContent = `#${i + 1}`;
      const isLast = i === rows.length - 1;
      row.querySelector('.crossfade-label').style.display = isLast ? 'none' : '';
    });
  }

  function moveTrack(id, dir) {
    const idx = state.tracks.findIndex(t => t.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= state.tracks.length) return;
    const [t] = state.tracks.splice(idx, 1);
    state.tracks.splice(newIdx, 0, t);
    reorderTrackListDom();
    renderTimeline();
    markDirty();
  }

  function reorderTrackListDom() {
    const rows = {};
    Array.from(trackList.children).forEach(row => { rows[row.dataset.id] = row; });
    trackList.innerHTML = '';
    state.tracks.forEach(tr => trackList.appendChild(rows[tr.id]));
    renumberTracks();
  }

  // Duplicate a track (same audio, same decoded buffer) so the user can cut a
  // different phrase/segment out of the same song without re-uploading the file.
  function duplicateTrack(track) {
    const idx = state.tracks.findIndex(t => t.id === track.id);
    const clipDur = track.end - track.start;
    let newStart = track.end;
    let newEnd = Math.min(track.buffer.duration, track.end + clipDur);
    if (newEnd - newStart < 0.1) { newStart = track.start; newEnd = track.end; }
    const newTrack = {
      ...track,
      id: nextId++,
      name: track.name,
      start: newStart,
      end: newEnd,
    };
    state.tracks.splice(idx + 1, 0, newTrack);
    renderTrack(newTrack);
    reorderTrackListDom();
    renderTimeline();
    markDirty();
    setStatus(`${track.name} 구간 복제됨 — 새 구간을 조정하세요`);
  }

  // ---------- Copy / paste a cut segment to another point in the timeline ----------
  function refreshPasteButtons() {
    const hasClip = !!state.clipboard;
    document.querySelectorAll('.btn-paste').forEach(btn => { btn.disabled = !hasClip; });
    pasteEndBtn.disabled = !hasClip;
  }

  function pasteClipboardAt(index) {
    const c = state.clipboard;
    if (!c) return;
    const newTrack = {
      id: nextId++,
      type: c.type,
      name: c.name,
      buffer: c.buffer,
      start: c.start,
      end: c.end,
      volume: c.volume,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      crossfadeAfter: c.crossfadeAfter,
      bpm: c.bpm,
      beatOffset: c.beatOffset,
      beatTimes: c.beatTimes || [],
      fileData: c.fileData,
      fileType: c.fileType,
      beatType: c.beatType,
      beatBpm: c.beatBpm,
      beatBars: c.beatBars,
    };
    state.tracks.splice(index, 0, newTrack);
    renderTrack(newTrack);
    reorderTrackListDom();
    updateEmptyState();
    renderTimeline();
    markDirty();
    setStatus(`${c.name} 구간이 붙여넣기됨`);
  }

  pasteEndBtn.addEventListener('click', () => pasteClipboardAt(state.tracks.length));

  // ---------- Waveform drawing ----------
  function drawWaveform(canvas, buffer) {
    const ctx2d = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    ctx2d.fillStyle = '#0b0d11';
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.strokeStyle = '#5ac8fa';
    ctx2d.beginPath();
    for (let x = 0; x < width; x++) {
      let min = 1.0, max = -1.0;
      const start = x * step;
      for (let i = 0; i < step && start + i < data.length; i++) {
        const v = data[start + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = ((1 + min) / 2) * height;
      const y2 = ((1 + max) / 2) * height;
      ctx2d.moveTo(x, y1);
      ctx2d.lineTo(x, y2);
    }
    ctx2d.stroke();
  }

  // Draws only the trimmed [startSec, endSec) region of a buffer, scaled to
  // fill the canvas — used for the small waveform drawn inside each timeline clip.
  function drawWaveformRegion(canvas, buffer, startSec, endSec) {
    const ctx2d = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.clearRect(0, 0, width, height);
    if (width <= 0) return;
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const startSample = Math.max(0, Math.floor(startSec * sr));
    const endSample = Math.min(data.length, Math.ceil(endSec * sr));
    const span = Math.max(1, endSample - startSample);
    const step = Math.max(1, Math.ceil(span / width));
    ctx2d.strokeStyle = 'rgba(7, 16, 24, 0.75)';
    ctx2d.beginPath();
    for (let x = 0; x < width; x++) {
      let min = 1.0, max = -1.0;
      const s = startSample + x * step;
      for (let i = 0; i < step && s + i < endSample; i++) {
        const v = data[s + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      const y1 = ((1 + min) / 2) * height;
      const y2 = ((1 + max) / 2) * height;
      ctx2d.moveTo(x, y1);
      ctx2d.lineTo(x, y2);
    }
    ctx2d.stroke();
  }

  // ---------- Timeline computation ----------
  function computeTimeline() {
    let cursor = 0;
    const items = [];
    for (let i = 0; i < state.tracks.length; i++) {
      const track = state.tracks[i];
      const clipDur = track.end - track.start;
      const item = {
        track,
        timelineStart: cursor,
        clipDuration: clipDur,
      };
      items.push(item);
      const crossfade = i < state.tracks.length - 1 ? Math.min(track.crossfadeAfter, clipDur) : 0;
      cursor = cursor + clipDur - crossfade;
    }
    const totalDuration = items.length
      ? items[items.length - 1].timelineStart + items[items.length - 1].clipDuration
      : 0;
    return { items, totalDuration };
  }

  // ---------- Timeline view (drag to reorder, drag handle to crossfade) ----------
  function trackColor(id) {
    const hue = (id * 67) % 360;
    return `hsl(${hue}, 62%, 55%)`;
  }

  // 타임라인 위에 마우스를 올리면 세로선 커서 + 시간 표시가 따라다님.
  // renderTimeline()이 innerHTML을 매번 비우므로, 커서 엘리먼트는 렌더링 끝에서
  // 다시 붙여주고, 이벤트 리스너는 컨테이너(고정 DOM 노드)에 한 번만 건다.
  const timelineCursor = document.createElement('div');
  timelineCursor.className = 'timeline-cursor';
  const timelineCursorLabel = document.createElement('div');
  timelineCursorLabel.className = 'timeline-cursor-label';

  // 재생 중 실제로 어디까지 진행됐는지 보여주는 선 (전체 타임라인을 가로지름)
  const timelinePlayhead = document.createElement('div');
  timelinePlayhead.className = 'timeline-playhead';

  function hideTimelineCursor() {
    timelineCursor.style.display = 'none';
    timelineCursorLabel.style.display = 'none';
  }

  if (timelineTrackEl) {
    timelineTrackEl.addEventListener('mousemove', (e) => {
      const { items } = computeTimeline();
      if (items.length === 0) return;
      const rect = timelineTrackEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < 0 || x > rect.width) { hideTimelineCursor(); return; }
      const t = x / PX_PER_SEC;
      timelineCursor.style.left = x + 'px';
      timelineCursor.style.display = 'block';
      timelineCursorLabel.style.left = x + 'px';
      timelineCursorLabel.textContent = formatTime(t);
      timelineCursorLabel.style.display = 'block';
    });
    timelineTrackEl.addEventListener('mouseleave', hideTimelineCursor);
  }

  function renderTimeline() {
    if (!timelineTrackEl) return;
    timelineTrackEl.innerHTML = '';
    const { items, totalDuration } = computeTimeline();
    if (items.length === 0) {
      timelineTrackEl.style.width = '100%';
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.textContent = '곡을 추가하면 여기에 타임라인이 표시됩니다.';
      timelineTrackEl.appendChild(empty);
      return;
    }
    const widthPx = Math.max(totalDuration * PX_PER_SEC, 200);
    timelineTrackEl.style.width = widthPx + 'px';

    items.forEach((item, i) => {
      const clip = document.createElement('div');
      clip.className = 'timeline-clip';
      clip.dataset.id = item.track.id;
      clip.style.left = (item.timelineStart * PX_PER_SEC) + 'px';
      clip.style.width = Math.max(item.clipDuration * PX_PER_SEC, 4) + 'px';
      clip.style.background = trackColor(item.track.id);

      const clipWidthPx = Math.max(Math.round(item.clipDuration * PX_PER_SEC), 4);
      const waveCanvas = document.createElement('canvas');
      waveCanvas.className = 'timeline-clip-wave';
      waveCanvas.width = clipWidthPx;
      waveCanvas.height = 52;
      clip.appendChild(waveCanvas);
      drawWaveformRegion(waveCanvas, item.track.buffer, item.track.start, item.track.end);

      const progressEl = document.createElement('div');
      progressEl.className = 'timeline-clip-progress';
      clip.appendChild(progressEl);

      const label = document.createElement('span');
      label.className = 'timeline-clip-label';
      label.textContent = `${item.track.name} (${item.clipDuration.toFixed(1)}s)`;
      clip.appendChild(label);

      timelineTrackEl.appendChild(clip);
      makeClipDraggable(clip, item.track);

      if (i < items.length - 1) {
        const nextItem = items[i + 1];
        const handle = document.createElement('div');
        handle.className = 'timeline-handle';
        handle.style.left = (nextItem.timelineStart * PX_PER_SEC) + 'px';
        handle.title = '드래그해서 크로스페이드 조정';
        timelineTrackEl.appendChild(handle);
        makeCrossfadeHandleDraggable(handle, item.track, item, nextItem);
      }
    });

    timelineTrackEl.appendChild(timelineCursor);
    timelineTrackEl.appendChild(timelineCursorLabel);
    timelineTrackEl.appendChild(timelinePlayhead);
  }

  // ---------- Playback progress indicator (playhead + played-shadow on clips) ----------
  let progressRafId = null;

  function stopProgressAnim() {
    if (progressRafId != null) cancelAnimationFrame(progressRafId);
    progressRafId = null;
  }

  // startCtxTime/duration는 AudioContext의 currentTime 기준(초). ctx.currentTime을
  // 매 프레임 폴링해서 실제 오디오 진행 상황과 어긋나지 않게 맞춘다.
  function startProgressAnim(ctx, startCtxTime, duration, onTick, onDone) {
    stopProgressAnim();
    const step = () => {
      const elapsed = ctx.currentTime - startCtxTime;
      if (elapsed >= duration) {
        onTick(duration);
        progressRafId = null;
        if (onDone) onDone();
        return;
      }
      onTick(Math.max(0, elapsed));
      progressRafId = requestAnimationFrame(step);
    };
    progressRafId = requestAnimationFrame(step);
  }

  function clearTimelineProgress() {
    timelinePlayhead.style.display = 'none';
    if (!timelineTrackEl) return;
    timelineTrackEl.querySelectorAll('.timeline-clip-progress').forEach(el => { el.style.width = '0%'; });
    timelineTrackEl.querySelectorAll('.timeline-clip.playing').forEach(el => el.classList.remove('playing'));
  }

  function clearAllRowPlayheads() {
    trackList.querySelectorAll('.wave-playhead').forEach(el => { el.style.display = 'none'; });
  }

  // 믹스 전체 재생 중: 타임라인을 가로지르는 선 + 각 클립이 재생된 만큼 그림자 채우기
  function updateTimelineProgressForItems(items, elapsed) {
    timelinePlayhead.style.display = 'block';
    timelinePlayhead.style.left = (elapsed * PX_PER_SEC) + 'px';
    items.forEach(item => {
      const clip = timelineTrackEl.querySelector(`.timeline-clip[data-id="${item.track.id}"]`);
      if (!clip) return;
      const progressEl = clip.querySelector('.timeline-clip-progress');
      const local = elapsed - item.timelineStart;
      let pct = 0;
      if (local <= 0) pct = 0;
      else if (local >= item.clipDuration) pct = 100;
      else pct = (local / item.clipDuration) * 100;
      if (progressEl) progressEl.style.width = pct + '%';
      clip.classList.toggle('playing', local > 0 && local < item.clipDuration);
    });
  }

  function setRowPlayhead(track, fraction, visible) {
    const wavePlayhead = trackList.querySelector(`[data-id="${track.id}"] .wave-playhead`);
    if (!wavePlayhead) return;
    if (!visible) { wavePlayhead.style.display = 'none'; return; }
    wavePlayhead.style.left = (Math.max(0, Math.min(1, fraction)) * 100) + '%';
    wavePlayhead.style.display = 'block';
  }

  function makeClipDraggable(clip, track) {
    clip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      clip.setPointerCapture(e.pointerId);
      clip.classList.add('dragging');
      const startClientX = e.clientX;
      const clipRect = clip.getBoundingClientRect();
      const clickOffsetX = e.clientX - clipRect.left;
      const snapshot = computeTimeline().items;
      let moved = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startClientX;
        if (Math.abs(dx) > 4) moved = true;
        clip.style.transform = `translateX(${dx}px)`;
      };
      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        clip.classList.remove('dragging');
        clip.style.transform = '';
        if (moved) {
          const rect = timelineTrackEl.getBoundingClientRect();
          const dropX = ev.clientX - rect.left;
          const others = snapshot.filter(it => it.track.id !== track.id);
          let targetIndex = others.length;
          for (let i = 0; i < others.length; i++) {
            const center = (others[i].timelineStart + others[i].clipDuration / 2) * PX_PER_SEC;
            if (dropX < center) { targetIndex = i; break; }
          }
          const curIdx = state.tracks.findIndex(t => t.id === track.id);
          if (curIdx !== -1) {
            const [t] = state.tracks.splice(curIdx, 1);
            state.tracks.splice(targetIndex, 0, t);
            reorderTrackListDom();
            markDirty();
          }
          renderTimeline();
        } else {
          // 드래그 없이 클릭만 한 경우: 클릭한 지점부터 바로 재생 + 해당 트랙 행 강조
          const ratio = clipRect.width > 0 ? clickOffsetX / clipRect.width : 0;
          const fromTime = track.start + ratio * (track.end - track.start);
          playFromOffset(track, fromTime);
          highlightTrackRow(track.id);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function makeCrossfadeHandleDraggable(handle, track, item, nextItem) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startCrossfade = track.crossfadeAfter || 0;
      const maxCrossfade = Math.min(item.clipDuration, nextItem.clipDuration);

      const onMove = (ev) => {
        const dxSec = (ev.clientX - startX) / PX_PER_SEC;
        let newVal = startCrossfade - dxSec; // drag left = more overlap, right = less
        newVal = Math.max(0, Math.min(maxCrossfade, newVal));
        track.crossfadeAfter = newVal;
        setStatus(`크로스페이드: ${newVal.toFixed(2)}초`);
        const row = trackList.querySelector(`[data-id="${track.id}"]`);
        const input = row?.querySelector('.in-crossfade');
        if (input) input.value = newVal.toFixed(2);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        renderTimeline();
        markDirty();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function highlightTrackRow(id) {
    const row = trackList.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlight');
    setTimeout(() => row.classList.remove('highlight'), 900);
  }

  // ---------- Scheduling helper (shared by preview + export) ----------
  function scheduleTrack(ctx, destination, item, when) {
    const { track, clipDuration } = item;
    const src = ctx.createBufferSource();
    src.buffer = track.buffer;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(destination);

    const vol = (track.volume ?? 100) / 100;
    const fadeIn = Math.min(track.fadeIn || 0, clipDuration / 2);
    const fadeOut = Math.min(track.fadeOut || 0, clipDuration / 2);

    const t0 = when;
    const t1 = when + clipDuration;

    gain.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, t0);
    if (fadeIn > 0) gain.gain.linearRampToValueAtTime(vol, t0 + fadeIn);
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(vol, Math.max(t0, t1 - fadeOut));
      gain.gain.linearRampToValueAtTime(0, t1);
    }

    src.start(when, track.start, clipDuration);
    return src;
  }

  // ---------- Preview playback ----------
  async function playMix() {
    const ctx = getAudioCtx();
    await ctx.resume();
    stopPreview();
    stopTrackPreview();
    const { items, totalDuration } = computeTimeline();
    if (items.length === 0) return;

    const baseTime = ctx.currentTime + 0.1;
    for (const item of items) {
      const src = scheduleTrack(ctx, ctx.destination, item, baseTime + item.timelineStart);
      state.activeSources.push(src);
    }

    if (syncVideoToggle.checked && state.videoFile) {
      videoPreview.currentTime = 0;
      videoPreview.play().catch(() => {});
    }

    playBtn.disabled = true;
    timelinePlayBtn.disabled = true;
    stopBtn.disabled = false;
    timelineStopBtn.disabled = false;
    setStatus(`재생 중... 총 ${totalDuration.toFixed(1)}초`);

    startProgressAnim(ctx, baseTime, totalDuration, (elapsed) => {
      updateTimelineProgressForItems(items, elapsed);
    }, () => {
      clearTimelineProgress();
    });

    const endTimer = setTimeout(() => {
      playBtn.disabled = false;
      timelinePlayBtn.disabled = false;
      stopBtn.disabled = true;
      timelineStopBtn.disabled = true;
      setStatus('재생 완료');
    }, totalDuration * 1000 + 200);
    state.activeSources.push({ stop: () => clearTimeout(endTimer) });
  }

  playBtn.addEventListener('click', playMix);
  timelinePlayBtn.addEventListener('click', playMix);
  stopBtn.addEventListener('click', stopPreview);
  timelineStopBtn.addEventListener('click', stopPreview);

  function stopPreview() {
    state.activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
    state.activeSources = [];
    videoPreview.pause();
    playBtn.disabled = state.tracks.length === 0;
    timelinePlayBtn.disabled = state.tracks.length === 0;
    stopBtn.disabled = true;
    timelineStopBtn.disabled = true;
    setStatus('정지됨');
    stopProgressAnim();
    clearTimelineProgress();
    clearAllRowPlayheads();
  }

  function stopTrackPreview() {
    if (state.trackPreviewSource) {
      clearTimeout(state.trackPreviewSource._endTimer);
      try { state.trackPreviewSource.stop(); } catch (e) {}
      state.trackPreviewSource = null;
    }
    if (state.trackPreviewBtn) {
      state.trackPreviewBtn.textContent = '▶';
      state.trackPreviewBtn.classList.remove('playing');
      state.trackPreviewBtn = null;
    }
    stopProgressAnim();
    clearTimelineProgress();
    clearAllRowPlayheads();
  }

  // 파형(트랙 편집 목록 + 타임라인) 아무 지점을 클릭했을 때 그 지점부터 재생.
  // fromTime이 트랙의 시작점(start)보다 뒤라면 "가운데부터 스크럽"으로 보고 페이드인은 생략.
  async function playFromOffset(track, fromTime) {
    const btn = trackList.querySelector(`[data-id="${track.id}"] .btn-play-track`);
    const ctx = getAudioCtx();
    await ctx.resume();
    stopPreview();
    stopTrackPreview();
    const startAt = Math.min(Math.max(fromTime, track.start), track.end - 0.05);
    const isSeek = startAt > track.start + 0.01;
    const clipDuration = track.end - startAt;
    const seeked = Object.assign({}, track, {
      start: startAt,
      fadeIn: isSeek ? 0 : track.fadeIn,
    });
    const item = { track: seeked, clipDuration };
    const startCtxTime = ctx.currentTime + 0.05;
    const src = scheduleTrack(ctx, ctx.destination, item, startCtxTime);
    state.trackPreviewSource = src;
    state.trackPreviewBtn = btn;
    if (btn) {
      btn.textContent = '■';
      btn.classList.add('playing');
    }
    setStatus(`${track.name} 미리듣기 중... (${formatTime(startAt)}부터)`);

    // 이 곡 하나만 미리듣는 중에도 파형 위 재생선 + 타임라인의 해당 클립 진행 표시를 함께 움직인다.
    const fullRange = Math.max(0.001, track.end - track.start);
    const seekOffset = startAt - track.start;
    const { items: fullItems } = computeTimeline();
    const matchedItem = fullItems.find(it => it.track.id === track.id);

    startProgressAnim(ctx, startCtxTime, clipDuration, (elapsed) => {
      const playedFraction = (seekOffset + elapsed) / fullRange;
      setRowPlayhead(track, playedFraction, true);
      if (matchedItem) {
        timelinePlayhead.style.display = 'block';
        timelinePlayhead.style.left = ((matchedItem.timelineStart + seekOffset + elapsed) * PX_PER_SEC) + 'px';
        const clip = timelineTrackEl.querySelector(`.timeline-clip[data-id="${track.id}"]`);
        if (clip) {
          const progressEl = clip.querySelector('.timeline-clip-progress');
          if (progressEl) progressEl.style.width = (Math.max(0, Math.min(1, playedFraction)) * 100) + '%';
          clip.classList.add('playing');
        }
      }
    }, () => {
      setRowPlayhead(track, 0, false);
      clearTimelineProgress();
    });

    const endTimer = setTimeout(() => {
      if (state.trackPreviewBtn === btn) stopTrackPreview();
    }, clipDuration * 1000 + 150);
    src._endTimer = endTimer;
  }

  // ---------- Export to WAV ----------
  exportBtn.addEventListener('click', async () => {
    const { items, totalDuration } = computeTimeline();
    if (items.length === 0) return;
    showProgress('믹스 렌더링 중...');
    try {
      const sampleRate = state.tracks[0].buffer.sampleRate;
      const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate) + sampleRate, sampleRate);
      for (const item of items) {
        scheduleTrack(offlineCtx, offlineCtx.destination, item, item.timelineStart);
      }
      const rendered = await offlineCtx.startRendering();
      const wavBlob = bufferToWavBlob(rendered);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mixtape.wav';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus('내보내기 완료: mixtape.wav 다운로드됨');
    } catch (err) {
      console.error(err);
      setStatus('내보내기 실패: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  function bufferToWavBlob(abuffer) {
    const numChannels = abuffer.numberOfChannels;
    const sampleRate = abuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const numFrames = abuffer.length;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const bufferSize = 44 + dataSize;
    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(abuffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  // ---------- Persistence (IndexedDB) ----------
  // Keeps uploaded songs and every edit (trim points, fades, volume, order,
  // crossfades) so a page refresh doesn't wipe out the work. Everything stays
  // in this browser only — nothing is uploaded anywhere.
  const DB_NAME = 'mixstudio-db';
  const STORE_NAME = 'tracks';
  let dbPromise = null;

  function openDb() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('저장 공간 열기 실패', req.error); resolve(null); };
    });
    return dbPromise;
  }

  let persistTimer = null;
  function markDirty() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistTracks, 500);
  }

  async function persistTracks() {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      state.tracks.forEach((track, order) => {
        store.put({
          id: track.id,
          order,
          type: track.type,
          name: track.name,
          start: track.start,
          end: track.end,
          volume: track.volume,
          fadeIn: track.fadeIn,
          fadeOut: track.fadeOut,
          crossfadeAfter: track.crossfadeAfter,
          bpm: track.bpm || null,
          beatOffset: track.beatOffset || 0,
          beatTimes: track.beatTimes || [],
          fileData: track.type === 'audio' ? track.fileData : null,
          fileType: track.type === 'audio' ? track.fileType : null,
          beatType: track.type === 'beat' ? track.beatType : null,
          beatBpm: track.type === 'beat' ? track.beatBpm : null,
          beatBars: track.type === 'beat' ? track.beatBars : null,
        });
      });
      await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    } catch (err) {
      console.warn('자동 저장 실패', err);
    }
  }

  async function loadPersistedTracks() {
    const db = await openDb();
    if (!db) return;
    let records = [];
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      records = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('이전 작업 불러오기 실패', err);
      return;
    }
    if (!records.length) return;
    records.sort((a, b) => a.order - b.order);
    showProgress('이전에 저장된 곡 불러오는 중...');
    const ctx = getAudioCtx();
    let loaded = 0;
    for (const rec of records) {
      try {
        let track;
        if (rec.type === 'audio' && rec.fileData) {
          const buffer = await ctx.decodeAudioData(rec.fileData.slice(0));
          track = {
            id: nextId++,
            type: 'audio',
            name: rec.name,
            buffer,
            fileData: rec.fileData,
            fileType: rec.fileType,
            start: rec.start,
            end: rec.end,
            volume: rec.volume,
            fadeIn: rec.fadeIn,
            fadeOut: rec.fadeOut,
            crossfadeAfter: rec.crossfadeAfter,
            bpm: rec.bpm,
            beatOffset: rec.beatOffset,
            beatTimes: rec.beatTimes || [],
          };
        } else if (rec.type === 'beat' && rec.beatType) {
          track = synthesizeBeat(rec.beatType, rec.beatBpm, rec.beatBars);
          track.beatType = rec.beatType;
          track.beatBpm = rec.beatBpm;
          track.beatBars = rec.beatBars;
          track.name = rec.name;
          track.start = rec.start;
          track.end = rec.end;
          track.volume = rec.volume;
          track.fadeIn = rec.fadeIn;
          track.fadeOut = rec.fadeOut;
          track.crossfadeAfter = rec.crossfadeAfter;
        } else {
          continue;
        }
        state.tracks.push(track);
        renderTrack(track);
        loaded++;
      } catch (err) {
        console.warn('트랙 복원 실패', rec.name, err);
      }
    }
    updateEmptyState();
    renderTimeline();
    hideProgress();
    if (loaded) setStatus(`이전에 저장된 곡 ${loaded}개를 불러왔습니다`);
  }

  // ---------- Project export / import (share the whole edit with a teammate) ----------
  // GitHub Pages has no server, so there's no live shared workspace. Instead, the
  // whole project (songs + every cut/fade/volume/order) is packed into one JSON
  // file (audio embedded as base64) that a teammate can open in their own copy
  // of MIX STUDIO to continue from the exact same state.
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  exportProjectBtn.addEventListener('click', async () => {
    if (state.tracks.length === 0) return;
    showProgress('프로젝트 파일 만드는 중...');
    try {
      const tracks = state.tracks.map(track => {
        const rec = {
          type: track.type,
          name: track.name,
          start: track.start,
          end: track.end,
          volume: track.volume,
          fadeIn: track.fadeIn,
          fadeOut: track.fadeOut,
          crossfadeAfter: track.crossfadeAfter,
          bpm: track.bpm || null,
          beatOffset: track.beatOffset || 0,
          beatTimes: track.beatTimes || [],
        };
        if (track.type === 'audio') {
          rec.fileType = track.fileType;
          rec.fileDataBase64 = arrayBufferToBase64(track.fileData);
        } else if (track.type === 'beat') {
          rec.beatType = track.beatType;
          rec.beatBpm = track.beatBpm;
          rec.beatBars = track.beatBars;
        }
        return rec;
      });
      const project = { formatVersion: 1, exportedAt: new Date().toISOString(), tracks };
      const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      a.download = `mixstudio-project-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus('프로젝트 파일 내보내기 완료 — 이 파일을 공유하면 됩니다');
    } catch (err) {
      console.error(err);
      setStatus('프로젝트 내보내기 실패: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  importProjectInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    importProjectInput.value = '';
    if (!file) return;
    showProgress('프로젝트 파일 불러오는 중...');
    try {
      const text = await file.text();
      const project = JSON.parse(text);
      if (!project || !Array.isArray(project.tracks)) throw new Error('올바른 프로젝트 파일이 아닙니다');

      const replace = state.tracks.length === 0 || confirm(
        '현재 작업 중인 곡들을 지우고 이 프로젝트로 교체할까요?\n' +
        '"취소"를 누르면 지금 목록 뒤에 이어서 추가됩니다.'
      );
      if (replace) {
        state.tracks = [];
        trackList.innerHTML = '';
      }

      const ctx = getAudioCtx();
      let loaded = 0;
      for (const rec of project.tracks) {
        let track;
        if (rec.type === 'audio' && rec.fileDataBase64) {
          const fileData = base64ToArrayBuffer(rec.fileDataBase64);
          const buffer = await ctx.decodeAudioData(fileData.slice(0));
          track = {
            id: nextId++,
            type: 'audio',
            name: rec.name,
            buffer,
            fileData,
            fileType: rec.fileType,
            start: rec.start,
            end: rec.end,
            volume: rec.volume,
            fadeIn: rec.fadeIn,
            fadeOut: rec.fadeOut,
            crossfadeAfter: rec.crossfadeAfter,
            bpm: rec.bpm,
            beatOffset: rec.beatOffset,
            beatTimes: rec.beatTimes || [],
          };
        } else if (rec.type === 'beat' && rec.beatType) {
          track = synthesizeBeat(rec.beatType, rec.beatBpm, rec.beatBars);
          track.beatType = rec.beatType;
          track.beatBpm = rec.beatBpm;
          track.beatBars = rec.beatBars;
          track.name = rec.name;
          track.start = rec.start;
          track.end = rec.end;
          track.volume = rec.volume;
          track.fadeIn = rec.fadeIn;
          track.fadeOut = rec.fadeOut;
          track.crossfadeAfter = rec.crossfadeAfter;
        } else {
          continue;
        }
        state.tracks.push(track);
        renderTrack(track);
        loaded++;
      }
      reorderTrackListDom();
      updateEmptyState();
      renderTimeline();
      markDirty();
      setStatus(`프로젝트에서 곡 ${loaded}개를 불러왔습니다`);
    } catch (err) {
      console.error(err);
      setStatus('프로젝트 불러오기 실패: ' + err.message);
    } finally {
      hideProgress();
    }
  });

  renderTimeline();
  setStatus('브라우저 안에서만 작동합니다. 파일은 어디로도 업로드되지 않습니다.');
  loadPersistedTracks();
})();
