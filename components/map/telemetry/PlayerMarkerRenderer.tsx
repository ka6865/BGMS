import React, { useMemo } from "react";
import { Marker, CircleMarker, Tooltip } from "react-leaflet";
import L from "leaflet";
import { svgIcon } from "@/lib/ui/icon-svg";

const COLORS = ["#F2A900", "#34A853", "#3b82f6", "#ef4444"];
const VEHICLE_THRESHOLD = 400;

/**
 * 플레이어 마커 렌더러 (사망, 기절, 도보, 차량 탑승)
 */
export const PlayerMarkerRenderer = ({ telemetryData }: { telemetryData: any }) => {
  const currentStates = telemetryData?.currentStates;
  const hiddenPlayers = telemetryData?.hiddenPlayers;
  const teamNames = useMemo(() => telemetryData?.teamNames ?? [], [telemetryData?.teamNames]);
  const showNames = telemetryData?.showPlayerNames !== false;
  const isActive = telemetryData?.isActive !== false && !!currentStates;


  const { groggyNodes, footNodes, vehicleNodes } = useMemo(() => {
    if (!isActive) return { groggyNodes: [], footNodes: [], vehicleNodes: [] };

    const allPlayers = Object.values(currentStates) as any[];
    
    const groggyPlayers = allPlayers.filter((p) => !p.isDead && p.isGroggy);
    const footPlayers = allPlayers.filter((p) => !p.isDead && !p.isGroggy && !p.isInVehicle);
    const vehiclePlayers = allPlayers.filter((p) => !p.isDead && !p.isGroggy && p.isInVehicle);

    // 차량 탑승 그룹화
    const vehicleGroups: any[][] = [];
    const vehicleIdMap: Record<string, number> = {};

    for (const player of vehiclePlayers) {
      const vid = player.vehicleId;
      if (vid && vehicleIdMap[vid] !== undefined) {
        vehicleGroups[vehicleIdMap[vid]].push(player);
      } else {
        let placed = false;
        if (!vid) {
          for (const group of vehicleGroups) {
            const rep = group[0];
            const dist = Math.sqrt((player.x - rep.x) ** 2 + (player.y - rep.y) ** 2);
            if (dist < VEHICLE_THRESHOLD) { group.push(player); placed = true; break; }
          }
        }
        if (!placed) {
          const newIdx = vehicleGroups.length;
          vehicleGroups.push([player]);
          if (vid) vehicleIdMap[vid] = newIdx;
        }
      }
    }

    const groggyNodes = groggyPlayers.map((player) => (
      <React.Fragment key={`groggy-group-${player.name}-${showNames}`}>
        <Marker
          position={[player.y, player.x]}
          interactive={false}
          icon={L.divIcon({
            html: `<div class="groggy-pulse-effect"></div>`,
            className: "",
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          })}
        />
        <CircleMarker
          center={[player.y, player.x]}
          radius={8}
          pathOptions={{
            color: "#fff",
            fillColor: "#FF00FF",
            fillOpacity: 1,
            weight: 2,
          }}
        >
          <Tooltip 
            direction="top" 
            permanent 
            opacity={showNames ? 1 : 0}
            className={`bg-black/90 border-none text-pink-400 font-extrabold shadow-none text-[11px] z-[1000] ${!showNames ? 'hidden-tooltip' : ''}`}
          >
            🆘 {player.name} (기절)
          </Tooltip>
        </CircleMarker>
      </React.Fragment>
    ));

    const footNodes = footPlayers.map((player) => {
      const ni = teamNames.indexOf(player.name);
      const color = player.isEnemy ? "#000000" : COLORS[(ni >= 0 ? ni : 0) % COLORS.length];
      const isHidden = (hiddenPlayers ?? []).includes(player.name);
      if (isHidden) return null;
      return (
        <CircleMarker
          key={`foot-${player.name}-${showNames}`}
          center={[player.y, player.x]}
          radius={player.isEnemy ? 4.5 : 6}
          pathOptions={{ 
            color: player.isEnemy ? "#000" : "#fff", 
            fillColor: color, 
            fillOpacity: 1, 
            weight: player.isEnemy ? 1.5 : 2 
          }}
        >
          <Tooltip 
            direction="top" 
            permanent 
            opacity={showNames ? (player.isEnemy ? 0.7 : 1) : 0}
            className={`${player.isEnemy ? 'bg-gray-900/90 text-gray-300' : 'bg-black/80 text-white'} border-none font-bold text-[10px] p-1 ${!showNames ? 'hidden-tooltip' : ''}`}
          >
            {player.name}{player.isEnemy ? ' (적)' : ''}
          </Tooltip>
        </CircleMarker>
      );
    });

    const vehicleNodes = vehicleGroups.map((group, gi) => {
      const rep = group[0];
      const passengerCount = group.length;

      const dotHtml = group
        .map((p) => {
          const ni = teamNames.indexOf(p.name);
          const c = COLORS[(ni >= 0 ? ni : 0) % COLORS.length];
          return `<div style="width:8px;height:8px;border-radius:50%;background:${c};border:1.5px solid #fff;flex-shrink:0;"></div>`;
        })
        .join("");

      const vehicleSvg = svgIcon("vehicle", { color: "currentColor", size: passengerCount > 1 ? 16 : 14 });
      const iconHtml = `
        <div style="
          display:flex;flex-direction:column;align-items:center;
          background:rgba(10,10,10,0.88);
          border:2px solid rgba(255,255,255,0.5);
          border-radius:10px;padding:3px 6px 3px 6px;
          box-shadow:0 2px 8px rgba(0,0,0,0.6);
          min-width:${passengerCount > 1 ? 44 : 30}px;
          gap:2px;pointer-events:auto;
        ">
          <span style="line-height:1;color:white;">${vehicleSvg}</span>
          <div style="display:flex;gap:3px;justify-content:center;">${dotHtml}</div>
        </div>`;

      const names = group.map((p: any) => {
        const ni = teamNames.indexOf(p.name);
        const c = COLORS[(ni >= 0 ? ni : 0) % COLORS.length];
        return `<span style="color:${c};font-weight:bold;">${p.name}</span>`;
      }).join(" · ");

      const w = passengerCount > 1 ? 52 : 38;
      const h = 44;

      return (
        <Marker
          key={`vehicle-group-${gi}-${showNames}`}
          position={[rep.y, rep.x]}
          icon={L.divIcon({
            html: iconHtml,
            className: "",
            iconSize: [w, h],
            iconAnchor: [w / 2, h / 2],
          })}
        >
          <Tooltip 
            direction="top" 
            permanent 
            opacity={showNames ? 1 : 0}
            className={`bg-black/90 border border-white/20 text-[11px] p-1.5 font-bold ${!showNames ? 'hidden-tooltip' : ''}`}
          >
            <div dangerouslySetInnerHTML={{ __html: `${svgIcon("vehicle", { color: "currentColor", size: 12 })} 탑승 중: ${names}` }} />
          </Tooltip>
        </Marker>
      );
    });

    return { groggyNodes, footNodes, vehicleNodes };
  }, [isActive, currentStates, hiddenPlayers, showNames, teamNames]);

  if (!isActive) return null;

  return (
    <>
      {groggyNodes}
      {footNodes}
      {vehicleNodes}
    </>
  );
};
