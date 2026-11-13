# PadNote

아이패드 Safari에서 PDF 위에 Apple Pencil로 필기하고, **원본 + 필기를 한 파일**로 저장하는 정적 웹앱입니다.
서버가 없고, 파일은 기기 밖으로 나가지 않습니다. 빌드 과정도 없습니다(`index.html` + `src/` + `vendor/`).

## 쓰는 법

| 입력 | 동작 |
| --- | --- |
| Apple Pencil | 필기 (필압 반영) |
| 한 손가락 | 스크롤 |
| 두 손가락 | 확대 / 이동 |
| 마우스 | 항상 필기 (Ctrl+휠 또는 트랙패드 핀치로 확대) |
| ☝ 버튼 | 손가락 필기 켜기 (펜슬이 없을 때) |

- 도구: 펜, 형광펜, 획 지우개, 실행취소/다시실행. 선택된 도구를 한 번 더 누르면 굵기 조절.
- 필기 설정(슬라이더 아이콘): **필압 반영**(기본 끔), **획 보정** 끔/약/보통/강 — 자글거림과 손떨림을 줄입니다.
- **저장(공유 아이콘)**: 공유 시트에서 "파일에 저장"을 고릅니다. 항상 새 파일(`이름-필기.pdf`)로 저장됩니다.
- 저장한 파일을 다시 열면 필기가 **편집 가능한 획**으로 돌아옵니다.
- 필기는 기기 안(IndexedDB)에 자동 저장되고, 홈의 "최근 문서"에서 바로 다시 열 수 있습니다.
- **녹화(●)**: 켜 둔 동안의 필기·지우기가 시간과 함께 기록됩니다. ▶ 로 재생(스크러버, 배속, 빈 구간 건너뛰기).

## 배포 (GitHub Pages)

1. 저장소 **Settings → Pages → Build and deployment → Deploy from a branch**
2. 배포할 브랜치와 `/ (root)` 를 선택하고 저장
3. `https://<사용자>.github.io/<저장소>/` 로 접속 → Safari 공유 버튼 → **홈 화면에 추가**

모든 경로가 상대 경로라 하위 경로(`/<저장소>/`)에서 그대로 동작합니다. `.nojekyll` 이 있어 파일이 가공 없이 올라갑니다.

로컬에서 볼 때: `python3 -m http.server 8000` 후 `http://localhost:8000/`

## 구조

```
index.html              화면 뼈대
manifest.webmanifest    홈 화면 앱 설정
sw.js                   오프라인 캐시
src/app.js              화면 전환, 도구 막대, 열기·자동 저장·내보내기, 녹화 UI
src/viewer.js           페이지 배치, 보이는 페이지만 렌더링, 확대
src/input.js            펜/손가락/마우스 구분, 획 입력, 지우개, 핀치
src/ink.js              획 → 캔버스 / PDF 연산자 (같은 경로 생성기 공유), 판정
src/notes.js            획 데이터, 실행취소, 녹화 타임라인
src/playback.js         녹화 재생
src/padfile.js          통합 저장 파일 만들기 / 다시 읽기
src/store.js            IndexedDB
vendor/pdfjs            pdf.js 6.5.438 (legacy 빌드) + CMap·표준 글꼴·wasm
vendor/pdf-lib          @cantoo/pdf-lib 2.11.1
```

## 데이터

```js
// 획: 좌표는 페이지 기준(pdf.js 뷰포트 scale 1, 원점 좌상단, 단위 pt)
{ tool: 'pen' | 'hl', color: '#rrggbb', size, pts: [x, y, p, dt, ...], t0?, deletedAt?, inst? }
```

- `p` 필압(0–1), `dt` 획 시작 기준 ms. `t0` 는 녹화 타임라인 시각.
- 녹화 중 지우면 삭제 대신 `deletedAt` 을 기록합니다. 녹화 중 되살린 획은 그 시각에 한 번에 나타나는 사본(`inst`)이 됩니다.
- 녹화 타임라인은 녹화가 켜져 있던 시간만 이어 붙인 시계이고, 구간마다 실제 시작 시각(`rec.sessions[].at`)을 남겨 둡니다(나중에 음성 녹음과 맞추기 위한 자리).

