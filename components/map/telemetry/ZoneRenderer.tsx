import React from "react";
import { toCalibratedCoords } from "@/utils/coordinate";
import { Circle } from "react-leaflet";

/**
 * 텔레메트리 데이터 기반 자기장(블루존) 및 안전구역(화이트존)을 렌더링하는 컴포넌트입니다.
 */
export const ZoneRenderer = ({ telemetryData, showZones = true }: { telemetryData: any, showZones?: boolean }) => {
  if (!showZones || telemetryData?.isActive === false) return null;
  const zones: any[] = telemetryData.zoneEvents ?? [];
  if (zones.length === 0) return null;

  let latestZone: any = null;
  for (const z of zones) {
    if (z.relativeTimeMs <= telemetryData.currentTimeMs) latestZone = z;
    else break;
  }
  if (!latestZone) return null;

  return (
    <>
      {/* 하얀 원: 다음 안전구역 (White Circle) */}
      {latestZone.whiteX != null && latestZone.whiteY != null && latestZone.whiteRadius != null && (
        <Circle
          center={toCalibratedCoords(latestZone.whiteX, latestZone.whiteY, telemetryData.mapName)}
          radius={latestZone.whiteRadius}
          pathOptions={{
            color: "#ffffff",
            fillColor: "transparent",
            fillOpacity: 0,
            weight: 2.5,
            opacity: 0.8,
            dashArray: "10, 10",
          }}
          interactive={false}
        />
      )}
    </>
  );
};
