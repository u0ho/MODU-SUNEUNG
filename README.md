# 모두의 수능

빌드 없는 단일 HTML + Supabase.

## 설정
1. Supabase 프로젝트 생성 후 SQL Editor에서 `schema.sql` 실행
2. `index.html` 상단의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 교체
3. 정적 호스팅(Netlify, Vercel, GitHub Pages 등)에 `index.html` 업로드
   - 로컬 확인: `npx serve .` 또는 `python3 -m http.server`

## 트래픽 설계
- 접속자 수: Realtime Presence(인메모리, DB Write 없음)
- 새 메시지·삭제·감정표현 전파: Realtime Broadcast (postgres_changes 미사용)
- DB 접근: 접속 시 최신 300건 조회 + 등록/삭제/감정표현 시 RPC 1회
- 이름 필터·좋아요순 정렬: 로드된 메시지에서 클라이언트 인메모리 처리
- 전송·감정표현: 낙관적 업데이트, 실패 시 롤백

## 보안
- 삭제 암호(4자 이상)는 서버 함수에서 bcrypt 해시로 저장되며, 클라이언트는 해시 컬럼을 조회할 수 없음
- 테이블 쓰기는 `post_message` / `delete_message` / `react_message` 함수로만 가능
- 암호 5회 오류 시 해당 메시지 삭제가 10분간 차단됨
- 감정표현 중복 방지는 브라우저 저장소 기준이라 서버에서 강제되지 않음 (익명 구조의 한계)

`schema.sql`은 기존 테이블에도 다시 실행하면 자동 마이그레이션됩니다. 이전에 등록된(암호 없는) 메시지는 삭제할 수 없습니다.
