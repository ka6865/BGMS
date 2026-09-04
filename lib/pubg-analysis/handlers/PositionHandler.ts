import { BaseHandler } from './BaseHandler';
import { normalizeName, calcDist3D } from '../utils';

export class PositionHandler extends BaseHandler {
  handleEvent(e: any, ts: number, elapsed: number): void {
    switch (e._T) {
      case "LogPlayerPosition":
        this.handlePosition(e, ts, elapsed);
        break;
      case "LogParachuteLanding":
        this.handleLanding(e);
        break;
      case "LogPlayerCreate":
        this.handlePlayerCreate(e);
        break;
      case "LogPlayerTakeDamage":
      case "LogPlayerKill":
      case "LogPlayerMakeGroggy":
        this.updateParticipantLocations(e);
        break;
    }
  }

  private handlePosition(e: any, ts: number, elapsed: number) {
    const pName = normalizeName(e.character?.name || "");
    if (!pName) return;

    const charLoc = e.character.location ?? e.character.loc;
    if (!charLoc) return;

    this.state.playerLocations.set(pName, { x: charLoc.x, y: charLoc.y, z: charLoc.z || 0 });
    
    if (pName === this.state.lowerNickname) {
      // console.log(`[DEBUG-POS] My Position Updated: ${charLoc.x}, ${charLoc.y}`);
    }

    const isLanded = this.state.hasLanded;
    const isAfterStart = elapsed > 120 * 1000;

    const isInVehicle = !!(e.character.vehicle || e.vehicle);

    if (this.isMe(e.character) && (isLanded || isAfterStart) &&
      (this.state.playerAliveStatus.get(this.state.lowerNickname) !== false || this.state.playerAliveStatus.get(this.state.myAccountId) !== false)) {

      // [V16.0] 탈것 이동 거리 누적
      if (isInVehicle) {
        // A valid in-vehicle position is an observation even when the player
        // did not move between two samples (distance 0 remains measured 0).
        this.state.vehicleSampleCount++;
        const lastLoc = this.state.lastMyLoc;
        if (lastLoc) {
          const d = calcDist3D(charLoc, lastLoc) / 100; // [V47.0] cm -> m 변환
          if (d > 0.1 && d < 1000) { // 비정상적인 도약(순간이동 등) 제외
            this.state.vehicleDistance = (this.state.vehicleDistance || 0) + d;
          }
        }
      }
      this.state.lastMyLoc = { x: charLoc.x, y: charLoc.y, z: charLoc.z || 0 };

      // [V16.0] 사용 무기 목록 업데이트
      const weaponId = e.character.weaponId || (e.character.heldItems && e.character.heldItems[0]?.itemId);
      if (weaponId && weaponId !== "None" && !weaponId.includes("Item_Attach")) {
        this.state.weaponMatchCount.add(weaponId);
      }

      // 기존 고립도 샘플링 (탈것에 타지 않았을 때만)
      if (!isInVehicle && ts - this.state.lastIsolationSampleTime >= 5000) {
        this.state.lastIsolationSampleTime = ts;
        const iso = this.calculateIsolationData();
        if (iso) {
          this.state.isolationData = {
            ...iso,
            combatIsolation: 0,
            deathIsolation: 0,
            isCrossfire: false
          } as any;

          this.state.totalMinDistSum += iso.minDist;
          this.state.totalHeightDiffSum += iso.heightDiff;
          this.state.totalNearbyTeammatesSum += iso.teammateCount;
          this.state.totalIsolationSum += iso.isolationIndex;
          this.state.isolationSampleCount++;
        }
      }
    }
  }

  private handleLanding(e: any) {
    const pName = normalizeName(e.character?.name || "");
    if (this.isMe(e.character)) {
      this.state.hasLanded = true;
    }
  }

  private handlePlayerCreate(e: any) {
    const pName = normalizeName(e.character?.name || "");
    if (pName) {
      this.state.playerAliveStatus.set(pName, true);
      if (e.character?.accountId) this.state.playerAliveStatus.set(e.character.accountId, true);
      const loc = e.character.location ?? e.character.loc;
      if (loc) this.state.playerLocations.set(pName, { x: loc.x, y: loc.y, z: loc.z || 0 });
    }
  }

