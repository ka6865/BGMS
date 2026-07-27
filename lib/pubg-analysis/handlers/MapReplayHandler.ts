import { BaseHandler } from './BaseHandler';

/**
 * [V26.0] MapReplayHandler
 * 지도 시각화를 위한 경로 데이터 및 특수 효과(폭발, 연막 등) 이벤트를 처리합니다.
 */
export class MapReplayHandler extends BaseHandler {
  
  handleEvent(e: any, ts: number, elapsed: number): void {
    const type = e._T || e.Type || e.event || "UNKNOWN";
    const lowerType = type.toLowerCase();
    
    // 0. 페이즈 전환 추적 (common.isGame 우선 활용)
    const commonIsGame = e.common?.isGame ?? e.Common?.IsGame;
    if (commonIsGame !== undefined) {
      const phaseFromCommon = Math.floor(commonIsGame);
      if (phaseFromCommon > 0) this.state.currentPhase = phaseFromCommon;
    }
    
    if (lowerType === "logphasechange" || lowerType === "logphasestart") {
      if (e.phase !== undefined && e.phase > 0) this.state.currentPhase = e.phase;
      return;
    }

    // 1. 자기장 및 게임 상태 (주기적 데이터)
    if (type === "LogGameStatePeriodic" && e.gameState) {
      this.handleZoneEvent(e, elapsed);
      return;
    }

    // 2. 캐릭터 생성 및 부활(복귀)
    if (lowerType === "logplayercreate" || lowerType.includes("redeploy") || lowerType.includes("recall")) {
      this.handlePlayerCreate(e, elapsed);
      return;
    }

    if (lowerType === "logplayerposition") {
      this.handlePosition(e, elapsed);
      return;
    }

    // 3. 교전 및 상태 변화 (기절, 사망, 부활)
    if (lowerType === "logplayermakegroggy") {
      this.handleGroggy(e);
      // Groggy는 Kill과 구조가 비슷하므로 아래 로직으로 이어서 처리
    }

    const isKill = lowerType.includes("kill") || lowerType.includes("death");
    const isGroggy = lowerType.includes("makegroggy") || lowerType.includes("knock");
    const isRevive = lowerType.includes("revive");

    if (isKill || isGroggy || isRevive) {
      this.handleCombatStatus(e, elapsed, isKill, isGroggy, isRevive);
      return;
    }

    // 4. 공격 및 피해
    if (lowerType === "logplayerattack") {
      this.handleAttack(e, elapsed);
      return;
    }

    if (lowerType === "logplayertakedamage") {
      this.handleDamage(e, elapsed);
      return;
    }

    // 5. 탈것
    if (lowerType === "logvehicleride" || lowerType === "logvehicleleave") {
      this.handleVehicle(e, elapsed, lowerType.includes("ride"));
      return;
    }

    // 5.5. 보급 상자
    if (lowerType === "logcarepackagespawn") {
      this.handleCarePackageSpawn(e, elapsed);
      return;
    }
    if (lowerType === "logcarepackageland") {
      this.handleCarePackageLand(e, elapsed);
      return;
    }

    // 6. 투척물 및 폭발
    if (lowerType === "logplayerusethrowable") {
      this.handleThrowable(e, elapsed);
      return;
    }

    if (lowerType === "logexplosiveexplode") {
      this.handleExplosion(e, elapsed);
      return;
    }
  }

  private scaleX(x: number) { return (x / this.state.mapSize) * 8192; }
  private scaleY(y: number) { return (y / this.state.mapSize) * 8192; }

  private handleZoneEvent(e: any, elapsed: number) {
    const gs = e.gameState;
    this.state.mapZoneEvents.push({
      time: e._D,
      relativeTimeMs: elapsed,
      // [V58.3] 🚨 텔레메트리 팩트 체크: 필드명과 실제 역할이 반대입니다 (가이드 준수)
      // poisonGasWarningRadius: White Zone (정적인 다음 안전구역)
      // safetyZoneRadius: Blue Zone (연속적으로 줄어드는 현재 자기장)
      whiteX: gs.poisonGasWarningPosition?.x != null ? this.scaleX(gs.poisonGasWarningPosition.x) : null,
      whiteY: gs.poisonGasWarningPosition?.y != null ? this.scaleY(gs.poisonGasWarningPosition.y) : null,
      whiteRadius: gs.poisonGasWarningRadius != null ? this.scaleX(gs.poisonGasWarningRadius) : null,
      blueX: gs.safetyZonePosition?.x != null ? this.scaleX(gs.safetyZonePosition.x) : null,
      blueY: gs.safetyZonePosition?.y != null ? this.scaleY(gs.safetyZonePosition.y) : null,
      blueRadius: gs.safetyZoneRadius != null ? this.scaleX(gs.safetyZoneRadius) : null,
      phase: this.state.currentPhase || 0
    });
  }

  private handlePlayerCreate(e: any, elapsed: number) {
    const char = e.character;
    if (char && this.isTeammate(char)) {
      this.state.mapEvents.push({
        type: "create",
        time: e._D,
        relativeTimeMs: elapsed,
        name: char.name,
        x: this.scaleX(char.location?.x ?? 0),
        y: this.scaleY(char.location?.y ?? 0),
      });
    }
  }

