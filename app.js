// MIX STUDIO — client-side audio mixing tool
// All processing happens in the browser via the Web Audio API. No server, no upload of files anywhere.

(() => {
  'use strict';

  const state = {
    tracks: [],       // 소스 목록(파란 바): { id, type:'audio'|'beat', name, buffer, start, end, volume, fadeIn, fadeOut, crossfadeAfter, bpm, beatTimes }
    // 타임라인 시퀀스. 두 종류의 항목이 순서대로 섞여 들어간다:
    //  - { kind:'track', trackId }        : 곡 목록의 그 트랙을 그대로 가리킴 (트림은 목록 쪽에서 편집)
    //  - { kind:'clip', id, ...자체 필드 } : 목록에 카드로 안 보이는, 복사해서 붙여넣은 독립 구간
    //                                        (타임라인 위에서 직접 자르고 늘릴 수 있음)
    sequence: [],
    audioCtx: null,
    activeSources: [],
    videoFile: null,
    trackPreviewSource: null,
    trackPreviewBtn: null,
    clipboard: null, // { name, type, buffer, start, end, volume, fadeIn, fadeOut, crossfadeAfter, bpm, beatTimes }
    selectedTrackId: null, // Ctrl/Cmd+C, Ctrl/Cmd+V 대상 트랙
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
    const hasTimelineContent = state.sequence.length > 0;
    playBtn.disabled = !hasTimelineContent;
    timelinePlayBtn.disabled = !hasTimelineContent;
    exportBtn.disabled = !hasTimelineContent;
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
      state.sequence.push({ kind: 'track', trackId: track.id });
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
      state.sequence.push({ kind: 'track', trackId: track.id });
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

    // 이 곡이 재생될 때 이미 재생된 구간을 그림자로 채우고, 현재 위치에 선을 그어준다
    const waveProgress = document.createElement('div');
    waveProgress.className = 'wave-progress';
    wrap.appendChild(waveProgress);
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
      state.sequence = state.sequence.filter(e => !(e.kind === 'track' && e.trackId === track.id));
      row.remove();
      updateEmptyState();
      renumberTracks();
      renderTimeline();
      markDirty();
    });

    row.querySelector('.move-up').addEventListener('click', () => moveTrack(track.id, -1));
    row.querySelector('.move-down').addEventListener('click', () => moveTrack(track.id, 1));
    row.querySelector('.btn-duplicate').addEventListener('click', () => duplicateTrack(track));

    row.querySelector('.btn-copy').addEventListener('click', () => copyRegionToClipboard(track));

    // 행 배경(버튼·입력칸 제외)을 클릭하면 이 트랙이 "선택"됨 — Ctrl/Cmd+C, Ctrl/Cmd+V로
    // 키보드 단축키 복사/붙여넣기를 할 때 어느 트랙을 대상으로 할지 표시하는 용도.
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, input, .btn-move')) return;
      selectTrack(track.id);
    });

    const pasteBtn = row.querySelector('.btn-paste');
    pasteBtn.addEventListener('click', () => {
      if (!state.clipboard) return;
      const seqIdx = state.sequence.findIndex(e => e.kind === 'track' && e.trackId === track.id);
      pasteClipboardAt(seqIdx === -1 ? state.sequence.length : seqIdx + 1);
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
    // 곡 목록 순서(idx+1)와 똑같은 자리에 타임라인 시퀀스 항목도 추가 — 목록에 카드가 하나
    // 생기는 "복제"는 지금까지처럼 타임라인에도 그대로 나타난다 (원본 바로 뒤에).
    const origSeqIdx = state.sequence.findIndex(e => e.kind === 'track' && e.trackId === track.id);
    state.sequence.splice(origSeqIdx === -1 ? state.sequence.length : origSeqIdx + 1, 0, { kind: 'track', trackId: newTrack.id });
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
    // 타임라인의 곡 사이 손잡이도 붙여넣기 지점으로 쓸 수 있다는 걸 색으로 알려줌
    document.body.classList.toggle('has-clipboard', hasClip);
  }

  // track(곡 목록 카드) 또는 clip(타임라인에 이미 붙여넣은 독립 구간) 둘 다 받을 수 있음 —
  // 필드 구성이 같아서 그대로 복사해둘 수 있다.
  function copyRegionToClipboard(source) {
    state.clipboard = {
      name: source.name,
      type: source.type,
      buffer: source.buffer,
      start: source.start,
      end: source.end,
      volume: source.volume,
      fadeIn: source.fadeIn,
      fadeOut: source.fadeOut,
      crossfadeAfter: source.crossfadeAfter,
      bpm: source.bpm,
      beatOffset: source.beatOffset,
      beatTimes: source.beatTimes,
      fileData: source.fileData,
      fileType: source.fileType,
      beatType: source.beatType,
      beatBpm: source.beatBpm,
      beatBars: source.beatBars,
    };
    refreshPasteButtons();
    setStatus(`${source.name} 구간 (${(source.end - source.start).toFixed(1)}초) 복사됨 — 원하는 곡 옆 "붙여넣기"를 누르거나 타임라인의 초록 ➕를 클릭하세요 (Ctrl/Cmd+V도 가능)`);
  }

  // 지금 선택된 트랙 표시 (Ctrl/Cmd+C, Ctrl/Cmd+V 대상). 배경(버튼·입력칸 제외)을 클릭하면 바뀐다.
  function selectTrack(id) {
    state.selectedTrackId = id;
    trackList.querySelectorAll('.track-row').forEach(row => {
      row.classList.toggle('selected', Number(row.dataset.id) === id);
    });
  }

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || (key !== 'c' && key !== 'v')) return;
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return; // 텍스트 편집 중엔 원래 복사/붙여넣기 동작을 건드리지 않음
    if (key === 'c') {
      const track = state.tracks.find(t => t.id === state.selectedTrackId);
      if (!track) { setStatus('복사할 곡을 먼저 클릭해서 선택하세요'); return; }
      e.preventDefault();
      copyRegionToClipboard(track);
    } else if (key === 'v') {
      if (!state.clipboard) return;
      e.preventDefault();
      const seqIdx = state.sequence.findIndex(e2 => e2.kind === 'track' && e2.trackId === state.selectedTrackId);
      pasteClipboardAt(seqIdx === -1 ? state.sequence.length : seqIdx + 1);
    }
  });

  // 복사해둔 구간을 "타임라인 시퀀스에만" 새 독립 클립으로 끼워넣는다.
  // 곡 목록(state.tracks)에는 아무 것도 추가하지 않으므로 파란 바가 또 하나 생기지 않는다 —
  // 한 곡에서 구절을 여러 번 재사용하고 싶을 때를 위한 핵심 동작.
  function pasteClipboardAt(seqIndex) {
    const c = state.clipboard;
    if (!c) return;
    const clipEntry = {
      kind: 'clip',
      id: nextId++,
      type: c.type,
      name: c.name,
      buffer: c.buffer,
      start: c.start,
      end: c.end,
      volume: c.volume,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
      // 복사해둔 크로스페이드 값은 원래 위치 기준이라, 새 자리에 그대로 물려주면
      // 바로 옆 곡과 예상 밖으로 겹쳐 보일 수 있다 (버그 리포트로 확인됨) — 0으로 시작.
      crossfadeAfter: 0,
      bpm: c.bpm,
      beatOffset: c.beatOffset,
      beatTimes: c.beatTimes || [],
      fileData: c.fileData,
      fileType: c.fileType,
      beatType: c.beatType,
      beatBpm: c.beatBpm,
      beatBars: c.beatBars,
    };
    state.sequence.splice(seqIndex, 0, clipEntry);
    renderTimeline();
    markDirty();
    setStatus(`${c.name} 구간이 타임라인에 붙여넣기됨 — 클립 가장자리를 드래그하면 다시 자르거나 늘릴 수 있어요`);
  }

  pasteEndBtn.addEventListener('click', () => pasteClipboardAt(state.sequence.length));

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
  // state.sequence의 각 항목을 "실제 재생/렌더에 필요한 값"으로 풀어준다.
  // kind:'track'인 항목은 곡 목록의 트랙을 그대로 참조(트림 값은 목록에서 실시간으로 읽음),
  // kind:'clip'인 항목은 자체 필드를 그대로 사용한다 (목록에 카드가 없는 독립 구간).
  function resolveSeqEntry(entry) {
    if (entry.kind === 'track') {
      const track = state.tracks.find(t => t.id === entry.trackId);
      if (!track) return null;
      return {
        key: 'track-' + track.id,
        kind: 'track',
        entry,
        track,
        id: track.id,
        name: track.name,
        buffer: track.buffer,
        start: track.start,
        end: track.end,
        volume: track.volume,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
        crossfadeAfter: track.crossfadeAfter,
      };
    }
    // kind: 'clip' — 독립 구간, 필드가 그 항목 자체에 있음
    return {
      key: 'clip-' + entry.id,
      kind: 'clip',
      entry,
      id: entry.id,
      name: entry.name,
      buffer: entry.buffer,
      start: entry.start,
      end: entry.end,
      volume: entry.volume,
      fadeIn: entry.fadeIn,
      fadeOut: entry.fadeOut,
      crossfadeAfter: entry.crossfadeAfter,
    };
  }

  function computeTimeline() {
    let cursor = 0;
    const items = [];
    const resolved = state.sequence.map(resolveSeqEntry).filter(Boolean);
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const clipDur = Math.max(0, r.end - r.start);
      const item = Object.assign({}, r, {
        timelineStart: cursor,
        clipDuration: clipDur,
      });
      items.push(item);
      const crossfade = i < resolved.length - 1 ? Math.min(r.crossfadeAfter || 0, clipDur) : 0;
      cursor = cursor + clipDur - crossfade;
    }
    const totalDuration = items.length
      ? items[items.length - 1].timelineStart + items[items.length - 1].clipDuration
      : 0;
    return { items, totalDuration };
  }

  // ---------- Timeline view (drag to reorder, drag handle to crossfade) ----------
  function trackColor(key) {
    let hash = 0;
    const s = String(key);
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
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
      clip.dataset.key = item.key;
      clip.style.left = (item.timelineStart * PX_PER_SEC) + 'px';
      clip.style.width = Math.max(item.clipDuration * PX_PER_SEC, 4) + 'px';
      clip.style.background = trackColor(item.key);

      const clipWidthPx = Math.max(Math.round(item.clipDuration * PX_PER_SEC), 4);
      const waveCanvas = document.createElement('canvas');
      waveCanvas.className = 'timeline-clip-wave';
      waveCanvas.width = clipWidthPx;
      waveCanvas.height = 52;
      clip.appendChild(waveCanvas);
      drawWaveformRegion(waveCanvas, item.buffer, item.start, item.end);

      const progressEl = document.createElement('div');
      progressEl.className = 'timeline-clip-progress';
      clip.appendChild(progressEl);

      const label = document.createElement('span');
      label.className = 'timeline-clip-label';
      const tag = item.kind === 'clip' ? ' · 구간' : '';
      label.textContent = `${item.name} (${item.clipDuration.toFixed(1)}s)${tag}`;
      clip.appendChild(label);

      // kind:'clip'(목록에 카드 없는 독립 구간)만 타임라인 위에서 직접 자르고
      // 늘리는 손잡이 + 복사/제거 버튼을 가진다. kind:'track'은 기존처럼 곡 목록에서 편집.
      if (item.kind === 'clip') {
        clip.classList.add('timeline-clip-standalone');

        const trimLeft = document.createElement('div');
        trimLeft.className = 'clip-trim-handle clip-trim-left';
        clip.appendChild(trimLeft);
        const trimRight = document.createElement('div');
        trimRight.className = 'clip-trim-handle clip-trim-right';
        clip.appendChild(trimRight);
        makeClipTrimHandle(trimLeft, item, 'start');
        makeClipTrimHandle(trimRight, item, 'end');

        const toolbar = document.createElement('div');
        toolbar.className = 'clip-toolbar';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'clip-tool-btn';
        copyBtn.textContent = '복사';
        copyBtn.title = '이 구간을 다시 복사해서 다른 곳에 또 붙여넣기';
        copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyRegionToClipboard(item.entry);
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'clip-tool-btn clip-tool-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = '타임라인에서 이 구간 제거 (원본 곡은 그대로 남음)';
        removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = state.sequence.indexOf(item.entry);
          if (idx !== -1) {
            state.sequence.splice(idx, 1);
            renderTimeline();
            markDirty();
          }
        });
        toolbar.appendChild(copyBtn);
        toolbar.appendChild(removeBtn);
        clip.appendChild(toolbar);
      }

      timelineTrackEl.appendChild(clip);
      makeClipDraggable(clip, item);

      if (i < items.length - 1) {
        const nextItem = items[i + 1];
        const handle = document.createElement('div');
        handle.className = 'timeline-handle';
        handle.style.left = (nextItem.timelineStart * PX_PER_SEC) + 'px';
        timelineTrackEl.appendChild(handle);
        makeCrossfadeHandleDraggable(handle, item, nextItem, i + 1);
      }
    });

    // 맨 앞 삽입 지점: 복사해둔 구간이 있을 때, 첫 곡 앞에 바로 붙여넣을 수 있음
    const leadHandle = document.createElement('div');
    leadHandle.className = 'timeline-handle timeline-handle-edge';
    leadHandle.style.left = '0px';
    timelineTrackEl.appendChild(leadHandle);
    makePasteOnlyHandle(leadHandle, 0);

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
    trackList.querySelectorAll('.wave-progress').forEach(el => { el.style.display = 'none'; el.style.width = '0%'; });
  }

  // 믹스 전체 재생 중: 타임라인을 가로지르는 선 + 각 클립이 재생된 만큼 그림자 채우기.
  // 동시에 지금 재생 중인 곡의 트랙 목록 파형 바에도 같은 재생 위치를 반영한다.
  function updateTimelineProgressForItems(items, elapsed) {
    timelinePlayhead.style.display = 'block';
    timelinePlayhead.style.left = (elapsed * PX_PER_SEC) + 'px';
    items.forEach(item => {
      const clip = timelineTrackEl.querySelector(`.timeline-clip[data-key="${item.key}"]`);
      const local = elapsed - item.timelineStart;
      const playing = local > 0 && local < item.clipDuration;
      if (clip) {
        const progressEl = clip.querySelector('.timeline-clip-progress');
        let pct = 0;
        if (local <= 0) pct = 0;
        else if (local >= item.clipDuration) pct = 100;
        else pct = (local / item.clipDuration) * 100;
        if (progressEl) progressEl.style.width = pct + '%';
        clip.classList.toggle('playing', playing);
      }
      // 목록에 카드가 있는(kind:'track') 항목만 곡 목록 파형 바에도 재생 위치를 반영한다 —
      // 목록에 없는 독립 구간(kind:'clip')은 표시할 파형 바가 없다.
      if (item.kind === 'track') {
        const absoluteTime = item.start + Math.max(0, Math.min(local, item.clipDuration));
        const fraction = absoluteTime / item.buffer.duration;
        setRowPlayhead(item.track, fraction, playing);
      }
    });
  }

  // fraction: 트랙 전체 버퍼(0~buffer.duration) 기준 현재 재생 위치 비율(0~1)
  function setRowPlayhead(track, fraction, visible) {
    const row = trackList.querySelector(`[data-id="${track.id}"]`);
    if (!row) return;
    const wavePlayhead = row.querySelector('.wave-playhead');
    const waveProgress = row.querySelector('.wave-progress');
    if (!visible) {
      if (wavePlayhead) wavePlayhead.style.display = 'none';
      if (waveProgress) waveProgress.style.display = 'none';
      return;
    }
    const pct = (Math.max(0, Math.min(1, fraction)) * 100) + '%';
    if (wavePlayhead) { wavePlayhead.style.left = pct; wavePlayhead.style.display = 'block'; }
    if (waveProgress) { waveProgress.style.width = pct; waveProgress.style.display = 'block'; }
  }

  function makeClipDraggable(clip, item) {
    clip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.clip-trim-handle, .clip-toolbar')) return;
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
          const others = snapshot.filter(it => it.key !== item.key);
          let targetIndex = others.length;
          for (let i = 0; i < others.length; i++) {
            const center = (others[i].timelineStart + others[i].clipDuration / 2) * PX_PER_SEC;
            if (dropX < center) { targetIndex = i; break; }
          }
          const curIdx = state.sequence.indexOf(item.entry);
          if (curIdx !== -1) {
            const [entry] = state.sequence.splice(curIdx, 1);
            state.sequence.splice(targetIndex, 0, entry);
            markDirty();
          }
          renderTimeline();
        } else {
          // 드래그 없이 클릭만 한 경우: 클릭한 지점부터 바로 재생 (+ 목록 카드가 있으면 강조)
          const ratio = clipRect.width > 0 ? clickOffsetX / clipRect.width : 0;
          const fromTime = item.start + ratio * (item.end - item.start);
          if (item.kind === 'track') {
            playFromOffset(item.track, fromTime);
            highlightTrackRow(item.track.id);
          } else {
            playClipPreview(item, fromTime);
          }
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // 목록에 카드가 없는 독립 구간(kind:'clip') 클립을 타임라인 위에서 직접 자르거나 늘리는 손잡이.
  function makeClipTrimHandle(handleEl, item, side) {
    handleEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleEl.setPointerCapture(e.pointerId);
      const entry = item.entry;
      const startVal = entry.start;
      const endVal = entry.end;
      const bufferDur = entry.buffer.duration;
      const startX = e.clientX;
      const clipEl = handleEl.parentElement;
      const baseLeftPx = parseFloat(clipEl.style.left) || 0;
      const baseWidthPx = parseFloat(clipEl.style.width) || 0;

      const onMove = (ev) => {
        const dxPx = ev.clientX - startX;
        if (side === 'start') {
          const newWidth = Math.max(4, baseWidthPx - dxPx);
          clipEl.style.left = (baseLeftPx + (baseWidthPx - newWidth)) + 'px';
          clipEl.style.width = newWidth + 'px';
        } else {
          clipEl.style.width = Math.max(4, baseWidthPx + dxPx) + 'px';
        }
      };
      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const dxSec = (ev.clientX - startX) / PX_PER_SEC;
        if (side === 'start') {
          entry.start = Math.max(0, Math.min(startVal + dxSec, endVal - 0.1));
        } else {
          entry.end = Math.min(bufferDur, Math.max(endVal + dxSec, startVal + 0.1));
        }
        renderTimeline();
        markDirty();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // 곡과 곡 사이의 손잡이: 드래그하면 크로스페이드 조정, 드래그 없이 클릭만 하면
  // (복사해둔 구간이 있을 때) 바로 그 지점에 붙여넣기.
  function makeCrossfadeHandleDraggable(handle, item, nextItem, insertSeqIndex) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startCrossfade = item.crossfadeAfter || 0;
      const maxCrossfade = Math.min(item.clipDuration, nextItem.clipDuration);
      let moved = false;

      const onMove = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        const dxSec = (ev.clientX - startX) / PX_PER_SEC;
        let newVal = startCrossfade - dxSec; // drag left = more overlap, right = less
        newVal = Math.max(0, Math.min(maxCrossfade, newVal));
        if (item.kind === 'track') {
          item.track.crossfadeAfter = newVal;
          const row = trackList.querySelector(`[data-id="${item.id}"]`);
          const input = row?.querySelector('.in-crossfade');
          if (input) input.value = newVal.toFixed(2);
        } else {
          item.entry.crossfadeAfter = newVal;
        }
        setStatus(`크로스페이드: ${newVal.toFixed(2)}초`);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          renderTimeline();
          markDirty();
        } else if (state.clipboard) {
          pasteClipboardAt(insertSeqIndex);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // 타임라인 맨 앞의 삽입 지점: 드래그는 없고, 복사해둔 구간이 있을 때 클릭하면 맨 앞에 붙여넣기.
  function makePasteOnlyHandle(handle, insertIndex) {
    handle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.clipboard) {
        setStatus('먼저 곡 목록에서 "복사" 버튼으로 구간을 복사하세요');
        return;
      }
      pasteClipboardAt(insertIndex);
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
  // item: { buffer, start, volume, fadeIn, fadeOut, clipDuration } — kind:'track'와 kind:'clip'
  // 둘 다 이 모양으로 정규화되어 들어온다 (computeTimeline() 참고).
  function scheduleTrack(ctx, destination, item, when) {
    const { buffer, clipDuration } = item;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(destination);

    const vol = (item.volume ?? 100) / 100;
    const fadeIn = Math.min(item.fadeIn || 0, clipDuration / 2);
    const fadeOut = Math.min(item.fadeOut || 0, clipDuration / 2);

    const t0 = when;
    const t1 = when + clipDuration;

    gain.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, t0);
    if (fadeIn > 0) gain.gain.linearRampToValueAtTime(vol, t0 + fadeIn);
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(vol, Math.max(t0, t1 - fadeOut));
      gain.gain.linearRampToValueAtTime(0, t1);
    }

    src.start(when, item.start, clipDuration);
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
    playBtn.disabled = state.sequence.length === 0;
    timelinePlayBtn.disabled = state.sequence.length === 0;
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
  // fromTime이 구간의 시작점(start)보다 뒤라면 "가운데부터 스크럽"으로 보고 페이드인은 생략.
  // source: { key, buffer, name, start, end, volume, fadeIn, fadeOut } — 곡 목록 트랙이든
  // 타임라인의 독립 구간(clip)이든 같은 모양으로 넘기면 됨.
  async function playRegionPreview(source, fromTime, opts) {
    const btn = opts && opts.btn;
    const ctx = getAudioCtx();
    await ctx.resume();
    stopPreview();
    stopTrackPreview();
    const startAt = Math.min(Math.max(fromTime, source.start), source.end - 0.05);
    const isSeek = startAt > source.start + 0.01;
    const clipDuration = source.end - startAt;
    const scheduleItem = {
      buffer: source.buffer,
      start: startAt,
      volume: source.volume,
      fadeIn: isSeek ? 0 : source.fadeIn,
      fadeOut: source.fadeOut,
      clipDuration,
    };
    const startCtxTime = ctx.currentTime + 0.05;
    const src = scheduleTrack(ctx, ctx.destination, scheduleItem, startCtxTime);
    state.trackPreviewSource = src;
    state.trackPreviewBtn = btn || null;
    if (btn) {
      btn.textContent = '■';
      btn.classList.add('playing');
    }
    setStatus(`${source.name} 미리듣기 중... (${formatTime(startAt)}부터)`);

    // 이 구간 하나만 미리듣는 중에도 파형 위 재생선 + 타임라인의 해당 클립 진행 표시를 함께 움직인다.
    const bufferDuration = Math.max(0.001, source.buffer.duration);
    const seekOffset = startAt - source.start;
    const { items: fullItems } = computeTimeline();
    const matchedItem = fullItems.find(it => it.key === source.key);

    startProgressAnim(ctx, startCtxTime, clipDuration, (elapsed) => {
      if (opts && opts.trackForRow) {
        // 파형 바는 트랙 전체 버퍼(0~duration) 기준, 클립 구간(clipDuration) 기준이 아니다
        const bufferFraction = (startAt + elapsed) / bufferDuration;
        setRowPlayhead(opts.trackForRow, bufferFraction, true);
      }
      if (matchedItem) {
        const playedFraction = matchedItem.clipDuration > 0 ? (seekOffset + elapsed) / matchedItem.clipDuration : 0;
        timelinePlayhead.style.display = 'block';
        timelinePlayhead.style.left = ((matchedItem.timelineStart + seekOffset + elapsed) * PX_PER_SEC) + 'px';
        const clip = timelineTrackEl.querySelector(`.timeline-clip[data-key="${source.key}"]`);
        if (clip) {
          const progressEl = clip.querySelector('.timeline-clip-progress');
          if (progressEl) progressEl.style.width = (Math.max(0, Math.min(1, playedFraction)) * 100) + '%';
          clip.classList.add('playing');
        }
      }
    }, () => {
      if (opts && opts.trackForRow) setRowPlayhead(opts.trackForRow, 0, false);
      clearTimelineProgress();
    });

    const endTimer = setTimeout(() => {
      if (state.trackPreviewBtn === (btn || null)) stopTrackPreview();
    }, clipDuration * 1000 + 150);
    src._endTimer = endTimer;
  }

  // 곡 목록(파란 바) 쪽에서 부르는 얇은 래퍼 — 재생 버튼/파형 바 재생선까지 함께 갱신.
  async function playFromOffset(track, fromTime) {
    const btn = trackList.querySelector(`[data-id="${track.id}"] .btn-play-track`);
    await playRegionPreview(
      { key: 'track-' + track.id, buffer: track.buffer, name: track.name, start: track.start, end: track.end, volume: track.volume, fadeIn: track.fadeIn, fadeOut: track.fadeOut },
      fromTime,
      { btn, trackForRow: track }
    );
  }

  // 타임라인 위 독립 구간(kind:'clip', 목록에 카드 없음) 클릭 시 미리듣기 — 재생 버튼/행이 없음.
  async function playClipPreview(item, fromTime) {
    await playRegionPreview(
      { key: item.key, buffer: item.buffer, name: item.name, start: item.start, end: item.end, volume: item.volume, fadeIn: item.fadeIn, fadeOut: item.fadeOut },
      fromTime,
      {}
    );
  }

  // ---------- Export to WAV ----------
  exportBtn.addEventListener('click', async () => {
    const { items, totalDuration } = computeTimeline();
    if (items.length === 0) return;
    showProgress('믹스 렌더링 중...');
    try {
      const sampleRate = items[0].buffer.sampleRate;
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
  const SEQ_STORE_NAME = 'sequence';
  const DB_VERSION = 2;
  let dbPromise = null;

  function openDb() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(SEQ_STORE_NAME)) {
          db.createObjectStore(SEQ_STORE_NAME, { keyPath: 'order' });
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

  // 곡 목록(state.tracks)과 타임라인 순서(state.sequence)를 함께 저장한다.
  // 시퀀스의 kind:'track' 항목은 곡 목록에서의 "몇 번째 곡인지"(trackOrder)로 저장해뒀다가
  // 불러올 때 새로 매겨지는 id에 다시 연결한다 — 새로고침마다 id가 바뀌기 때문.
  async function persistTracks() {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction([STORE_NAME, SEQ_STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const seqStore = tx.objectStore(SEQ_STORE_NAME);
      store.clear();
      seqStore.clear();
      const trackOrderById = {};
      state.tracks.forEach((track, order) => {
        trackOrderById[track.id] = order;
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
      state.sequence.forEach((entry, order) => {
        if (entry.kind === 'track') {
          if (!(entry.trackId in trackOrderById)) return;
          seqStore.put({ order, kind: 'track', trackOrder: trackOrderById[entry.trackId] });
        } else {
          seqStore.put({
            order,
            kind: 'clip',
            type: entry.type,
            name: entry.name,
            start: entry.start,
            end: entry.end,
            volume: entry.volume,
            fadeIn: entry.fadeIn,
            fadeOut: entry.fadeOut,
            crossfadeAfter: entry.crossfadeAfter,
            bpm: entry.bpm || null,
            beatOffset: entry.beatOffset || 0,
            beatTimes: entry.beatTimes || [],
            fileData: entry.type === 'audio' ? entry.fileData : null,
            fileType: entry.type === 'audio' ? entry.fileType : null,
            beatType: entry.type === 'beat' ? entry.beatType : null,
            beatBpm: entry.type === 'beat' ? entry.beatBpm : null,
            beatBars: entry.type === 'beat' ? entry.beatBars : null,
          });
        }
      });
      await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    } catch (err) {
      console.warn('자동 저장 실패', err);
    }
  }

  async function loadPersistedTracks() {
    const db = await openDb();
    if (!db) return;
    let trackRecords = [];
    let seqRecords = [];
    try {
      const tx = db.transaction([STORE_NAME, SEQ_STORE_NAME], 'readonly');
      trackRecords = await new Promise((resolve, reject) => {
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      seqRecords = await new Promise((resolve, reject) => {
        const req = tx.objectStore(SEQ_STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('이전 작업 불러오기 실패', err);
      return;
    }
    if (!trackRecords.length) return;
    trackRecords.sort((a, b) => a.order - b.order);
    seqRecords.sort((a, b) => a.order - b.order);
    showProgress('이전에 저장된 곡 불러오는 중...');
    const ctx = getAudioCtx();
    let loaded = 0;
    const idByTrackOrder = {};
    for (let i = 0; i < trackRecords.length; i++) {
      const rec = trackRecords[i];
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
        idByTrackOrder[rec.order] = track.id;
        state.tracks.push(track);
        renderTrack(track);
        loaded++;
      } catch (err) {
        console.warn('트랙 복원 실패', rec.name, err);
      }
    }
    // 타임라인 시퀀스 복원: kind:'track'은 방금 되살린 트랙 id로 연결하고,
    // kind:'clip'(목록에 카드 없는 독립 구간)은 자체 오디오를 다시 디코딩해서 복원한다.
    if (seqRecords.length) {
      for (const rec of seqRecords) {
        if (rec.kind === 'track') {
          const trackId = idByTrackOrder[rec.trackOrder];
          if (trackId != null) state.sequence.push({ kind: 'track', trackId });
        } else if (rec.kind === 'clip') {
          try {
            let buffer = null;
            if (rec.type === 'audio' && rec.fileData) {
              buffer = await ctx.decodeAudioData(rec.fileData.slice(0));
            } else if (rec.type === 'beat' && rec.beatType) {
              buffer = synthesizeBeat(rec.beatType, rec.beatBpm, rec.beatBars).buffer;
            }
            if (!buffer) continue;
            state.sequence.push({
              kind: 'clip',
              id: nextId++,
              type: rec.type,
              name: rec.name,
              buffer,
              fileData: rec.type === 'audio' ? rec.fileData : null,
              fileType: rec.fileType,
              beatType: rec.beatType,
              beatBpm: rec.beatBpm,
              beatBars: rec.beatBars,
              start: rec.start,
              end: rec.end,
              volume: rec.volume,
              fadeIn: rec.fadeIn,
              fadeOut: rec.fadeOut,
              crossfadeAfter: rec.crossfadeAfter,
              bpm: rec.bpm,
              beatOffset: rec.beatOffset,
              beatTimes: rec.beatTimes || [],
            });
          } catch (err) {
            console.warn('타임라인 구간 복원 실패', rec.name, err);
          }
        }
      }
    } else {
      // 구버전 데이터(시퀀스 저장 이전)와의 호환: 트랙 순서 그대로 시퀀스로 채운다.
      trackRecords.forEach((rec) => {
        const trackId = idByTrackOrder[rec.order];
        if (trackId != null) state.sequence.push({ kind: 'track', trackId });
      });
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
      const trackOrderById = {};
      const tracks = state.tracks.map((track, order) => {
        trackOrderById[track.id] = order;
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
      // 타임라인 순서: kind:'track'은 곡 목록에서 몇 번째인지(trackOrder)로, kind:'clip'(목록에
      // 카드 없는 독립 구간)은 자체 오디오까지 통째로 함께 저장 — 팀원이 열어도 그대로 재현된다.
      const sequence = state.sequence.map(entry => {
        if (entry.kind === 'track') {
          if (!(entry.trackId in trackOrderById)) return null;
          return { kind: 'track', trackOrder: trackOrderById[entry.trackId] };
        }
        const rec = {
          kind: 'clip',
          type: entry.type,
          name: entry.name,
          start: entry.start,
          end: entry.end,
          volume: entry.volume,
          fadeIn: entry.fadeIn,
          fadeOut: entry.fadeOut,
          crossfadeAfter: entry.crossfadeAfter,
          bpm: entry.bpm || null,
          beatOffset: entry.beatOffset || 0,
          beatTimes: entry.beatTimes || [],
        };
        if (entry.type === 'audio') {
          rec.fileType = entry.fileType;
          rec.fileDataBase64 = arrayBufferToBase64(entry.fileData);
        } else if (entry.type === 'beat') {
          rec.beatType = entry.beatType;
          rec.beatBpm = entry.beatBpm;
          rec.beatBars = entry.beatBars;
        }
        return rec;
      }).filter(Boolean);
      const project = { formatVersion: 2, exportedAt: new Date().toISOString(), tracks, sequence };
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
        state.sequence = [];
        trackList.innerHTML = '';
      }

      const ctx = getAudioCtx();
      let loaded = 0;
      const idByImportOrder = {};
      for (let i = 0; i < project.tracks.length; i++) {
        const rec = project.tracks[i];
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
        idByImportOrder[i] = track.id;
        state.tracks.push(track);
        renderTrack(track);
        loaded++;
      }
      // 타임라인 순서 복원 (formatVersion 2+). 구버전 파일(sequence 없음)은 곡 목록 순서
      // 그대로를 타임라인으로 쓴다 — 예전엔 둘이 항상 같았으므로 동작이 그대로 유지된다.
      if (Array.isArray(project.sequence)) {
        for (const rec of project.sequence) {
          if (rec.kind === 'track') {
            const trackId = idByImportOrder[rec.trackOrder];
            if (trackId != null) state.sequence.push({ kind: 'track', trackId });
          } else if (rec.kind === 'clip') {
            try {
              let buffer = null;
              if (rec.type === 'audio' && rec.fileDataBase64) {
                const fileData = base64ToArrayBuffer(rec.fileDataBase64);
                buffer = await ctx.decodeAudioData(fileData.slice(0));
                rec._fileData = fileData;
              } else if (rec.type === 'beat' && rec.beatType) {
                buffer = synthesizeBeat(rec.beatType, rec.beatBpm, rec.beatBars).buffer;
              }
              if (!buffer) continue;
              state.sequence.push({
                kind: 'clip',
                id: nextId++,
                type: rec.type,
                name: rec.name,
                buffer,
                fileData: rec.type === 'audio' ? rec._fileData : null,
                fileType: rec.fileType,
                beatType: rec.beatType,
                beatBpm: rec.beatBpm,
                beatBars: rec.beatBars,
                start: rec.start,
                end: rec.end,
                volume: rec.volume,
                fadeIn: rec.fadeIn,
                fadeOut: rec.fadeOut,
                crossfadeAfter: rec.crossfadeAfter,
                bpm: rec.bpm,
                beatOffset: rec.beatOffset,
                beatTimes: rec.beatTimes || [],
              });
            } catch (err) {
              console.warn('타임라인 구간 복원 실패', rec.name, err);
            }
          }
        }
      } else {
        project.tracks.forEach((rec, i) => {
          const trackId = idByImportOrder[i];
          if (trackId != null) state.sequence.push({ kind: 'track', trackId });
        });
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
