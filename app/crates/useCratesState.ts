import { useState, useEffect, useRef } from "react";
import type { CrateTemplate } from "@/types/crates";
import { drawSingleItem, drawSinglePrimeItem, tryDrawBonusItem } from "../../lib/crateUtils";
import { CraftableItem, DrawnCard, HistoryItem } from "./types";
import { trackEvent } from "../../lib/analytics";
import { toast } from "sonner";

// 개봉 연출 길이. 화물(loot_crate)은 낙하·착지 장면이 있어 흔들림 연출보다 길다.
const CRATE_SHAKE_DURATION_MS = 1500;
export const CARGO_DROP_DURATION_MS = 2200;
// 보급고 화물 티켓 BP 구매 규칙 (공식 공지: 1장 10,000 BP, 계정당 최대 50장)
export const CRATE_TICKET_BP_PRICE = 10000;
export const CRATE_TICKET_BP_LIMIT = 50;
// 무제한 모드에서 G코인·BP·이벤트 토큰을 고정하는 잔액
const UNLIMITED_BALANCE = 999_999_999;

function getOpeningDuration(crate: Pick<CrateTemplate, "type">) {
  return crate.type === "loot_crate" ? CARGO_DROP_DURATION_MS : CRATE_SHAKE_DURATION_MS;
}

function getRewardKey(item: { asset_key?: string | null; name: string }) {
  return item.asset_key || item.name;
}

interface UseCratesStateProps {
  initialCrates: CrateTemplate[];
  selectedCrateId: string;
}