  private handlePosition(e: any, elapsed: number) {
    const char = e.character;
    if (!char || !char.name) return;

    const isTeam = this.isTeammate(char);
    
    // Lite 모드 유사 최적화: 적군은 10번에 한 번만 기록 (full 모드가 아닐 때만)
    if (!isTeam && this.state.mode !== "full") {
      this.state.positionEventCount++;
      if (this.state.positionEventCount % 10 !== 0) return;
    }

    this.state.lastPosByPlayer.set(char.name, { x: char.location?.x ?? 0, y: char.location?.y ?? 0 });
    this.state.lastRotByPlayer.set(char.name, char.rotation || 0);

    // 🎯 차량 동승 유령 버그 해결: LogPlayerPosition 시점에 최상위 vehicle 정보 또는 캐릭터 내의 vehicle 정보를 매치
    const vehicleId = e.vehicle?.vehicleId || char.vehicle?.vehicleId || null;

    this.state.mapEvents.push({
      type: "position",
      time: e._D,
      relativeTimeMs: elapsed,
      name: char.name,
      teamId: char.teamId,
      isTeam: isTeam,
      x: this.scaleX(char.location?.x ?? 0),
      y: this.scaleY(char.location?.y ?? 0),
      z: (char.location?.z ?? 0) / 100,
      health: char.health || 100,
      vehicleId: vehicleId,
    });
  }

  private handleGroggy(e: any) {
    const victimId = e.victim?.accountId;
    const attackerId = e.attacker?.accountId;
    if (victimId && attackerId) {
      this.state.groggyMap.set(victimId, { attackerAccountId: attackerId, attackerName: e.attacker?.name || "" });
    }
  }

  private handleCombatStatus(e: any, elapsed: number, isKill: boolean, isGroggy: boolean, isRevive: boolean) {
    const attackerObj = e.finisher || e.attacker || e.killer || e.reviver || null;
    const victimObj = e.victim;
    const isEnvKill = !attackerObj || attackerObj.accountId === victimObj?.accountId;
    const attackerName = isEnvKill ? (isRevive ? "자가부활" : "환경/자연사") : (attackerObj?.name || "알 수 없음");
    const victimName = victimObj?.name || "알 수 없음";

    const isAttackerTeam = this.isTeammate(attackerObj);
    const isVictimTeam = this.isTeammate(victimObj);

    // 어시스트 처리
    const assistants = e.assistantAccountIds ? e.assistantAccountIds.map((aid: string) => ({
      accountId: aid,
      name: "Unknown" // 실제 이름은 나중에 매핑 가능
    })) : [];

    let vX = null, vY = null;
    if (!isRevive) {
      vX = e.attacker?.viewDir?.x ?? e.finisher?.viewDir?.x ?? e.killer?.viewDir?.x;
      vY = e.attacker?.viewDir?.y ?? e.finisher?.viewDir?.y ?? e.killer?.viewDir?.y;
    }

    const charLoc = victimObj?.location || attackerObj?.location || { x: 0, y: 0 };
    const isSystemName = ["환경/자연사", "알 수 없음", "자가부활", "자연사"].includes(attackerName);
    
    this.state.mapEvents.push({
      type: isKill ? "kill" : (isGroggy ? "groggy" : "revive"),
      time: e._D,
      relativeTimeMs: elapsed,
      attacker: attackerName,
      attackerAccountId: attackerObj?.accountId,
      attackerTeamId: attackerObj?.teamId,
      victim: victimName,
      victimAccountId: victimObj?.accountId,
      victimTeamId: victimObj?.teamId,
      teamId: isAttackerTeam ? (attackerObj?.teamId ?? 999) : (victimObj?.teamId ?? 999),
      x: this.scaleX(charLoc.x),
      y: this.scaleY(charLoc.y),
      victimX: this.scaleX(victimObj?.location?.x || 0),
      victimY: this.scaleY(victimObj?.location?.y || 0),
      vX: vX, 
      vY: vY,
      weapon: e.damageCauserName || e.damageReason || "",
      isTeamAttacker: !!isAttackerTeam,
      isTeamVictim: !!isVictimTeam,
      isSystem: isSystemName,
      assistants: assistants,
    });
  }

  private handleAttack(e: any, elapsed: number) {
    const attacker = e.attacker;
    if (!attacker) return;

    const weapon = (e.weapon?.itemId || e.attackType || "").toLowerCase();
    const isThrowable = weapon.includes("throw") || weapon.includes("smoke") || weapon.includes("grenade");
    
    this.state.mapEvents.push({
      type: isThrowable ? "throw" : "shot",
      time: e._D,
      relativeTimeMs: elapsed,
      name: attacker.name,
      accountId: attacker.accountId,
      teamId: attacker.teamId,
      isTeam: this.isTeammate(attacker),
      x: this.scaleX(attacker.location?.x ?? 0),
      y: this.scaleY(attacker.location?.y ?? 0),
      rotation: attacker.rotation || this.state.lastRotByPlayer.get(attacker.name) || 0,
      vX: isThrowable ? null : attacker?.viewDir?.x,
      vY: isThrowable ? null : attacker?.viewDir?.y,
      weapon: e.weapon?.itemId || e.attackType || "",
    });
  }

