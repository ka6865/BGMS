import "server-only";
import { unstable_cache } from "next/cache";
import { getLolMasterPublication, getLolRankingPublication } from "./persistence.server";
import { toPublicMasterBoard, toPublicRankingBoard } from "./ranking";

// 게시본은 수집기가 주기적으로 바꾼다. 수집기는 Next 밖에서 돌아 태그를 비울 수 없으므로 시간 기준으로 1시간마다 다시 읽는다.
const REVALIDATE_SECONDS = 3600;

export const getCachedLolRankingBoard = unstable_cache(async () => {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return null;
  return toPublicRankingBoard(await getLolRankingPublication());
}, ["lol-ranking-board-v1"], { revalidate: REVALIDATE_SECONDS });

export const getCachedLolMasterBoard = unstable_cache(async () => {
  if (process.env.LOL_PERSISTENCE_ENABLED !== "true") return null;
  return toPublicMasterBoard(await getLolMasterPublication());
}, ["lol-master-board-v2"], { revalidate: REVALIDATE_SECONDS });