## 통합 저장 형식

```
[ 원본 PDF 바이트 그대로 ][ 증분 업데이트 ]
```

증분 업데이트(PDF 표준의 incremental update)에는 다음이 들어갑니다.

1. 페이지별 필기 content stream — 벡터 경로, `/PadNote BMC … EMC` 로 표시. 최종 상태만 그립니다.
2. 획 데이터 전체(시간 정보 포함)를 deflate 한 JSON — 카탈로그의 첨부 파일 `padnote-data.json`
   맨 앞에 짧은 자기 설명(`about`, `format`)이 들어 있어, 별도 안내 없이도 필기 과정을 읽을 수 있습니다.
3. 꼬리 마커 주석 — 원본 길이, 데이터 위치, 전체 길이

다시 열 때는 꼬리 마커를 검증한 뒤 **원본 길이에서 잘라내면** 원본이 바이트 단위로 복원되고, 획은 첨부 데이터에서 되살립니다.
다른 앱이 파일을 고쳐 쓰면 마커(전체 길이)가 맞지 않게 되어 일반 PDF로 열립니다. 이때 기존 필기는 페이지에 굳은 채 보이고 그 위에 덧쓸 수 있습니다.

원본을 다시 쓰지 않으므로 원본의 구조·서명·글꼴이 그대로 보존되고, 다시 열 때 PDF를 재조립할 필요가 없어 큰 파일에서도 빠릅니다.

암호로 보호된 PDF는 증분 덧붙이기를 할 수 없어, 저장할 때 **암호를 푼 사본**을 원본으로 삼습니다(저장된 파일은 암호 없이 열립니다).

## 테스트

```sh
pip install reportlab pikepdf          # 테스트용 PDF 생성 + qpdf 교차 검증
python3 tests/make-fixtures.py tests/fixtures
node tests/export.test.mjs             # 저장 형식: 왕복, 변조 감지, qpdf·poppler 검증
node tests/e2e.test.mjs                # 브라우저(Chromium, Playwright 필요): 필기→저장→복원, 녹화, 확대, 터치, 오프라인
```

`src/` 에 파일을 추가·삭제했거나 `vendor/` 를 교체했다면 `node tools/gen-sw-assets.mjs` 로 서비스워커의 캐시 목록을 갱신합니다
(vendor 를 바꿨다면 `sw.js` 의 `VERSION` 도 올립니다). 앱 파일 수정은 배포 후 두 번째 실행부터 반영됩니다.

## 실기기에서 확인할 것

자동 테스트는 Chromium에서 합성 입력으로 돌린 것이라, 아래는 아이패드에서 직접 봐야 합니다.

- [ ] Apple Pencil 필기 중 화면이 스크롤되지 않는지, 손바닥이 획을 남기지 않는지
- [ ] 한 손가락 스크롤 관성, 두 손가락 확대가 손가락 사이 지점을 기준으로 부드럽게 되는지
- [ ] 저장 → 공유 시트 → "파일에 저장" (준비가 오래 걸리면 한 번 더 누르라는 창이 뜹니다)
- [ ] 수백 쪽 / 100MB 이상 PDF: 열기, 크게 확대한 채 스크롤, 저장 시 메모리
- [ ] 홈 화면 앱: 전체 화면, 오프라인 실행, 앱을 껐다 켠 뒤 최근 문서와 필기가 남는지
- [ ] 획 보정 단계가 손에 맞는지(작은 글씨의 꺾임이 뭉개지지 않는지), 필압을 켰을 때 굵기 변화 (`src/input.js` 의 `SMOOTH_PX`, `src/ink.js` 의 `widthOf`)

## 라이선스

`vendor/pdfjs` — Apache-2.0 (Mozilla), `vendor/pdf-lib` — MIT. 각 폴더의 LICENSE 참고.