  private updateParticipantLocations(e: any) {
    const update = (char: any) => {
      const loc = char?.location ?? char?.loc;
      if (char?.name && loc) {
        const name = normalizeName(char.name);
        this.state.playerLocations.set(name, { x: loc.x, y: loc.y, z: loc.z || 0 });
        if (char.accountId) {
          this.state.playerLocations.set(char.accountId, { x: loc.x, y: loc.y, z: loc.z || 0 });
        }
      }
    };
    update(e.attacker);
    update(e.victim);
    update(e.character);
    update(e.maker);
    update(e.killer);
  }

  private calculateIsolationData() {
    const charLoc = this.state.playerLocations.get(this.state.myAccountId) || this.state.playerLocations.get(this.state.lowerNickname);
    if (!charLoc || (this.state.playerAliveStatus.get(this.state.lowerNickname) === false && this.state.playerAliveStatus.get(this.state.myAccountId) === false)) return null;

    let minDist = 999999, minEnemyDist = 999999, hDiff = 0, nearbyTeammates = 0;
    let totalDistToTeammates = 0;
    let aliveTeammateCount = 0;

    this.state.teamNames.forEach(tName => {
      // 닉네임과 매칭되는 accountId 찾기 (가장 정확한 방법)
      const tAccountId = Array.from(this.state.teamAccountIds).find(id => this.state.teamMapping.get(id) === this.state.teamMapping.get(tName));

      const status = this.state.playerAliveStatus.get(tName) || (tAccountId ? this.state.playerAliveStatus.get(tAccountId) : false);
      if (tName !== this.state.lowerNickname && status !== false && status !== "groggy") {
        const tLoc = (tAccountId ? this.state.playerLocations.get(tAccountId) : null) || this.state.playerLocations.get(tName);
        if (tLoc) {
          const d = calcDist3D(charLoc, tLoc) / 100; // [V47.0] cm -> m 변환
          if (d > 0.01) {
            totalDistToTeammates += d;
            aliveTeammateCount++;
            if (d < minDist) { 
              minDist = d; 
              hDiff = Math.abs(charLoc.z - tLoc.z) / 100; // [V55.2] cm -> m 변환
            }
            if (d < 100) nearbyTeammates++; // [V21] 100m 이내만 근접 아군으로 판정
          }
        }
      }
    });

    this.state.playerLocations.forEach((loc, name) => {
      const rId = this.state.teamMapping.get(name);
      if (rId && rId !== this.state.myRosterId && this.state.playerAliveStatus.get(name) !== false) {
        const d = calcDist3D(charLoc, loc) / 100; // [V47.0] cm -> m 변환
        if (d > 0.01 && d < minEnemyDist) minEnemyDist = d;
      }
    });

    // [V14] 유효성 검사 강화: 아군이 없거나 거리가 비상식적(2km 이상)이면 무효 처리
    if (aliveTeammateCount === 0 || minDist > 2000) return null;

    // 고립 지수 산출 (v18): 아군과의 평균 거리 / 적과의 최소 거리
    // 적이 멀리 있으면(안전하면) 고립도가 낮아지고, 적이 가까운데 아군이 멀면 고립도가 급증함
    const effectiveDist = (totalDistToTeammates / aliveTeammateCount);
    const safeMinEnemyDist = Math.max(30, minEnemyDist); // 최소 30m 기준

    // 지수 산출: (아군 거리 / 적 거리) 기반으로 하되, 0~10 사이로 스케일링
    const distRatio = (effectiveDist / safeMinEnemyDist);
    const isolationIndex = Math.min(10, Number((distRatio * 2.0).toFixed(2)));

    return {
      isolationIndex,
      minDist: minDist === 999999 ? 0 : minDist, // [V21] 평균이 아닌 최단 거리 (UI 가독성)
      heightDiff: hDiff,
      teammateCount: nearbyTeammates
    };
  }
}