export function useCratesState({ initialCrates, selectedCrateId }: UseCratesStateProps) {
  // activeCrate 템플릿 탐색
  const activeCrate = initialCrates.find((c) => c.id === selectedCrateId);

  // 지연 정산 타이머 레퍼런스
  const activeTimersRef = useRef<{ id: number; timer: NodeJS.Timeout; action: () => void }[]>([]);
  const timerCounterRef = useRef<number>(0);

  // 진행 중인 모든 지연 자산 정산 타이머 즉시 실행 및 클리어
  const flushActiveTimers = () => {
    if (activeTimersRef.current.length > 0) {
      activeTimersRef.current.forEach((t) => {
        clearTimeout(t.timer);
        t.action();
      });
      activeTimersRef.current = [];
    }
  };

  // 아직 안 뒤집힌 카드나 타이머 대기 중인 카드가 남아있는지 체크
  const hasPendingOrUnrevealedCards = (): boolean => {
    if (activeTimersRef.current.length > 0) return true;
    const hasUnrevealed = revealedCards.some((rev) => !rev);
    return hasUnrevealed && drawnCards.length > 0;
  };

  // 단일 카드 보상 자산 상태 반영 헬퍼 함수
  const applyCardReward = (card: DrawnCard) => {
    if (!activeCrate) return;

    let extraCrates = 0;
    let extraTokens = 0;
    let extraPrimes = 0;
    const skinsToObtain: Record<string, number> = {};
    const newHistory: HistoryItem[] = [];
    let ultimate = 0;
    let legendary = 0;
    let epic = 0;
    let rare = 0;
    let special = 0;
    let common = 0;

    // 1. 기본 카드 정산
    if (card.isFromPrimeParcel) {
      if (card.name.includes("토큰")) {
        const tokenMatch = card.name.match(/x(\d+)/);
        const tokenAmount = tokenMatch ? parseInt(tokenMatch[1], 10) : 0;
        extraTokens += tokenAmount;
      } else {
        skinsToObtain[getRewardKey(card)] = 1;
      }
    } else {
      if (card.is_prime_parcel) {
        extraPrimes += 1;
      } else if (card.token_count && card.token_count > 0) {
        extraTokens += card.token_count;
      } else {
        skinsToObtain[getRewardKey(card)] = 1;
      }
    }

    if (card.rarity === "ULTIMATE") ultimate += 1;
    else if (card.rarity === "LEGENDARY") legendary += 1;
    else if (card.rarity === "EPIC") epic += 1;
    else if (card.rarity === "RARE") rare += 1;
    else if (card.rarity === "SPECIAL") special += 1;
    else if (card.rarity === "COMMON") common += 1;

    newHistory.push({
      id: card.id,
      name: card.name,
      rarity: card.rarity,
      image_url: card.image_url,
      isFromPrimeParcel: card.isFromPrimeParcel,
      isBonus: false,
      timestamp: new Date(),
    });

    // 2. 보너스 카드 정산
    if (card.bonus) {
      const bonus = card.bonus;
      if (bonus.is_extra_crate) extraCrates += 1;
      if (bonus.token_count > 0) extraTokens += bonus.token_count;
      if (bonus.is_prime_parcel) extraPrimes += 1;

      if (bonus.rarity === "ULTIMATE") ultimate += 1;
      else if (bonus.rarity === "LEGENDARY") legendary += 1;
      else if (bonus.rarity === "EPIC") epic += 1;
      else if (bonus.rarity === "RARE") rare += 1;
      else if (bonus.rarity === "SPECIAL") special += 1;
      else if (bonus.rarity === "COMMON") common += 1;

      newHistory.push({
        id: bonus.id,
        name: bonus.name,
        rarity: bonus.rarity,
        image_url: bonus.image_url,
        isFromPrimeParcel: false,
        isBonus: true,
        timestamp: new Date(),
      });
    }

    // 상태 업데이트 적용
    if (Object.keys(skinsToObtain).length > 0) {
      setObtainedSkins((prev) => {
        const next = { ...prev };
        Object.entries(skinsToObtain).forEach(([name, count]) => {
          next[name] = (next[name] || 0) + count;
        });
        return next;
      });
    }

    if (extraCrates > 0) {
      setInventoryCrates((prev) => ({
        ...prev,
        [activeCrate.id]: (prev[activeCrate.id] || 0) + extraCrates
      }));
    }
    if (extraTokens > 0) setTokens((prev) => prev + extraTokens);
    if (extraPrimes > 0) setPrimeParcels((prev) => prev + extraPrimes);
    
    setHistory((prev) => [...newHistory, ...prev]);

    setStats((prev) => ({
      ...prev,
      ultimateCount: prev.ultimateCount + ultimate,
      legendaryCount: prev.legendaryCount + legendary,
      epicCount: prev.epicCount + epic,
      rareCount: prev.rareCount + rare,
      specialCount: prev.specialCount + special,
      commonCount: prev.commonCount + common,
    }));
  };

  // 가상 재화 상태 (기본 제공: 100만 BP, 0 G-Coin)
  const [bp, setBp] = useState<number>(1000000);
  const [gcoin, setGcoin] = useState<number>(0);
  
  // 밀수품 쿠폰 보유 및 주간 구매 제한 상태
  const [coupons, setCoupons] = useState<number>(0);
  const [couponWeeklyBuyCount, setCouponWeeklyBuyCount] = useState<number>(0);
  const [contrabandTenDrawCompleted, setContrabandTenDrawCompleted] = useState<Record<string, boolean>>({});

  // 인벤토리 보유 상태 (각 상자 템플릿별 보유 수량)
  const [inventoryCrates, setInventoryCrates] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    initialCrates.forEach((c) => {
      initial[c.id] = 0;
    });
    return initial;
  });
  
  // 공용 획득 재화 상태
  const [primeParcels, setPrimeParcels] = useState<number>(0);
  const [tokens, setTokens] = useState<number>(0);

  // 무제한 모드: 켜는 동안 재화 잔액을 고정하고 구매 한도를 무시한다. 끄면 켜기 전 잔액으로 돌아간다.
  const [isUnlimited, setIsUnlimited] = useState<boolean>(false);
  const balanceBeforeUnlimitedRef = useRef<{ bp: number; gcoin: number; tokens: number } | null>(null);
  useEffect(() => {
    if (!isUnlimited) return;
    if (bp !== UNLIMITED_BALANCE) setBp(UNLIMITED_BALANCE);
    if (gcoin !== UNLIMITED_BALANCE) setGcoin(UNLIMITED_BALANCE);
    if (tokens !== UNLIMITED_BALANCE) setTokens(UNLIMITED_BALANCE);
  }, [isUnlimited, bp, gcoin, tokens]);

  const toggleUnlimited = () => {
    if (isUnlimited) {
      const saved = balanceBeforeUnlimitedRef.current;
      if (saved) {
        setBp(saved.bp);
        setGcoin(saved.gcoin);
        setTokens(saved.tokens);
      }
      balanceBeforeUnlimitedRef.current = null;
      setIsUnlimited(false);
      toast.success("무제한 모드를 껐습니다. 켜기 전 잔액으로 돌아갑니다.");
    } else {
      balanceBeforeUnlimitedRef.current = { bp, gcoin, tokens };
      setIsUnlimited(true);
      toast.success("무제한 모드를 켰습니다. 재화와 구매 한도 없이 열고 제작할 수 있습니다.");
    }
  };
  
  // 소모 및 결제 지표 트래킹
  const [spentUsd, setSpentUsd] = useState<number>(0);
  const [spentGcoin, setSpentGcoin] = useState<number>(0);
  const [spentBp, setSpentBp] = useState<number>(0);
  const [chargeCount, setChargeCount] = useState<number>(0);

  // 충전 모달 제어 상태
  const [isChargeModalOpen, setIsChargeModalOpen] = useState<boolean>(false);

  // 단품 구매 수량 선택 모달 상태

  // BP 구매 평생 한도 (50회 제한)
  const [bpBuyCount, setBpBuyCount] = useState<number>(0);
  // 보급고 화물 티켓은 상자별로 BP 구매 한도를 센다.
  const [crateTicketBuyCounts, setCrateTicketBuyCounts] = useState<Record<string, number>>({});
  const [blackmarketTickets, setBlackmarketTickets] = useState<number>(0);

  // 이벤트 재화 보충기 모달 상태
  const [isRefillModalOpen, setIsRefillModalOpen] = useState<boolean>(false);
  const [refillType, setRefillType] = useState<"gcoin" | "bp" | "coupon" | "crate">("gcoin");
  const [refillAmount, setRefillAmount] = useState<number>(10000);

  // 시뮬레이터 초기화 모달 상태
  const [isResetModalOpen, setIsResetModalOpen] = useState<boolean>(false);

  // 가챠 연출 상태
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [hasBonusEffect, setHasBonusEffect] = useState<boolean>(false);
  const [drawMode, setDrawMode] = useState<"standard" | "prime">("standard");
  const [drawnCards, setDrawnCards] = useState<DrawnCard[]>([]);
  const [revealedCards, setRevealedCards] = useState<boolean[]>([]);

  // 최종 획득 스킨 컬렉션 상태
  const [obtainedSkins, setObtainedSkins] = useState<Record<string, number>>({});

  // 가상 뽑기 히스토리
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [stats, setStats] = useState({
    totalOpens: 0,
    primeParcelOpens: 0,
    ultimateCount: 0,
    legendaryCount: 0,
    epicCount: 0,
    rareCount: 0,
    specialCount: 0,
    commonCount: 0,
  });

  // 아직 뒤집히지 않은 이전 카드의 자산, 컬렉션, 히스토리, 통계를 일괄 정산하는 헬퍼 함수 (지연 정산 지원)
  const collectRemainingCards = (delayMs?: number) => {
    // 1. 지연 대기 중인 모든 타이머 자산 강제 즉시 실행
    flushActiveTimers();

    // 2. 뒤집히지 않은 카드 정산
    if (drawnCards.length === 0) return;

    let extraCrates = 0;
    let extraTokens = 0;
    let extraPrimes = 0;
    const newHistory: HistoryItem[] = [];
    const skinsToObtain: Record<string, number> = {};
    let ultimate = 0;
    let legendary = 0;
    let epic = 0;
    let rare = 0;
    let special = 0;
    let common = 0;

    drawnCards.forEach((card, idx) => {
      if (!revealedCards[idx]) {
        // 1. 기본 카드 정산
        if (card.isFromPrimeParcel) {
          if (card.name.includes("토큰")) {
            const tokenMatch = card.name.match(/x(\d+)/);
            const tokenAmount = tokenMatch ? parseInt(tokenMatch[1], 10) : 0;
            extraTokens += tokenAmount;
          } else {
            const rewardKey = getRewardKey(card);
            skinsToObtain[rewardKey] = (skinsToObtain[rewardKey] || 0) + 1;
          }
        } else {
          if (card.is_prime_parcel) {
            extraPrimes += 1;
          } else if (card.token_count && card.token_count > 0) {
            extraTokens += card.token_count;
          } else {
            const rewardKey = getRewardKey(card);
            skinsToObtain[rewardKey] = (skinsToObtain[rewardKey] || 0) + 1;
          }
        }

        if (card.rarity === "ULTIMATE") ultimate += 1;
        else if (card.rarity === "LEGENDARY") legendary += 1;
        else if (card.rarity === "EPIC") epic += 1;
        else if (card.rarity === "RARE") rare += 1;
        else if (card.rarity === "SPECIAL") special += 1;
        else if (card.rarity === "COMMON") common += 1;

        newHistory.push({
          id: card.id,
          name: card.name,
          rarity: card.rarity,
          image_url: card.image_url,
          isFromPrimeParcel: card.isFromPrimeParcel,
          isBonus: false,
          timestamp: new Date(),
        });

        // 2. 보너스 카드 정산
        if (card.bonus) {
          if (card.bonus.is_extra_crate) extraCrates += 1;
          if (card.bonus.token_count > 0) extraTokens += card.bonus.token_count;
          if (card.bonus.is_prime_parcel) extraPrimes += 1;

          if (card.bonus.rarity === "ULTIMATE") ultimate += 1;
          else if (card.bonus.rarity === "LEGENDARY") legendary += 1;
          else if (card.bonus.rarity === "EPIC") epic += 1;
          else if (card.bonus.rarity === "RARE") rare += 1;
          else if (card.bonus.rarity === "SPECIAL") special += 1;
          else if (card.bonus.rarity === "COMMON") common += 1;

          newHistory.push({
            id: card.bonus.id,
            name: card.bonus.name,
            rarity: card.bonus.rarity,
            image_url: card.bonus.image_url,
            isFromPrimeParcel: false,
            isBonus: true,
            timestamp: new Date(),
          });
        }
      }
    });

    const runAssetUpdate = () => {
      if (Object.keys(skinsToObtain).length > 0) {
        setObtainedSkins((prev) => {
          const next = { ...prev };
          Object.entries(skinsToObtain).forEach(([name, count]) => {
            next[name] = (next[name] || 0) + count;
          });
          return next;
        });
      }

      if (activeCrate && extraCrates > 0) {
        setInventoryCrates((prev) => ({
          ...prev,
          [activeCrate.id]: (prev[activeCrate.id] || 0) + extraCrates
        }));
      }
      if (extraTokens > 0) setTokens((prev) => prev + extraTokens);
      if (extraPrimes > 0) setPrimeParcels((prev) => prev + extraPrimes);

      if (newHistory.length > 0) {
        setHistory((prev) => [...newHistory, ...prev]);
      }

      if (ultimate > 0 || legendary > 0 || epic > 0 || rare > 0 || special > 0 || common > 0) {
        setStats((prev) => ({
          ...prev,
          ultimateCount: prev.ultimateCount + ultimate,
          legendaryCount: prev.legendaryCount + legendary,
          epicCount: prev.epicCount + epic,
          rareCount: prev.rareCount + rare,
          specialCount: prev.specialCount + special,
          commonCount: prev.commonCount + common,
        }));
      }
    };

    // 일괄 정산했으므로 카드 상태는 즉시 revealed 상태로 전환
    setRevealedCards(new Array(drawnCards.length).fill(true));

    if (delayMs && delayMs > 0) {
      timerCounterRef.current += 1;
      const timerId = timerCounterRef.current;
      const timer = setTimeout(() => {
        runAssetUpdate();
        activeTimersRef.current = activeTimersRef.current.filter((t) => t.id !== timerId);
      }, delayMs);

      activeTimersRef.current.push({
        id: timerId,
        timer,
        action: runAssetUpdate,
      });
    } else {
      runAssetUpdate();
    }
  };

  // G-Coin 패키지 가상 결제 (다중 금액대 충전 지원)
  const handleChargeGCoin = (amount: number, price: number) => {
    setGcoin((prev) => prev + amount);
    setSpentUsd((prev) => prev + price);
    setChargeCount((prev) => prev + 1);
    setIsChargeModalOpen(false); // 충전 완료 후 자동으로 모달을 닫음
  };



  // UI 탭 제어 관련 콜백을 위한 상태 주입 레퍼런스
  const [drawSubTab, setDrawSubTab] = useState<"shop" | "inventory">("shop");
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<"loot_crate" | "prime_parcel" | "coupon">("loot_crate");

  // selectedCrateId가 변경될 때 보관함 선택 상태 동기화 및 개봉 상태 초기화
  useEffect(() => {
    setDrawnCards([]);
    setIsDrawing(false);
    if (activeCrate) {
      if (activeCrate.type === "loot_crate") {
        setSelectedInventoryItem("loot_crate");
      } else {
        setSelectedInventoryItem("coupon");
      }
    }
  }, [selectedCrateId]);

  // 보급고 화물 티켓 BP 구매. 티켓은 상자별 보관 수량으로 쌓이고 상점에서 먼저 사용된다.
  const handleBuyCrateTickets = (count: number) => {
    if (!activeCrate || activeCrate.type !== "loot_crate") return;
    const bought = crateTicketBuyCounts[activeCrate.id] || 0;
    if (!isUnlimited && bought + count > CRATE_TICKET_BP_LIMIT) {
      toast.warning(`BP 구매 한도(${CRATE_TICKET_BP_LIMIT}장)를 초과할 수 없습니다. (현재 구매: ${bought}/${CRATE_TICKET_BP_LIMIT}장)`);
      return;
    }
    const price = CRATE_TICKET_BP_PRICE * count;
    if (bp < price) {
      toast.error("보유 가상 BP가 부족합니다. 미션 수행 등으로 추가 BP를 확보하세요.");
      return;
    }
    setBp((prev) => prev - price);
    setSpentBp((prev) => prev + price);
    setCrateTicketBuyCounts((prev) => ({ ...prev, [activeCrate.id]: bought + count }));
    setInventoryCrates((prev) => ({
      ...prev,
      [activeCrate.id]: (prev[activeCrate.id] || 0) + count,
    }));
    toast.success(`${activeCrate.name} 티켓 ${count}장 구매가 완료되었습니다. (보유: ${((inventoryCrates[activeCrate.id] || 0) + count).toLocaleString()}장)`);
  };


  const handleOpenInventoryCrates = (mode: "one" | "ten") => {
    if (!activeCrate) return;
    const currentCrateCount = inventoryCrates[activeCrate.id] || 0;
    const countToOpen = mode === "ten" ? 10 : 1;

    if (currentCrateCount < countToOpen) {
      toast.error(`보유한 상자가 부족합니다. (현재 보유: ${currentCrateCount}개)`);
      return;
    }

    // 이전 뽑기 결과 중 뒤집히지 않은 카드 또는 타이머가 남아있는지 판별
    const needsCollect = hasPendingOrUnrevealedCards();

    const openingDurationMs = getOpeningDuration(activeCrate);
    if (needsCollect) {
      // 새 개봉 연출이 끝나는 시점으로 지연 정산 예약
      collectRemainingCards(openingDurationMs);
    }
    
    const startDraw = () => {
      // GA4 트래킹: 상자 개봉 기록
      trackEvent({
        name: "crate_opened",
        params: {
          crate_id: activeCrate.id,
          open_count: countToOpen
        }
      });
      setIsDrawing(true);
      setDrawMode("standard");
      
      // 차감
      setInventoryCrates((prev) => ({
        ...prev,
        [activeCrate.id]: prev[activeCrate.id] - countToOpen
      }));
      // 화물 티켓으로 열 때도 G코인 개봉과 같은 개봉당 이벤트 토큰을 지급한다.
      if (activeCrate.type === "loot_crate") {
        setTokens((prev) => prev + (activeCrate.bonus_amount_single || 0) * countToOpen);
      }

      const results: DrawnCard[] = [];
      let hasBonusWon = false;

      for (let i = 0; i < countToOpen; i++) {
        // 1. 기본 아이템 드롭 (100%)
        const baseItem = drawSingleItem(activeCrate.items);
        const card: DrawnCard = {
          id: crypto.randomUUID(),
          name: baseItem.name,
          asset_key: baseItem.asset_key,
          normalized_name: baseItem.normalized_name,
          r2_key: baseItem.r2_key,
          asset_id: baseItem.asset_id,
          rarity: baseItem.rarity,
          image_url: baseItem.image_url,
          isFromPrimeParcel: false,
          isBonus: false,
          is_prime_parcel: baseItem.is_prime_parcel,
          token_count: baseItem.token_count,
          probability: baseItem.probability,
        };

        // 2. 보너스 아이템 드롭 검사 (27.00%)
        if (activeCrate.bonus_items && activeCrate.bonus_items.length > 0) {
          const bonusItem = tryDrawBonusItem(activeCrate.bonus_items);
          if (bonusItem) {
            hasBonusWon = true;
            
            card.bonus = {
              id: crypto.randomUUID(),
              name: bonusItem.name,
              asset_key: bonusItem.asset_key,
              normalized_name: bonusItem.normalized_name,
              r2_key: bonusItem.r2_key,
              asset_id: bonusItem.asset_id,
              rarity: bonusItem.is_prime_parcel 
                ? "ULTIMATE" 
                : bonusItem.name.includes("획득권") 
                  ? "EPIC" 
                  : bonusItem.is_extra_crate 
                    ? "RARE" 
                    : "LEGENDARY",
              image_url: bonusItem.image_url,
              is_prime_parcel: bonusItem.is_prime_parcel,
              is_extra_crate: bonusItem.is_extra_crate,
              token_count: bonusItem.token_count,
              probability: bonusItem.probability,
            };
          }
        }

        results.push(card);
      }

      setHasBonusEffect(hasBonusWon);
      setDrawnCards(results);
      setRevealedCards(new Array(results.length).fill(false));

      setTimeout(() => {
        setIsDrawing(false);

        // 오픈전 스포방지: 등급 통계 및 히스토리/컬렉션은 뒤집는 시점에 가산하고, 총 개봉횟수만 즉시 반영
        setStats((prev) => ({
          ...prev,
          totalOpens: prev.totalOpens + countToOpen,
        }));
      }, openingDurationMs);
    };

    // 지연 정산 여부와 무관하게 흔들림 연출은 즉시 시작하여 조작감 유지
    startDraw();
  };

  // 최고급 꾸러미 개봉 (이중 가챠 2단계 - 다량 개봉 지원)
  const handleOpenPrimeParcel = (count: number | "all") => {
    const countToOpen = count === "all" ? primeParcels : count;
    if (countToOpen <= 0) return;
    if (primeParcels < countToOpen || !activeCrate || activeCrate.prime_parcel_items.length === 0) return;

    // 이전 뽑기 결과 중 뒤집히지 않은 카드 또는 타이머가 남아있는지 판별
    const needsCollect = hasPendingOrUnrevealedCards();

    if (needsCollect) {
      // 1.5초 지연 정산 실행 (새로운 흔들림 연출이 끝나는 1500ms 뒤로 예약)
      collectRemainingCards(1500);
    }

    const startDraw = () => {
      // GA4 트래킹: 꾸러미 개봉 기록
      trackEvent({
        name: "crate_opened",
        params: {
          crate_id: `${activeCrate.id}_prime_parcel`,
          open_count: countToOpen
        }
      });
      setIsDrawing(true);
      setDrawMode("prime");
      setHasBonusEffect(false); // 꾸러미 개봉은 일반 금색 연출 제외
      setPrimeParcels((prev) => prev - countToOpen);

      const results: DrawnCard[] = [];
      for (let i = 0; i < countToOpen; i++) {
        const result = drawSinglePrimeItem(activeCrate.prime_parcel_items);
        results.push({
          id: crypto.randomUUID(),
          name: result.name,
          asset_key: result.asset_key,
          normalized_name: result.normalized_name,
          r2_key: result.r2_key,
          asset_id: result.asset_id,
          rarity: result.rarity,
          image_url: result.image_url,
          isBonus: false,
          isFromPrimeParcel: true,
          probability: result.probability,
        });
      }

      setDrawnCards(results);
      setRevealedCards(new Array(results.length).fill(false));

      setTimeout(() => {
        setIsDrawing(false);
        
        // 오픈전 스포방지: 등급 통계 및 히스토리/컬렉션은 뒤집는 시점에 가산하고, 총 꾸러미 개봉횟수만 즉시 반영
        setStats((prev) => ({
          ...prev,
          primeParcelOpens: prev.primeParcelOpens + countToOpen,
        }));
      }, 1500);
    };

    // 지연 정산 여부와 무관하게 흔들림 연출은 즉시 시작하여 조작감 유지
    startDraw();
  };

  // 카드 즉시 공개 (스포 방지 자산 획득)
  const handleCardClick = (index: number) => {
    if (revealedCards[index]) return;

    setRevealedCards((prev) => {
      const next = [...prev];
      next[index] = true;
      return next;
    });

    const card = drawnCards[index];
    if (card && activeCrate) {
      timerCounterRef.current += 1;
      const timerId = timerCounterRef.current;
      const timer = setTimeout(() => {
        applyCardReward(card);
        activeTimersRef.current = activeTimersRef.current.filter((t) => t.id !== timerId);
      }, 800); // 카드가 시각적으로 뒤집어진 후(800ms)에 자산이 반영되도록 지연 시간 보정

      activeTimersRef.current.push({
        id: timerId,
        timer,
        action: () => applyCardReward(card),
      });
    }
  };

  // 모든 카드 한 번에 공개 (스포 방지 자산 일괄 획득)
  const handleRevealAll = () => {
    if (!activeCrate) return;

    // 현재 타이머 돌고 있는 카드들이 있다면 먼저 다 정산 처리
    flushActiveTimers();

    const cardsToReveal: DrawnCard[] = [];
    const nextRevealed = [...revealedCards];

    drawnCards.forEach((card, idx) => {
      if (!revealedCards[idx]) {
        nextRevealed[idx] = true;
        cardsToReveal.push(card);
      }
    });

    if (cardsToReveal.length === 0) return;

    setRevealedCards(nextRevealed);

    timerCounterRef.current += 1;
    const timerId = timerCounterRef.current;
    const timer = setTimeout(() => {
      cardsToReveal.forEach((card) => {
        applyCardReward(card);
      });
      activeTimersRef.current = activeTimersRef.current.filter((t) => t.id !== timerId);
    }, 800); // 카드가 시각적으로 뒤집어진 후(800ms)에 자산이 반영되도록 지연 시간 보정

    activeTimersRef.current.push({
      id: timerId,
      timer,
      action: () => {
        cardsToReveal.forEach((card) => {
          applyCardReward(card);
        });
      },
    });
  };

  // 밀수품 상자 G-Coin 직접 즉시 개봉용 공통 드롭 연출 헬퍼
  const drawContrabandCratesDirect = (countToOpen: number) => {
    if (!activeCrate) return;

    const needsCollect = hasPendingOrUnrevealedCards();
    if (needsCollect) {
      collectRemainingCards(1500);
    }
    
    const startDraw = () => {
      // GA4 트래킹: 상자 개봉 기록
      trackEvent({
        name: "crate_opened",
        params: {
          crate_id: activeCrate.id,
          open_count: countToOpen
        }
      });
      setIsDrawing(true);
      setDrawMode("standard");

      const results: DrawnCard[] = [];
      let hasBonusWon = false;

      for (let i = 0; i < countToOpen; i++) {
        const baseItem = drawSingleItem(activeCrate.items);
        const card: DrawnCard = {
          id: crypto.randomUUID(),
          name: baseItem.name,
          asset_key: baseItem.asset_key,
          normalized_name: baseItem.normalized_name,
          r2_key: baseItem.r2_key,
          asset_id: baseItem.asset_id,
          rarity: baseItem.rarity,
          image_url: baseItem.image_url,
          isFromPrimeParcel: false,
          isBonus: false,
          is_prime_parcel: baseItem.is_prime_parcel,
          token_count: baseItem.token_count,
          probability: baseItem.probability,
        };

        if (activeCrate.bonus_items && activeCrate.bonus_items.length > 0) {
          const bonusItem = tryDrawBonusItem(activeCrate.bonus_items);
          if (bonusItem) {
            hasBonusWon = true;
            
            card.bonus = {
              id: crypto.randomUUID(),
              name: bonusItem.name,
              asset_key: bonusItem.asset_key,
              normalized_name: bonusItem.normalized_name,
              r2_key: bonusItem.r2_key,
              asset_id: bonusItem.asset_id,
              rarity: bonusItem.is_prime_parcel 
                ? "ULTIMATE" 
                : bonusItem.name.includes("획득권") 
                  ? "EPIC" 
                  : bonusItem.is_extra_crate 
                    ? "RARE" 
                    : "LEGENDARY",
              image_url: bonusItem.image_url,
              is_prime_parcel: bonusItem.is_prime_parcel,
              is_extra_crate: bonusItem.is_extra_crate,
              token_count: bonusItem.token_count,
              probability: bonusItem.probability,
            };
          }
        }

        results.push(card);
      }

      setHasBonusEffect(hasBonusWon);
      setDrawnCards(results);
      setRevealedCards(new Array(results.length).fill(false));

      setTimeout(() => {
        setIsDrawing(false);
        setStats((prev) => ({
          ...prev,
          totalOpens: prev.totalOpens + countToOpen,
        }));
      }, 1500);
    };

    startDraw();
  };

  // 밀수품 상자 G-Coin 직접 즉시 개봉 핸들러
  const handleOpenContrabandCrateWithGCoin = (mode: "one" | "ten") => {
    if (!activeCrate) return;
    
    let price = 0;
    let countToOpen = 0;
    
    if (mode === "one") {
      price = 200;
      countToOpen = 1;
    } else if (mode === "ten") {
      const isCompleted = contrabandTenDrawCompleted[activeCrate.id] || false;
      price = isCompleted ? 1800 : 1000;
      countToOpen = 10;
    }

    if (gcoin < price) {
      toast.error("보유 가상 G-Coin이 부족합니다. 상단의 충전 버튼을 이용해주세요.");
      return;
    }

    // G-Coin 및 소모액 차감
    setGcoin((prev) => prev - price);
    setSpentGcoin((prev) => prev + price);
    if (mode === "ten") {
      setContrabandTenDrawCompleted((prev) => ({
        ...prev,
        [activeCrate.id]: true
      }));
    }

    drawContrabandCratesDirect(countToOpen);
  };

  // 밀수품 쿠폰 개봉 핸들러 (1회, 5회, 10회, 전체 지원)
  const handleOpenContrabandWithCoupons = (mode: "one" | "ten") => {
    if (!activeCrate) return;
    
    if (activeCrate.type !== "contraband") {
      toast.warning("밀수품 쿠폰은 밀수품 상자(Contraband Crate) 개봉에만 사용할 수 있습니다. 상점 라인업에서 밀수품 상자를 선택해 주세요.");
      return;
    }
    
    const countToOpen = mode === "ten" ? 10 : 1;
    const couponsNeeded = countToOpen * 10;

    if (coupons < couponsNeeded) {
      toast.error(`밀수품 쿠폰이 부족합니다. (최소 ${couponsNeeded}장 필요, 현재 보유: ${coupons}장)`);
      return;
    }

    const needsCollect = hasPendingOrUnrevealedCards();
    if (needsCollect) {
      collectRemainingCards(1500);
    }
    
    const startDraw = () => {
      // GA4 트래킹: 상자 개봉 기록
      trackEvent({
        name: "crate_opened",
        params: {
          crate_id: activeCrate.id,
          open_count: countToOpen
        }
      });
      setIsDrawing(true);
      setDrawMode("standard");
      
      // 쿠폰 차감
      setCoupons((prev) => prev - couponsNeeded);

      const results: DrawnCard[] = [];
      let hasBonusWon = false;

      for (let i = 0; i < countToOpen; i++) {
        const baseItem = drawSingleItem(activeCrate.items);
        const card: DrawnCard = {
          id: crypto.randomUUID(),
          name: baseItem.name,
          asset_key: baseItem.asset_key,
          normalized_name: baseItem.normalized_name,
          r2_key: baseItem.r2_key,
          asset_id: baseItem.asset_id,
          rarity: baseItem.rarity,
          image_url: baseItem.image_url,
          isFromPrimeParcel: false,
          isBonus: false,
          is_prime_parcel: baseItem.is_prime_parcel,
          token_count: baseItem.token_count,
          probability: baseItem.probability,
        };

        if (activeCrate.bonus_items && activeCrate.bonus_items.length > 0) {
          const bonusItem = tryDrawBonusItem(activeCrate.bonus_items);
          if (bonusItem) {
            hasBonusWon = true;
            card.bonus = {
              id: crypto.randomUUID(),
              name: bonusItem.name,
              asset_key: bonusItem.asset_key,
              normalized_name: bonusItem.normalized_name,
              r2_key: bonusItem.r2_key,
              asset_id: bonusItem.asset_id,
              rarity: bonusItem.is_prime_parcel 
                ? "ULTIMATE" 
                : bonusItem.name.includes("획득권") 
                  ? "EPIC" 
                  : bonusItem.is_extra_crate 
                    ? "RARE" 
                    : "LEGENDARY",
              image_url: bonusItem.image_url,
              is_prime_parcel: bonusItem.is_prime_parcel,
              is_extra_crate: bonusItem.is_extra_crate,
              token_count: bonusItem.token_count,
              probability: bonusItem.probability,
            };
          }
        }

        results.push(card);
      }

      setHasBonusEffect(hasBonusWon);
      setDrawnCards(results);
      setRevealedCards(new Array(results.length).fill(false));

      setTimeout(() => {
        setIsDrawing(false);
        setStats((prev) => ({
          ...prev,
          totalOpens: prev.totalOpens + countToOpen,
        }));
      }, 1500);
    };

    startDraw();
  };

  // 밀수품 쿠폰 구매 핸들러
  const handleBuyCoupons = (count: number) => {
    const price = 800 * count;
    if (bp < price) {
      toast.error("보유 가상 BP가 부족합니다. 미션 수행 등으로 추가 BP를 확보하세요.");
      return;
    }
    if (!isUnlimited && couponWeeklyBuyCount + count > 50) {
      toast.warning(`주간 밀수품 쿠폰 구매 한도(50장)를 초과할 수 없습니다. (현재 이번 주 구매 수량: ${couponWeeklyBuyCount}/50장)`);
      return;
    }
    setBp((prev) => prev - price);
    setSpentBp((prev) => prev + price);
    setCoupons((prev) => prev + count);
    setCouponWeeklyBuyCount((prev) => prev + count);

    // 구매 완료 알림 제공
    toast.success(`밀수품 쿠폰 ${count}장 구매가 완료되었습니다. (보유: ${coupons + count}장)`);
  };

  // 재화 무한 충전 실행기 핸들러
  const handleRefillAsset = () => {
    if (refillAmount <= 0) {
      toast.warning("보충할 요율 수량은 1 이상이어야 합니다.");
      return;
    }
    if (refillType === "gcoin") {
      setGcoin((prev) => prev + refillAmount);
    } else if (refillType === "bp") {
      setBp((prev) => prev + refillAmount);
    } else if (refillType === "coupon") {
      setCoupons((prev) => prev + refillAmount);
    } else if (refillType === "crate") {
      if (!activeCrate) return;
      setInventoryCrates((prev) => ({
        ...prev,
        [activeCrate.id]: (prev[activeCrate.id] || 0) + refillAmount,
      }));
    }
    setIsRefillModalOpen(false);
  };



  // 시뮬레이터 완전 초기화 모달 트리거
  const handleResetSimulator = () => {
    setIsResetModalOpen(true);
  };

  // 실제 시뮬레이터 초기화 동작
  const executeResetSimulator = () => {
    setIsUnlimited(false);
    balanceBeforeUnlimitedRef.current = null;
    // 대기 중인 모든 타이머 취소
    activeTimersRef.current.forEach((t) => clearTimeout(t.timer));
    activeTimersRef.current = [];

    setBp(1000000);
    setGcoin(0);
    setCoupons(0);
    setCouponWeeklyBuyCount(0);
    setContrabandTenDrawCompleted({});
    setInventoryCrates(() => {
      const initial: Record<string, number> = {};
      initialCrates.forEach((c) => {
        initial[c.id] = 0;
      });
      return initial;
    });
    setPrimeParcels(0);
    setTokens(0);
    setSpentUsd(0);
    setSpentGcoin(0);
    setSpentBp(0);
    setChargeCount(0);
    setBpBuyCount(0);
    setCrateTicketBuyCounts({});
    setBlackmarketTickets(0);
    setDrawnCards([]);
    setRevealedCards([]);
    setHistory([]);
    setObtainedSkins({});
    setStats({
      totalOpens: 0,
      primeParcelOpens: 0,
      ultimateCount: 0,
      legendaryCount: 0,
      epicCount: 0,
      rareCount: 0,
      specialCount: 0,
      commonCount: 0,
    });
    setIsResetModalOpen(false);
    toast.success("시뮬레이터가 초기화되었습니다.");
  };

  // 특수 제작 처리 핸들러
  const handleCraftItem = (item: CraftableItem) => {
    const { name: itemName, tokenCost } = item;
    if (tokens < tokenCost) {
      toast.error(`보유한 이벤트 토큰이 부족합니다. (필요: ${tokenCost.toLocaleString()}개, 보유: ${tokens.toLocaleString()}개)`);
      return false;
    }
    setTokens((prev) => prev - tokenCost);

    // 화물 티켓 제작은 소장품이 아니라 현재 보급고의 티켓으로 지급한다.
    if (itemName.endsWith("화물 티켓") && activeCrate?.type === "loot_crate") {
      setInventoryCrates((prev) => ({
        ...prev,
        [activeCrate.id]: (prev[activeCrate.id] || 0) + 1,
      }));
    } else {
      const rewardKey = item.asset_key || itemName;
      setObtainedSkins((prev) => ({
        ...prev,
        [rewardKey]: (prev[rewardKey] || 0) + 1,
      }));
    }

    const craftHistory: HistoryItem = {
      id: crypto.randomUUID(),
      name: `${itemName} (특수 제작)`,
      rarity: item.rarity,
      image_url: item.image_url,
      isFromPrimeParcel: false,
      isBonus: false,
      timestamp: new Date(),
    };

    setHistory((prev) => [craftHistory, ...prev]);
    toast.success(`[${itemName}] 제작에 성공하였습니다!`);
    return true;
  };

  // 2026 블랙 마켓 화물 티켓 구매 핸들러 (BP 사용)
  const handleBuyBlackmarketTickets = (count: number) => {
    if (!activeCrate) return;
    const ticketPrice = (activeCrate.price_bp || 10000) * count;
    const limit = activeCrate.price_bp_limit || 50;

    if (bp < ticketPrice) {
      toast.error("보유 가상 BP가 부족합니다. 미션 수행 등으로 추가 BP를 확보하세요.");
      return;
    }
    if (!isUnlimited && bpBuyCount + count > limit) {
      toast.warning(`BP를 통한 구매 한도(${limit}회)를 초과할 수 없습니다. (현재 구매 횟수: ${bpBuyCount}/${limit}회)`);
      return;
    }

    setBp((prev) => prev - ticketPrice);
    setSpentBp((prev) => prev + ticketPrice);
    setBlackmarketTickets((prev) => prev + count);
    setBpBuyCount((prev) => prev + count);

    toast.success(`2026 블랙 마켓 화물 티켓 ${count}장 구매가 완료되었습니다. (보유: ${blackmarketTickets + count}장)`);
  };

  // 전리품 상자(Loot Crate) 즉시 개봉 핸들러 (G-Coin 또는 티켓 사용)
  const handleOpenLootCrateDirect = (mode: "one" | "ten", paymentMethod: "gcoin" | "ticket") => {
    if (!activeCrate) return;

    let price = 0;
    let countToOpen = 0;
    let bonusAmount = 0;

    if (mode === "one") {
      price = paymentMethod === "gcoin"
        ? (activeCrate.price_gcoin || 250)
        : (activeCrate.ticket_price_single || 1);
      countToOpen = 1;
      bonusAmount = activeCrate.bonus_amount_single || 10;
    } else {
      price = paymentMethod === "gcoin"
        ? (activeCrate.bundle_price_gcoin || 2500)
        : (activeCrate.ticket_price_bundle || 10);
      countToOpen = 10;
      bonusAmount = activeCrate.bonus_amount_bundle || 100;
    }

    if (paymentMethod === "gcoin") {
      if (gcoin < price) {
        toast.error("보유 가상 G-Coin이 부족합니다. 상단의 충전 버튼을 이용해주세요.");
        return;
      }
      setGcoin((prev) => prev - price);
      setSpentGcoin((prev) => prev + price);
    } else {
      const ticketCode = activeCrate.ticket_currency_code || "blackmarket_ticket";
      if (ticketCode === "blackmarket_ticket") {
        if (blackmarketTickets < price) {
          toast.error("보유한 화물 티켓이 부족합니다. BP로 티켓을 구매해보세요.");
          return;
        }
        setBlackmarketTickets((prev) => prev - price);
      } else {
        if (coupons < price) {
          toast.error("보유한 쿠폰이 부족합니다.");
          return;
        }
        setCoupons((prev) => prev - price);
      }
    }

    // 보너스 토큰 지급 (bonus_currency_code 가 blackmarket_token 일 때)
    if (bonusAmount > 0) {
      setTokens((prev) => prev + bonusAmount);
    }

    drawLootCratesDirect(countToOpen);
  };

  // 전리품 상자 즉시 개봉 드롭 연출 헬퍼
  const drawLootCratesDirect = (countToOpen: number) => {
    if (!activeCrate) return;

    const needsCollect = hasPendingOrUnrevealedCards();
    const openingDurationMs = getOpeningDuration(activeCrate);
    if (needsCollect) {
      collectRemainingCards(openingDurationMs);
    }

    const startDraw = () => {
      // GA4 트래킹: 상자 개봉 기록
      trackEvent({
        name: "crate_opened",
        params: {
          crate_id: activeCrate.id,
          open_count: countToOpen
        }
      });
      setIsDrawing(true);
      setDrawMode("standard");

      const results: DrawnCard[] = [];
      let hasBonusWon = false;

      for (let i = 0; i < countToOpen; i++) {
        const baseItem = drawSingleItem(activeCrate.items);
        const card: DrawnCard = {
          id: crypto.randomUUID(),
          name: baseItem.name,
          asset_key: baseItem.asset_key,
          normalized_name: baseItem.normalized_name,
          r2_key: baseItem.r2_key,
          asset_id: baseItem.asset_id,
          rarity: baseItem.rarity,
          image_url: baseItem.image_url,
          isFromPrimeParcel: false,
          isBonus: false,
          is_prime_parcel: baseItem.is_prime_parcel,
          token_count: baseItem.token_count,
          probability: baseItem.probability,
        };

        if (activeCrate.bonus_items && activeCrate.bonus_items.length > 0) {
          const bonusItem = tryDrawBonusItem(activeCrate.bonus_items);
          if (bonusItem) {
            hasBonusWon = true;
            card.bonus = {
              id: crypto.randomUUID(),
              name: bonusItem.name,
              asset_key: bonusItem.asset_key,
              normalized_name: bonusItem.normalized_name,
              r2_key: bonusItem.r2_key,
              asset_id: bonusItem.asset_id,
              rarity: bonusItem.is_prime_parcel
                ? "ULTIMATE"
                : bonusItem.name.includes("획득권")
                  ? "EPIC"
                  : bonusItem.is_extra_crate
                    ? "RARE"
                    : "LEGENDARY",
              image_url: bonusItem.image_url,
              is_prime_parcel: bonusItem.is_prime_parcel,
              is_extra_crate: bonusItem.is_extra_crate,
              token_count: bonusItem.token_count,
              probability: bonusItem.probability,
            };
          }
        }

        results.push(card);
      }

      setHasBonusEffect(hasBonusWon);
      setDrawnCards(results);
      setRevealedCards(new Array(results.length).fill(false));

      setTimeout(() => {
        setIsDrawing(false);
        setStats((prev) => ({
          ...prev,
          totalOpens: prev.totalOpens + countToOpen,
        }));
      }, openingDurationMs);
    };

    startDraw();
  };

  return {
    bp,
    setBp,
    gcoin,
    setGcoin,
    coupons,
    setCoupons,
    couponWeeklyBuyCount,
    contrabandTenDrawCompleted,
    inventoryCrates,
    setInventoryCrates,
    primeParcels,
    setPrimeParcels,
    tokens,
    setTokens,
    spentUsd,
    spentGcoin,
    spentBp,
    chargeCount,
    bpBuyCount,
    blackmarketTickets,
    setBlackmarketTickets,
    isDrawing,
    hasBonusEffect,
    drawMode,
    drawnCards,
    setDrawnCards,
    revealedCards,
    setRevealedCards,
    obtainedSkins,
    setObtainedSkins,
    history,
    stats,
    isChargeModalOpen,
    setIsChargeModalOpen,
    isRefillModalOpen,
    setIsRefillModalOpen,
    refillType,
    setRefillType,
    refillAmount,
    setRefillAmount,
    drawSubTab,
    setDrawSubTab,
    selectedInventoryItem,
    setSelectedInventoryItem,
    
    // 핸들러 함수 모음
    handleChargeGCoin,
    handleBuyCrateTickets,
    crateTicketBuyCounts,
    handleOpenInventoryCrates,
    handleOpenPrimeParcel,
    handleCardClick,
    handleRevealAll,
    handleOpenContrabandCrateWithGCoin,
    handleOpenContrabandWithCoupons,
    handleBuyCoupons,
    handleRefillAsset,
    isUnlimited,
    toggleUnlimited,
    handleResetSimulator,
    collectRemainingCards,
    handleCraftItem,
    handleBuyBlackmarketTickets,
    handleOpenLootCrateDirect,
    isResetModalOpen,
    setIsResetModalOpen,
    executeResetSimulator
  };
}
