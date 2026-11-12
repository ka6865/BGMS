# 게시글 조회 오류와 색인 제외

`/board/[postId]`의 메타데이터 조회와 상세 조회는 `maybeSingle()`로 행 없음과 조회 실패를 구분한다.

- 조회 성공: 기존 제목·설명·canonical과 본문을 유지한다.
- 양의 안전한 정수가 아닌 ID 또는 공개 조회 결과 없음: `notFound()`로 공통 찾을 수 없음 화면을 사용한다. 비공개 글의 존재 여부를 별도로 노출하지 않는다.
- DB·권한·네트워크 오류: 예외를 오류 경계로 전달한다. 조회 실패를 `null`로 바꾸거나 애플리케이션에서 `robots.index = false`를 반환하지 않는다. 상세 화면은 오류 내용을 노출하지 않고 재시도 버튼을 제공한다.
- 댓글 조회만 실패: 게시글은 계속 표시하고 댓글 오류 상태를 전달한다.

Next.js가 응답 스트리밍을 시작한 뒤에는 `notFound()`나 예외가 발생해도 HTTP 상태가 200으로 남을 수 있다. 없는 글은 프레임워크가 추가하는 `noindex`와 찾을 수 없음 화면으로 처리되며, 상태 코드만으로 정상·없음·장애를 구분하지 않는다. 일시 장애를 반드시 HTTP 5xx로 응답하게 만드는 것은 별도 응답 시점 설계가 필요하다.

회귀 검증:

```bash
npm run test:unit -- tests/board-post-seo.test.ts tests/seo-metadata-contract.test.ts tests/board-html-sanitize.test.ts
npm run verify:core
```

단위 테스트는 모의 DB 응답을 사용한다. Google 재수집이나 색인 요청은 코드 검증과 별도 운영 조치다.
