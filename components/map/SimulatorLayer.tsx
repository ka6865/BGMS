import React, { useState, useEffect, useRef } from "react";
import { Marker, Polyline, Circle, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

const flightPointIcon = L.divIcon({
  className: "flight-point-sim",
  html: `<div style="width:16px;height:16px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 0 10px #3b82f6;"></div>`,
  iconSize: [16, 16],
});

const MAP_ID_TO_INTERNAL: Record<string, string[]> = {
  "erangel": ["baltic_main", "erangel_main"],
  "miramar": ["desert_main"],
  "taego": ["tiger_main"],
  "sanhok": ["savage_main"],
  "rondo": ["neon_main"],
  "deston": ["kiki_main"],
  "vikendi": ["dihorotok_main"],
  "karakin": ["summerland_main"],
  "paramo": ["chimera_main"],
};

interface SimulatorLayerProps {
  activeMode: string;
  mapScale: number;
  activeMapId: string;
  currentStep: number;
  simulatorPhases?: any[];
  setSimulatorPhases?: (fn: (prev: any[]) => any[]) => void;
  setSimulatorStep?: (fn: (s: number) => number) => void;
  flightPoints: L.LatLng[];
  setFlightPoints: (pts: L.LatLng[]) => void;
}

export function SimulatorLayer({ 
  activeMode, mapScale, activeMapId, currentStep,
  simulatorPhases = [], setSimulatorPhases, setSimulatorStep,
  flightPoints, setFlightPoints
}: SimulatorLayerProps) {
  const map = useMap();
  const heatLayerRef = useRef<any>(null);
  const [bluezoneData, setBluezoneData] = useState<any[]>([]);
  const [hoverPoint, setHoverPoint] = useState<L.LatLng | null>(null);
  const [fetchError, setFetchError] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ✅ 에러 메시지 자동 소멸 (3초)
  React.useEffect(() => {
    if (!errorMsg) return;
    const t = setTimeout(() => setErrorMsg(null), 3000);
    return () => clearTimeout(t);
  }, [errorMsg]);

  // 1. 데이터 로드 (에러 시 fetchError 상태로 추적하여 재시도 가능)
  useEffect(() => {
    if (activeMode === "simulate" && bluezoneData.length === 0 && !fetchError) {
      console.log(`[SimulatorLayer] Fetching bluezone data (Mode: ${activeMode})...`);
      fetch(`/api/bluezone?t=${Date.now()}`)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          console.log(`[SimulatorLayer] Data loaded: ${Array.isArray(data) ? data.length : 0} matches`);
          setBluezoneData(Array.isArray(data) ? data : []);
        })
        .catch(err => {
          console.error("[SimulatorLayer] Bluezone data load failed:", err);
          setFetchError(true);
        });
    }
  }, [activeMode, bluezoneData.length, fetchError]);
  // 2. KNN 기반 매칭 로직 (useMemo로 최적화 및 상태 독립)
  const { matchesToRender, currentPhaseRadius, matchedFlightPaths } = React.useMemo(() => {
    let toRender: any[] = [];
    let phaseRadius = 3000;
    let flightPaths: L.LatLng[][] = [];

    if (!activeMapId || bluezoneData.length === 0) {
      return { matchesToRender: toRender, currentPhaseRadius: phaseRadius, matchedFlightPaths: flightPaths };
    }

    const internalNames = MAP_ID_TO_INTERNAL[activeMapId.toLowerCase()] || [activeMapId.toLowerCase()];
    const currentMapMatches = bluezoneData.filter(
      m => internalNames.includes(m.mapName?.toLowerCase()) && m.phases.length > 1
    );

    toRender = currentMapMatches;

    if (flightPoints.length === 2) {
      const uA = flightPoints[0];
      const uB = flightPoints[1];

      const scoredMatches = currentMapMatches.map(match => {
        if (!match.flightPath || match.flightPath.length !== 2) return { match, dist: Infinity };
        const fp0 = match.flightPath[0];
        const fp1 = match.flightPath[1];
        const mA = { lat: 8192 - (fp0.lat ?? fp0.y), lng: fp0.lng ?? fp0.x };
        const mB = { lat: 8192 - (fp1.lat ?? fp1.y), lng: fp1.lng ?? fp1.x };

        const dist1 = Math.sqrt(Math.pow(uA.lat - mA.lat, 2) + Math.pow(uA.lng - mA.lng, 2)) + 
                      Math.sqrt(Math.pow(uB.lat - mB.lat, 2) + Math.pow(uB.lng - mB.lng, 2));
        const dist2 = Math.sqrt(Math.pow(uA.lat - mB.lat, 2) + Math.pow(uA.lng - mB.lng, 2)) + 
                      Math.sqrt(Math.pow(uB.lat - mA.lat, 2) + Math.pow(uB.lng - mA.lng, 2));

        return { match, dist: Math.min(dist1, dist2) };
      }).filter(m => m.dist !== Infinity);

      // 비행기 경로가 너무 동떨어진 매치는 기본적으로 배제
      const validMatches = scoredMatches.filter(m => m.dist < 3500);
      validMatches.sort((a, b) => a.dist - b.dist);
      
      // 엄격 필터 결과가 너무 적으면 상위 스코어로 완화 폴백
      const sourceMatches = validMatches.length >= 5
        ? validMatches
        : scoredMatches.sort((a, b) => a.dist - b.dist).slice(0, Math.min(40, scoredMatches.length));

      const takeCount = Math.max(5, Math.min(200, sourceMatches.length)); 
      toRender = sourceMatches.slice(0, takeCount).map(m => m.match);

      // 경로 완성 시 또는 1페이즈일 때 매칭된 비행기 경로 표시
      if (currentStep <= 1) {
        flightPaths = toRender.map(m => {
          const f0 = m.flightPath[0];
          const f1 = m.flightPath[1];
          return [
            L.latLng(8192 - (f0.lat ?? f0.y), f0.lng ?? f0.x),
            L.latLng(8192 - (f1.lat ?? f1.y), f1.lng ?? f1.x)
          ];
        });
      }
    } else if (currentStep === 0) {
      if (flightPoints.length === 1) {
        // [고도화] 첫 번째 점을 찍었을 때, 그 근처(1.5km)에서 시작/종료되는 경로들만 가이드로 표시
        const uA = flightPoints[0];
        flightPaths = currentMapMatches.map(m => {
          if (!m.flightPath || m.flightPath.length !== 2) return null;
          const fp0 = m.flightPath[0];
          const fp1 = m.flightPath[1];
          const mA = { lat: 8192 - (fp0.lat ?? fp0.y), lng: fp0.lng ?? fp0.x };
          const mB = { lat: 8192 - (fp1.lat ?? fp1.y), lng: fp1.lng ?? fp1.x };

          const dStart = Math.sqrt(Math.pow(uA.lat - mA.lat, 2) + Math.pow(uA.lng - mA.lng, 2));
          const dEnd = Math.sqrt(Math.pow(uA.lat - mB.lat, 2) + Math.pow(uA.lng - mB.lng, 2));

          if (Math.min(dStart, dEnd) < 800) {
            return [
              L.latLng(mA.lat, mA.lng),
              L.latLng(mB.lat, mB.lng)
            ];
          }
          return null;
        }).filter(Boolean) as L.LatLng[][];
      } else if (flightPoints.length === 0) {
        // 사용자가 경로를 그리기 전(전체 가이드라인)
        flightPaths = currentMapMatches
          .filter(m => m.flightPath && m.flightPath.length === 2)
          .slice(0, 100) // 가이드라인 개수 상향
          .map(m => {
            const f0 = m.flightPath[0];
            const f1 = m.flightPath[1];
            return [
              L.latLng(8192 - (f0.lat ?? f0.y), f0.lng ?? f0.x),
              L.latLng(8192 - (f1.lat ?? f1.y), f1.lng ?? f1.x)
            ];
          });
        console.log(`[SimulatorLayer] Rendering ${flightPaths.length} guidelines for ${activeMapId} (out of ${currentMapMatches.length} matches)`);
      }
    }

    for (let s = 1; s < currentStep; s++) {
      const userPhase = simulatorPhases[s - 1];
      if (!userPhase) continue;
      
      const phasedMatches = toRender.map(match => {
        const pData = match.phases.find((p: any) => p.phase === s);
        if (!pData) return { match, dist: Infinity };
        const normX = pData.x > 8192 ? pData.x / 100 : pData.x;
        const normY = pData.y > 8192 ? pData.y / 100 : pData.y;
        const dist = Math.sqrt(Math.pow(userPhase.center.lat - (8192 - normY), 2) + Math.pow(userPhase.center.lng - normX, 2));
        return { match, dist };
      }).filter(m => m.dist !== Infinity);

      phasedMatches.sort((a, b) => a.dist - b.dist);
      toRender = phasedMatches.slice(0, 100).map(m => m.match);
    }

    let totalRadius = 0, count = 0;
    toRender.forEach(match => {
      const pCurrent = match.phases.find((p: any) => p.phase === Math.max(1, currentStep));
      if (pCurrent && pCurrent.radius) { totalRadius += pCurrent.radius; count++; }
    });
    if (count > 0) {
      phaseRadius = totalRadius / count;
    } else if (currentStep > 1 && simulatorPhases.length >= currentStep - 1) {
      // 매칭이 비어도 이전 페이즈 대비 자연스럽게 축소되도록 폴백
      const prev = simulatorPhases[currentStep - 2];
      if (prev?.radius) {
        phaseRadius = Math.max(250, prev.radius * 0.72);
      }
    }

    return { matchesToRender: toRender, currentPhaseRadius: phaseRadius, matchedFlightPaths: flightPaths };
  }, [activeMapId, bluezoneData, flightPoints, simulatorPhases, currentStep]);

  // 3. 히트맵 렌더링 및 실시간 업데이트
  useEffect(() => {
    // 시뮬레이션 모드가 아니거나 데이터가 없으면 즉시 제거
    if (activeMode !== "simulate" || currentStep < 1 || matchesToRender.length === 0) {
      if (heatLayerRef.current) {
        map.removeLayer(heatLayerRef.current);
        heatLayerRef.current = null;
      }
      return;
    }

    const updateHeatmap = async () => {
      // 1. 라이브러리 및 맵 인스턴스 준비
      if (!(window as any).L?.heatLayer) {
        await import("leaflet.heat");
      }
      const L = (await import("leaflet")).default;

      // 2. 현재 페이즈 데이터 추출 (이전 원 내부에 있는 경우만 포함)
      const heatData = matchesToRender.map(match => {
        const pCurrent = match.phases.find((p: any) => p.phase === currentStep);
        if (!pCurrent) return null;

        const normX = pCurrent.x > 8192 ? pCurrent.x / 100 : pCurrent.x;
        const normY = pCurrent.y > 8192 ? pCurrent.y / 100 : pCurrent.y;

        // [핵심] 만약 2페이즈 이상이라면, 현재 히트맵 포인트가 이전 페이즈 원 내부에 있는지 검증
        if (currentStep > 1 && simulatorPhases.length >= currentStep - 1) {
          const prevUserPhase = simulatorPhases[currentStep - 2];
          const dist = Math.sqrt(
            Math.pow((8192 - normY) - prevUserPhase.center.lat, 2) + 
            Math.pow(normX - prevUserPhase.center.lng, 2)
          );
          
          // 이전 사용자 원의 반경 밖이라면 확률 계산에서 제외 (원 밖 히트맵 제거)
          if (dist > (prevUserPhase.radius / mapScale)) {
            return null;
          }
        }
        
        return [8192 - normY, normX, 1.0]; // Y축 반전
      }).filter(Boolean) as any[];

      // 3. 레이어 업데이트 또는 생성 (중복 생성 방지 핵심 로직)
      if (heatLayerRef.current) {
        // [개선] 빈도수가 적어도 색이 잘 나오도록 max값 대폭 하향 조정
        const dynamicMax = Math.max(0.5, Math.min(1.5, heatData.length / 15));
        heatLayerRef.current.setOptions({ max: dynamicMax });
        heatLayerRef.current.setLatLngs(heatData);
      } else {
        const dynamicMax = Math.max(0.5, Math.min(1.5, heatData.length / 15));
        // 처음 생성할 때만 설정 적용
        heatLayerRef.current = (L as any).heatLayer(heatData, {
          radius: 50, // 45 -> 50으로 살짝 키움
          blur: 20, // 번짐 정도 최적화
          minOpacity: 0.4, // 최소 불투명도 상향하여 잘 보이게 함
          maxZoom: 1, 
          max: dynamicMax,
          gradient: {
            0.2: "blue",
            0.4: "cyan",
            0.6: "lime",
            0.8: "yellow",
            1.0: "red"
          }
        }).addTo(map);
      }
    };

    updateHeatmap();

    // 언마운트 시 또는 업데이트 전 클린업 (항상 제거하여 새 설정 반영 보장)
    return () => {
      if (heatLayerRef.current) {
        map.removeLayer(heatLayerRef.current);
        heatLayerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMode, currentStep, activeMapId, bluezoneData, map, flightPoints, simulatorPhases, matchesToRender]);
  
  useMapEvents({
    mousemove(e) {
      if (activeMode !== "simulate") return;
      if (currentStep >= 1 && flightPoints.length === 2) {
        setHoverPoint(e.latlng);
      } else {
        if (hoverPoint) setHoverPoint(null);
      }
    },
    click(e) {
      if (activeMode !== "simulate") return;
      if (currentStep === 0) {
        if (flightPoints.length < 2) {
          setFlightPoints([...flightPoints, e.latlng]);
        }
        // 이미 2개가 찍혀있으면 무시 (고정)
      } else if (currentStep >= 1) {
        if (currentStep >= 9) return; // 9페이즈가 최대
        // [중요] 이전 페이즈 원 안쪽인지 검증 (PUBG 규칙)
        if (currentStep > 1 && simulatorPhases.length >= currentStep - 1) {
          const prevPhase = simulatorPhases[currentStep - 2];
          if (prevPhase) {
            const dist = Math.sqrt(
              Math.pow(e.latlng.lat - prevPhase.center.lat, 2) + 
              Math.pow(e.latlng.lng - prevPhase.center.lng, 2)
            );
            
            if (dist > prevPhase.radius) {
              setErrorMsg("다음 자기장은 반드시 이전 자기장 안에 위치해야 합니다.");
              return;
            }
          }
        }

        // 도장 찍기
        if (setSimulatorPhases && setSimulatorStep) {
          setSimulatorPhases((prev: any[]) => [
            ...prev,
            { center: e.latlng, radius: currentPhaseRadius }
          ]);
          setSimulatorStep((s: number) => s + 1);
        }
      }
    },
    contextmenu(e) {
      e.originalEvent.preventDefault();
      if (activeMode !== "simulate") return;
      if (currentStep === 0) {
        setFlightPoints([]);
      } else if (currentStep >= 1) {
        // 이전 스텝으로 돌아가기 (도장 지우기)
        if (setSimulatorPhases && setSimulatorStep) {
          setSimulatorStep((s: number) => Math.max(0, s - 1));
          setSimulatorPhases((prev: any[]) => prev.slice(0, -1));
        }
      }
    }
  });

  if (activeMode !== "simulate") return null;

  return (
    <>
      {/* ✅ 인라인 토스트: alert() 대신 비차단 방식으로 경고 표시 */}
      {errorMsg && (
        <div style={{
          position: "fixed", bottom: "80px", left: "50%", transform: "translateX(-50%)",
          background: "rgba(239,68,68,0.92)", color: "white", padding: "10px 20px",
          borderRadius: "12px", fontSize: "13px", fontWeight: 700, zIndex: 9999,
          backdropFilter: "blur(8px)", boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          pointerEvents: "none"
        }}>
          <InlineIconLabel icon="alert">{errorMsg}</InlineIconLabel>
        </div>
      )}
      {bluezoneData.length === 0 && (
        <div style={{
          position: "fixed", bottom: "128px", left: "50%", transform: "translateX(-50%)",
          background: "rgba(30,41,59,0.9)", color: "#e2e8f0", padding: "8px 14px",
          borderRadius: "10px", fontSize: "12px", fontWeight: 600, zIndex: 9998,
          border: "1px solid rgba(148,163,184,0.35)", pointerEvents: "none"
        }}>
          시뮬레이터 데이터 로딩 중이거나 사용 가능한 매치 데이터가 없습니다.
        </div>
      )}
      {flightPoints.map((p, i) => (
        <Marker key={`flight-${i}`} position={p} icon={flightPointIcon} />
      ))}
      {flightPoints.length === 2 && (
        <Polyline
          positions={flightPoints.map(p => [p.lat, p.lng])}
          color="#3b82f6"
          weight={4}
          dashArray="10, 10"
          interactive={false}
        />
      )}
      
      {/* 과거 매칭된 매치들의 비행기 선 (점 0개일때 희미하게, 1개일때 진하게, 2개일때 숨김) */}
      {flightPoints.length < 2 && matchedFlightPaths.map((path, idx) => (
        <Polyline
          key={`matched-flight-${flightPoints.length}-${idx}`}
          positions={path}
          color="white"
          weight={flightPoints.length === 1 ? 4 : 2}
          opacity={flightPoints.length === 1 ? 0.8 : 0.35} // 시인성 대폭 강화
          dashArray="4, 8"
          interactive={false}
        />
      ))}
      
      {/* 유저가 확정한 페이즈 도장들 */}
      {simulatorPhases.slice(0, Math.max(0, currentStep - 1)).map((phase, idx) => (
        <Circle
          key={`phase-${idx}`}
          center={phase.center}
          radius={phase.radius}
          pathOptions={{ 
            color: idx === currentStep - 2 ? "blue" : "white", 
            fillColor: "blue", 
            fillOpacity: 0, 
            weight: idx === currentStep - 2 ? 3 : 1 
          }}
          interactive={false}
        />
      ))}

      {/* 현재 페이즈 도장 찍기 미리보기 (마우스 호버) - 9페이즈 도달 시 숨김 */}
      {currentStep >= 1 && currentStep < 9 && hoverPoint && flightPoints.length === 2 && (
        <Circle
          center={hoverPoint}
          radius={currentPhaseRadius}
          pathOptions={{ color: "white", fillColor: "white", fillOpacity: 0, weight: 2, dashArray: "4 4" }}
          interactive={false}
        />
      )}
    </>
  );
}
