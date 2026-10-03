# Waldo Chat

실명·이메일·비밀번호로 가입해서 쓰는 팀 채팅 웹사이트야. Google Chat의 기본 기능을 따라 만들었고, 계정·데이터·파일은 모두 [Supabase](https://supabase.com)에 저장돼.

## 무엇이 어디에 저장되나

| 무엇 | 어디 |
|---|---|
| 계정(이메일·비밀번호) | Supabase **Auth** |
| 프로필, 대화, 메시지, 반응, 멘션, 세션 | Supabase **Postgres** (`chat_`로 시작하는 테이블) |
| 첨부 파일 | Supabase **Storage** 비공개 버킷 `chat-attachments` (브라우저가 1회용 토큰으로 직접 올림) |
| 실시간 전달(새 메시지, 입력 중, 접속 상태) | Supabase **Realtime** 비공개 채널 |

서버는 상태를 들고 있지 않아서 **Vercel** 같은 서버리스에서 그대로 돌아.

## 기능

**계정**
- 가입: 이름(실명), 이메일, 비밀번호(8자 이상). 인증 메일이나 승인 없이 바로 쓸 수 있어.
- 로그인/로그아웃, 이름 바꾸기, 비밀번호 바꾸기(바꾸면 다른 기기는 로그아웃)
- 프로필 사진: 고른 사진을 가운데 정사각형으로 잘라 256px로 줄여서 올려(Storage `avatars/` 폴더)
- 비밀번호 재설정 메일: 로그인 화면의 "비밀번호를 잊으셨나요?" → 메일 속 링크 → 새 비밀번호
- 가입할 수 있는 메일 도메인 제한(선택)
- 아직 가입 안 한 사람도 이메일로 초대할 수 있어. 그 사람이 나중에 그 이메일로 가입하면 대화가 그대로 이어져.

**대화**
- 1:1 채팅, 그룹 채팅
- 스페이스: 이름·아이콘·설명, 공개/비공개, 관리자/멤버 역할, 멤버 추가·내보내기, 설정, 삭제
- 공개 스페이스 찾아보기와 참여
- 대화 고정, 알림 끄기, 숨기기

**메시지**
- 실시간 전송, 입력 중 표시, 읽음 표시(1:1·그룹), 안 읽은 수
- 인용 답장(원래 메시지를 눌러 이동), 다른 대화로 전달(첨부 파일도 복사, 원래 작성자 표시)
- 메시지 고정: 대화마다 20개까지, 위쪽 고정 띠와 목록에서 이동·해제
- 스레드 답장, 이모티콘 반응, 수정·삭제, @멘션과 @all
- 서식(`*굵게*` `_기울임_` `~취소선~` `` `코드` ``), 링크 자동 연결
- 파일·이미지 첨부(25MB까지, 끌어다 놓기·붙여넣기)
- 별표·멘션 모아 보기, 검색, 데스크톱 알림
- 접속 상태(활동 중/자리 비움/방해 금지)와 상태 메시지
- 다크 모드, 휴대폰 화면

## 처음 설정하기

### 1. Supabase 프로젝트 만들기
1. [supabase.com](https://supabase.com)에서 새 프로젝트를 만들어. 지역은 가까운 곳(예: Seoul)으로. **DB 비밀번호**를 꼭 적어 둬.
2. 다른 설정은 바꿀 필요 없어.
   - 이 사이트는 서버가 관리자 키로 계정을 만들기 때문에 **"Confirm email"을 꺼 둘 필요가 없어.** 인증 메일은 안 가.
   - 테이블은 `npm start`로 처음 켤 때 자동으로 만들어져. 직접 만들려면 `supabase/schema.sql`을 SQL Editor에서 실행해.
   - **실시간 채널 권한은 한 번만 직접 실행해야 해:** `supabase/realtime.sql`을 SQL Editor에 붙여 넣고 실행.
   - Storage 버킷도 서버가 비공개로 자동으로 만들어.

### 2. `.env` 채우기
```bash
cp .env.example .env
```
| 값 | 어디서 찾나 |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API → `anon` `public` 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` 키 (**비밀**) |
| `DATABASE_HOST` | 위쪽 **Connect** 버튼 → Connection String → Session pooler의 host (예: `aws-1-ap-southeast-1.pooler.supabase.com`) |
| `DATABASE_USER` | 같은 곳의 user (`postgres.프로젝트ID` 모양) |
| `DATABASE_PASSWORD` | DB 비밀번호를 **그대로** (`@` 같은 기호도 바꾸지 않고, 따옴표 없이) |

> 주소 한 줄(`DATABASE_URL`)로 적어도 되지만, 비밀번호에 `@ # / ?` 같은 기호가 있으면 바꿔 적어야 해서 헷갈려. 위처럼 나눠 적는 걸 권해.

> ⚠️ `service_role` 키는 모든 권한을 가진 열쇠야. 서버의 `.env`에만 두고, 브라우저 코드·깃허브·채팅에 절대 올리지 마. 서버는 이 키를 브라우저로 보내지 않아.

### 3. 실행
Node.js 22.9 이상이 필요해.
```bash
npm install
npm start        # http://localhost:3000
npm test         # 테스트 38개 (Supabase 없이 돌아가)
```
처음 켜면 테이블과 버킷이 만들어지고 `채팅 서버: http://localhost:3000`이 나와. 설정이 틀리면 무엇을 고치면 되는지 한국어로 알려 줘.

Windows PowerShell에서 `npm.ps1 파일을 로드할 수 없습니다`가 나오면 `npm` 대신 `npm.cmd`(`npm.cmd install`, `npm.cmd start`)를 쓰면 돼. 브라우저에서 **계정 만들기**로 가입하면 바로 시작이야.

### 4. Vercel에 올리기
`vercel.json`에 설정이 들어 있어(함수 지역은 Supabase와 가까운 싱가포르 `sin1`).

1. Vercel에서 이 깃허브 저장소로 프로젝트를 만들어(Framework: Express). 진입 파일은 `src/app.js`야.
2. 프로젝트 **Settings → Environment Variables**에 `.env`와 같은 값을 넣어. 단, DB는 서버리스에 맞는 **Transaction pooler**를 써:
   - `DATABASE_PORT=6543` (Connect → Transaction pooler와 같은 host/user)
   - `BASE_URL`은 넣지 않아도 돼. Vercel에서는 로그인 쿠키에 자동으로 Secure가 붙어.
3. 배포하기 전에 테이블과 실시간 권한(`supabase/schema.sql`, `supabase/realtime.sql`)이 만들어져 있어야 해.

## 로그인은 이렇게 동작해

- **가입**: 브라우저 → 우리 서버 `/auth/signup` → 서버가 `service_role` 키로 Supabase Auth에 계정을 만들어(`email_confirm: true`라서 인증 메일 없음) → 채팅 프로필을 잇고 바로 로그인 쿠키를 줘.
- **로그인**: 브라우저가 Supabase Auth에 이메일·비밀번호를 **직접** 보내 토큰을 받아 → 우리 서버 `/auth/session`에 토큰을 넘기면, 서버가 Supabase에 그 토큰이 진짜인지 물어보고 30일짜리 로그인 쿠키를 줘. 토큰은 버려.
  - 서버가 대신 로그인하지 않는 이유: Supabase는 IP마다 로그인 횟수를 제한하는데, 모두 서버를 거치면 한 반이 동시에 로그인할 때 막힐 수 있어.
- 비밀번호를 잊으면: 로그인 화면의 "비밀번호를 잊으셨나요?"로 재설정 메일을 받아. 이게 동작하려면 Supabase 대시보드 → **Authentication → URL Configuration**에서
  - **Site URL**을 사이트 주소(예: `https://waldo-chat-gamma.vercel.app`)로,
  - **Redirect URLs**에 사이트 주소와 `http://localhost:3000`을 넣어 둬야 해. (안 넣으면 메일 링크가 엉뚱한 주소로 가.)
  - Supabase 기본 메일 서버는 한 시간에 보낼 수 있는 메일 수가 아주 적어. 많이 쓸 거면 Authentication → SMTP Settings에서 메일 서버를 연결해. 메일 문구는 Authentication → Email Templates에서 한국어로 바꿀 수 있어.

## 구조

```
src/
  app.js       Vercel 진입 파일 (export default app)
  local.js     내 컴퓨터에서 실행: 테이블·버킷 준비 후 http://localhost:3000
  runtime.js   환경 변수 읽기, DB 연결, Supabase 연결 만들기
  create-app.js  API, 파일 올리기 토큰·서명 URL
  realtime.js  Supabase Realtime으로 이벤트 보내기
  database-config.js  DB 접속 정보 확인과 에러 설명
  auth.js      가입, 로그인 세션, 로그아웃, 가입 시도 제한
  supabase.js  Supabase Auth 관리자 API와 Storage를 쓰는 곳
  service.js   대화·메시지·멤버·권한 규칙
  db.js        Postgres 연결(실서버는 pg, 테스트는 PGlite)
supabase/
  schema.sql   테이블 정의 (RLS 켬)
  realtime.sql 실시간 채널 권한 (한 번만 실행)
public/        화면 (index.html, app.js, format.js, style.css, vendor/supabase.js)
test/          테스트: 규칙, API·소켓, Supabase 요청 모양, 서식
```

## 보안 메모

- `chat_` 테이블에는 모두 **RLS를 켜고 정책을 하나도 안 만들었어.** 그래서 공개 `anon` 키로 Supabase REST API를 써도 테이블을 읽거나 쓸 수 없고, DB에 직접 연결한 우리 서버만 접근해. 모든 권한 검사는 서버(`service.js`)에서 해.
- Storage 버킷은 비공개야. 올릴 때는 서버가 크기(25MB)를 확인하고 1회용 토큰을 주고, 볼 때마다 그 대화의 멤버인지 확인한 뒤 1분짜리 서명 URL을 줘. HTML 같은 위험한 형식은 바이너리로 저장해.
- 실시간 채널은 비공개야. `supabase/realtime.sql` 규칙 때문에 각자 자기 채널(`user:<내 ID>`)만 받을 수 있고, 서버만 보낼 수 있어.
- 바꾸는 요청에는 `X-Requested-With: chat` 헤더가 꼭 있어야 해서 다른 사이트가 몰래 요청을 보낼 수 없어.
- 메시지는 항상 글자로만 그려서 스크립트가 끼어들 수 없어.
- 가입은 같은 IP에서 10분에 10번까지만 돼.
- DB 연결은 SSL로 암호화돼. 인증서까지 확인하려면 `DATABASE_CA_CERT`에 Supabase에서 받은 인증서 경로를 넣어.

## 아직 없는 것

영상 통화, 봇/앱, 예약 전송, 번역, 휴대폰 앱 푸시 알림.
