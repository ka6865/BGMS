/**
 * 구글 애드센스 게시자 ID와 광고 단위.
 * 주석의 이름은 애드센스 콘솔의 광고 단위 이름(페이지_위치_모양)과 같으므로
 * 보고서의 광고 단위별 수익을 코드 위치와 바로 대조할 수 있다.
 */
export const ADSENSE_CLIENT = "ca-pub-3993032200487955";

export const ADSENSE_SLOTS = {
  statsTop: "9810524879", // 전적_상단_가로
  statsFeed: "4661728917", // 전적_목록중간_인피드
  statsRailLeft: "1065675747", // 전적_좌측레일_세로
  statsRailRight: "7184361536", // 전적_우측레일_세로
  statsRailLeftTop: "9345679922", // 전적_좌측레일_상단사각
  statsRailRightTop: "4093353248", // 전적_우측레일_상단사각
  statsRailLeftHalf: "3383651661", // 전적_좌측레일_하프
  statsRailRightHalf: "2070569998", // 전적_우측레일_하프
  mapBottom: "9597017865", // 지도_하단_가로
  mapMobileSheet: "5871279864", // 지도_모바일시트_가로
  backpackBottom: "5467210328", // 가방_하단_가로
  backpackRailRight: "7223145127", // 가방_우측레일_세로
  cratesBottom: "5910063457", // 상자깡_하단_가로
  cratesRailLeft: "2917813463", // 상자깡_좌측레일_세로
  cratesRailRight: "1650598365", // 상자깡_우측레일_세로
  rankingsTop: "8752594072", // 랭킹_상단_가로
  rankingsRailLeft: "4154128657", // 랭킹_좌측레일_세로
  rankingsRailRight: "1527965317", // 랭킹_우측레일_세로
  weaponsBottom: "3328132147", // 무기도감_하단_가로
  weaponsRailLeft: "8283936193", // 무기도감_좌측레일_세로
  weaponsRailRight: "5657772855", // 무기도감_우측레일_세로
  weaponMasteryTop: "4596981780", // 무기숙련_상단_가로
  weaponMasteryRailRight: "1604731798", // 무기숙련_우측레일_세로
  battleTop: "4558198192", // 배틀_상단_가로
  battleRailRight: "1180305940", // 배틀_우측레일_세로
  boardPostMiddle: "7901801971", // 게시판_글중간_가로
  boardRailLeft: "7728921550", // 게시판_좌측레일_세로
  boardRailRight: "7554142601", // 게시판_우측레일_세로
} as const;
