import { BaseHandler } from './BaseHandler';

export class ZoneHandler extends BaseHandler {
  handleEvent(e: any, ts: number, elapsed: number): void {
    switch (e._T) {
      case "LogGameStatePeriodic":
        this.handleGameState(e);
        break;
      case "LogPlayerTakeDamage":
        this.handleBluezoneDamage(e);
        break;
      case "LogPlayerPosition":
        this.handleEdgePlay(e, ts, elapsed);
        break;
      case "LogPhaseStart":
      case "LogPhaseChange":
        this.handlePhaseChange(e);
        break;
    }
  }

  private handlePhaseChange(_e: any) {
    if (!this.state.whiteZone || this.state.whiteZone.radius === 0) return;
    
    // 내 마지막 위치 확인
    const myLoc = this.state.playerLocations.get(this.state.lowerNickname) || 
                  this.state.playerLocations.get(this.state.myAccountId);
    if (!myLoc) return;

    const distToCenter = Math.sqrt(
      Math.pow((myLoc.x / 100) - this.state.whiteZone.x, 2) +
      Math.pow((myLoc.y / 100) - this.state.whiteZone.y, 2)
    );

    // 다음 안전 구역 안에 있으면 운 좋음 (+1), 밖에 있으면 (+0)
    if (distToCenter <= this.state.whiteZone.radius) {
      this.state.circleLuckSum++;
    }
    this.state.circleLuckCount++;
  }

  private handleGameState(e: any) {
    const gs = e.gameState;
    // [V58.3] 🚨 텔레메트리 팩트 체크: 필드명과 실제 역할이 반대입니다 (가이드 준수)
    if (gs.poisonGasWarningPosition) {
      this.state.whiteZone = {
        x: gs.poisonGasWarningPosition.x / 100,
        y: gs.poisonGasWarningPosition.y / 100,
        radius: gs.poisonGasWarningRadius / 100
      };
    }
    if (gs.safetyZonePosition) {
      this.state.blueZone = {
        x: gs.safetyZonePosition.x / 100,
        y: gs.safetyZonePosition.y / 100,
        radius: gs.safetyZoneRadius / 100
      };
    }

    if (gs.isZoneMoving !== undefined) {
      this.state.isZoneMoving = gs.isZoneMoving;
    } else if (this.state.blueZone.radius > 0 && this.state.whiteZone.radius > 0) {
      this.state.isZoneMoving = this.state.blueZone.radius > (this.state.whiteZone.radius * 1.01);
    }
  }

  private handleBluezoneDamage(e: any) {
    const dmgCat = (e.damageTypeCategory || "").toLowerCase();
    const damage = e.damage || 0;

    if (this.isMe(e.victim) && dmgCat.includes("bluezone")) {
      this.state.bluezoneWaste = (this.state.bluezoneWaste || 0) + damage;
    }
  }

  private handleEdgePlay(e: any, ts: number, elapsed: number) {
    if (!this.isMe(e.character)) return;

    const charLoc = e.character.location ?? e.character.loc;
    if (!charLoc) return;

    const isLanded = this.state.hasLanded;
    const isAfterStart = elapsed > 120 * 1000;

    if ((isLanded || isAfterStart) &&
      (this.state.playerAliveStatus.get(this.state.lowerNickname) !== false || this.state.playerAliveStatus.get(this.state.myAccountId) !== false) &&
      this.state.blueZone.radius > 0 &&
      ts - (this.state.lastEdgeSampleTime || 0) >= 5000) {

      this.state.lastEdgeSampleTime = ts;
      const charX = charLoc.x / 100;
      const charY = charLoc.y / 100;
      const distToCenter = Math.sqrt(
        Math.pow(charX - this.state.blueZone.x, 2) +
        Math.pow(charY - this.state.blueZone.y, 2)
      );
      const distToEdge = Math.abs(distToCenter - this.state.blueZone.radius);
      if (distToEdge < 50) {
        this.state.zoneStrategy.edgePlayCount++;
      } else if (distToEdge < 150) {
        this.state.zoneStrategy.fatalDelayCount++;
      }
    }
  }
}