  private handleDamage(e: any, elapsed: number) {
    if (e.attacker && e.victim) {
      this.state.mapEvents.push({
        type: "damage",
        time: e._D,
        relativeTimeMs: elapsed,
        attackerName: e.attacker.name,
        attackerAccountId: e.attacker.accountId,
        victimName: e.victim.name,
        victimAccountId: e.victim.accountId,
        damage: e.damage,
        x: this.scaleX(e.victim.location?.x ?? 0),
        y: this.scaleY(e.victim.location?.y ?? 0),
        z: (e.victim.location?.z ?? 0) / 100,
        attackerX: this.scaleX(e.attacker.location?.x ?? 0),
        attackerY: this.scaleY(e.attacker.location?.y ?? 0),
        attackerZ: (e.attacker.location?.z ?? 0) / 100,
      });
    }
  }

  private handleVehicle(e: any, elapsed: number, isRide: boolean) {
    const char = e.character || e.attacker;
    if (char) {
      this.state.mapEvents.push({
        type: isRide ? "ride" : "leave",
        time: e._D,
        relativeTimeMs: elapsed,
        name: char.name,
        accountId: char.accountId,
        teamId: char.teamId,
        isTeam: this.isTeammate(char),
        vehicle: e.vehicle?.vehicleId,
        x: this.scaleX(char.location?.x ?? 0),
        y: this.scaleY(char.location?.y ?? 0),
      });
    }
  }

  private handleThrowable(e: any, elapsed: number) {
    const char = e.character || e.attacker;
    if (!char) return;

    const itemId = (e.item?.itemId || e.weapon?.itemId || "").toLowerCase();
    const throwableKeywords = ["smokebomb", "grenade", "flashbang", "molotov", "bluezone", "shield", "c4", "m79"];
    
    if (throwableKeywords.some(k => itemId.includes(k))) {
      // 폭발 이벤트가 따로 없는 경우를 위한 예측 위치 계산 로직 (기존 telemetry/route.ts 준수)
      if (!this.state.hasRealExplosions) {
        const rotDegree = char.rotation || this.state.lastRotByPlayer.get(char.name) || 0;
        const rot = rotDegree * (Math.PI / 180);
        const estX = (char.location?.x ?? 0) + Math.sin(rot) * 2000;
        const estY = (char.location?.y ?? 0) - Math.cos(rot) * 2000;

        let vfxType = "grenade";
        if (itemId.includes("smokebomb") || itemId.includes("smoke") || itemId.includes("m79")) vfxType = "smoke";
        else if (itemId.includes("flashbang")) vfxType = "flash";

        this.state.mapEvents.push({
          type: vfxType,
          time: e._D,
          relativeTimeMs: elapsed + 2500, 
          name: char.name,
          weapon: itemId,
          x: this.scaleX(estX),
          y: this.scaleY(estY),
          isEstimated: true
        });
      }
      
      this.state.mapEvents.push({
        type: "throw",
        time: e._D,
        relativeTimeMs: elapsed,
        name: char.name,
        weapon: itemId,
        x: this.scaleX(char.location?.x ?? 0),
        y: this.scaleY(char.location?.y ?? 0),
      });
    }
  }

  private handleExplosion(e: any, elapsed: number) {
    const loc = e.location || e.character?.location || e.attacker?.location;
    if (loc) {
      this.state.hasRealExplosions = true;
      const explosiveId = (e.explosiveItem?.itemId || e.explosiveId || "").toLowerCase();
      
      let vfxType = "grenade";
      if (explosiveId.includes("smoke") || explosiveId.includes("m79")) vfxType = "smoke";
      else if (explosiveId.includes("flash")) vfxType = "flash";

      this.state.mapEvents.push({
        type: vfxType,
        time: e._D,
        relativeTimeMs: elapsed,
        name: e.character?.name || e.attacker?.name || "",
        weapon: explosiveId,
        x: this.scaleX(loc.x),
        y: this.scaleY(loc.y),
        isRealExplosion: true
      });
    }
  }

  private handleCarePackageSpawn(e: any, elapsed: number) {
    const loc = e.location;
    if (loc) {
      this.state.mapEvents.push({
        type: "carepackage_spawn",
        time: e._D,
        relativeTimeMs: elapsed,
        x: this.scaleX(loc.x),
        y: this.scaleY(loc.y),
        z: (loc.z ?? 0) / 100
      });
    }
  }

  private handleCarePackageLand(e: any, elapsed: number) {
    const loc = e.location;
    if (loc) {
      this.state.mapEvents.push({
        type: "carepackage_land",
        time: e._D,
        relativeTimeMs: elapsed,
        x: this.scaleX(loc.x),
        y: this.scaleY(loc.y),
        z: (loc.z ?? 0) / 100
      });
    }
  }
}
