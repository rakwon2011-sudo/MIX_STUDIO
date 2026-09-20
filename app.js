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
  const PX_PER_SEC = 40;

  function setStatus(msg) { statusEl.textContent = msg || ''; }
  function showProgress(msg) { progressText.textContent = msg; progressOverlay.classList.remove('hidden'); }
  function hideProgress() { progressOverlay.classList.add('hidden'); }

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
    exportBtn.disabled = !hasTracks;
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
  }

  // ---------- Beat library (synthesized loops, no external files) ----------
  const beatButtons = document.querySelectorAll('.beat-add');
  beatButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const bpm = parseFloat(beatBpmInput.value) || 120;
      const bars = parseInt(beatBarsInput.value, 10) || 8;
      const type = btn.dataset.beat;
      const track = synthesizeBeat(type, bpm, bars);
      state.tracks.push(track);
      renderTrack(track);
      updateEmptyState();
      renderTimeline();
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
    nameInput.addEventListener('input', () => { track.name = nameInput.value; renderTimeline(); });
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
    }
    function setEnd(val) {
      val = Math.min(track.buffer.duration, Math.max(val, track.start + 0.05));
      track.end = val;
      endInput.value = val.toFixed(2);
      positionHandles();
      renderTimeline();
    }

    startInput.addEventListener('input', () => setStart(parseFloat(startInput.value) || 0));
    endInput.addEventListener('input', () => setEnd(parseFloat(endInput.value) || track.buffer.duration));
    fadeInInput.addEventListener('input', () => { track.fadeIn = parseFloat(fadeInInput.value) || 0; });
    fadeOutInput.addEventListener('input', () => { track.fadeOut = parseFloat(fadeOutInput.value) || 0; });
    volumeInput.addEventListener('input', () => {
      track.volume = parseFloat(volumeInput.value);
      volumeValue.textContent = track.volume + '%';
    });
    crossfadeInput.addEventListener('input', () => {
      track.crossfadeAfter = Math.max(0, parseFloat(crossfadeInput.value) || 0);
      renderTimeline();
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
      const ctx = getAudioCtx();
      await ctx.resume();
      stopPreview();
      stopTrackPreview();
      const clipDuration = track.end - track.start;
      const item = { track, clipDuration };
      const src = scheduleTrack(ctx, ctx.destination, item, ctx.currentTime + 0.05);
      state.trackPreviewSource = src;
      state.trackPreviewBtn = playTrackBtn;
      playTrackBtn.textContent = '■';
      playTrackBtn.classList.add('playing');
      setStatus(`${track.name} 미리듣기 중...`);
      const endTimer = setTimeout(() => {
        if (state.trackPreviewBtn === playTrackBtn) stopTrackPreview();
      }, clipDuration * 1000 + 150);
      src._endTimer = endTimer;
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
    };
    state.tracks.splice(index, 0, newTrack);
    renderTrack(newTrack);
    reorderTrackListDom();
    updateEmptyState();
    renderTimeline();
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
      clip.textContent = `${item.track.name} (${item.clipDuration.toFixed(1)}s)`;
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
  }

  function makeClipDraggable(clip, track) {
    clip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      clip.setPointerCapture(e.pointerId);
      clip.classList.add('dragging');
      const startClientX = e.clientX;
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
          }
          renderTimeline();
        } else {
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
  playBtn.addEventListener('click', async () => {
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
    stopBtn.disabled = false;
    setStatus(`재생 중... 총 ${totalDuration.toFixed(1)}초`);

    const endTimer = setTimeout(() => {
      playBtn.disabled = false;
      stopBtn.disabled = true;
      setStatus('재생 완료');
    }, totalDuration * 1000 + 200);
    state.activeSources.push({ stop: () => clearTimeout(endTimer) });
  });

  stopBtn.addEventListener('click', stopPreview);

  function stopPreview() {
    state.activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
    state.activeSources = [];
    videoPreview.pause();
    playBtn.disabled = state.tracks.length === 0;
    stopBtn.disabled = true;
    setStatus('정지됨');
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

  renderTimeline();
  setStatus('브라우저 안에서만 작동합니다. 파일은 어디로도 업로드되지 않습니다.');
})();
