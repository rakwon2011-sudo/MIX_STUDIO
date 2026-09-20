# MIX STUDIO

브라우저에서 곡을 올리고, 파형을 보면서 구간을 자르고, 크로스페이드/볼륨/페이드를 조정하고, 영상과 타이밍을 맞춰보고, 완성된 믹스를 WAV로 내보내는 정적 웹앱입니다.

모든 처리는 브라우저 안(Web Audio API)에서 이루어지며, 서버로 파일이 전송되지 않습니다. 유튜브 링크는 직접 지원하지 않으므로, 미리 `yt-dlp` 등으로 오디오 파일을 받아서 업로드해 사용하세요.

## 기능

- mp3/wav 파일 업로드 + 파형 표시
- 자동 BPM 감지 (web-audio-beat-detector, CDN)
- 드래그로 시작/끝 지점 조정 + "비트 스냅" 버튼
- 페이드인/아웃, 볼륨 조절
- 곡 간 크로스페이드 길이 조정
- 순서 변경 (▲▼)
- 내장 비트 라이브러리 (킥/하이햇/클랩, BPM·길이 지정 가능 — 합성음, 외부 파일 없음)
- 영상 업로드 후 미리듣기와 동기화 재생 (최종 내보내기에는 영상 미포함 — 타이밍 확인용)
- 완성된 믹스를 WAV 파일로 내보내기

## 로컬에서 미리 보기

```
cd mixtape-studio
python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 접속.

## GitHub Pages로 배포하기

1. GitHub에서 새 저장소를 만듭니다 (예: `MIX_STUDIO`).
2. 이 폴더(`index.html`, `style.css`, `app.js`, `README.md`)를 저장소에 그대로 넣습니다.
3. 터미널에서:
   ```
   cd MIX_STUDIO
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<계정명>/MIX_STUDIO.git
   git push -u origin main
   ```
4. GitHub 저장소 페이지 → Settings → Pages → Source를 "Deploy from a branch", Branch를 "main / (root)"로 설정 후 저장.
5. 잠시 후 `https://<계정명>.github.io/MIX_STUDIO/` 에서 접속 가능합니다.

## 알려진 제약

- 유튜브 링크 직접 가져오기는 지원하지 않습니다 (브라우저 보안 정책상 불가능). 파일로 미리 받아서 업로드하세요.
- 영상은 미리듣기 동기화용이며, 내보내기에는 오디오만 포함됩니다.
- BPM 자동 감지는 곡에 따라 부정확할 수 있습니다 — 그럴 땐 파형을 보면서 수동으로 시작/끝을 조정하세요.
