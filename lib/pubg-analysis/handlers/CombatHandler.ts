import { AnalysisState } from "../types";
import { normalizeName, calcDist3D, scaleCoordinate } from "../utils";
import { WEAPON_NAMES, IGNORE_WEAPONS, IGNORE_WEAPON_PATTERNS, TACTICAL_THRESHOLDS } from "../constants";
import { BaseHandler } from "./BaseHandler";

export class CombatHandler extends BaseHandler {
  constructor(state: AnalysisState) {
    super(state);
  }

  private isIgnoredWeapon(wId: string, cleanWId: string, damageTypeCategory?: string): boolean {
    if (damageTypeCategory && (
      damageTypeCategory.includes("Fall") ||
      // 자기장 자체 피해만 제외. 블루존 수류탄(Damage_BlueZoneGrenade)은 능동적 교전 딜이므로 포함
      damageTypeCategory === "Damage_BlueZone" ||
      damageTypeCategory === "Damage_BlueZone_Drown" ||
      damageTypeCategory.includes("RedZone") ||
      damageTypeCategory.includes("Environment") ||
      damageTypeCategory.includes("Bleeding") ||
      damageTypeCategory.includes("Lava") ||
      damageTypeCategory.includes("Groggy")
    )) {
      return true;
    }
    
    if (IGNORE_WEAPON_PATTERNS.some(pattern => cleanWId.includes(pattern))) {
      return true;
    }

    return (
      IGNORE_WEAPONS.includes(wId) || 
      IGNORE_WEAPONS.includes(cleanWId) ||
      cleanWId === "None" ||
      cleanWId === "Unknown"
    );
  }

  private updateHitDetails(
    wStat: any,
    bodyPartName: string,
    damage: number = 0,
    isHit: boolean = false,
    isKnock: boolean = false,
    isKill: boolean = false
  ) {
    if (!wStat) return;
    if (!wStat.hitDetails) {
      wStat.hitDetails = [];
    }

    // PUBG telemetry body part normalization
    let bodyPart = "TorsoShot";
    const lowerPart = (bodyPartName || "").toLowerCase();
    if (lowerPart.includes("head")) {
      bodyPart = "HeadShot";
    } else if (lowerPart.includes("torso") || lowerPart.includes("neck") || lowerPart.includes("chest") || lowerPart.includes("groin")) {
      bodyPart = "TorsoShot";
    } else if (lowerPart.includes("pelvis") || lowerPart.includes("hip") || lowerPart.includes("abdomen")) {
      bodyPart = "PelvisShot";
    } else if (lowerPart.includes("arm") || lowerPart.includes("hand") || lowerPart.includes("shoulder") || lowerPart.includes("elbow") || lowerPart.includes("wrist")) {
      bodyPart = "ArmShot";
    } else if (lowerPart.includes("leg") || lowerPart.includes("foot") || lowerPart.includes("thigh") || lowerPart.includes("knee") || lowerPart.includes("ankle")) {
      bodyPart = "LegShot";
    } else {
      bodyPart = "TorsoShot";
    }

    let detail = wStat.hitDetails.find((d: any) => d.bodyPart === bodyPart);
    if (!detail) {
      detail = {
        bodyPart,
        kills: 0,
        dBNOs: 0,
        hits: 0,
        dBNOHits: 0,
        damage: 0,
        dBNODamage: 0
      };
      wStat.hitDetails.push(detail);
    }

    if (isHit) {
      detail.hits++;
      detail.damage = Number((detail.damage + damage).toFixed(2));
    }
    if (isKnock) {
      detail.dBNOs++;
      detail.dBNOHits++;
      detail.dBNODamage = Number((detail.dBNODamage + damage).toFixed(2));
    }
    if (isKill) {
      detail.kills++;
    }
  }

  private recordWeaponBurst(wStat: any, victimName: string, ts: number) {
    const lastBurst = wStat.lastMetaBurst;
    if (!lastBurst || lastBurst.victimName !== victimName || ts - lastBurst.lastTs > 1500) {
      wStat.lastMetaBurst = { victimName, startedAt: ts, lastTs: ts, hasSustainedHit: false };
      wStat.firstSecHits = (wStat.firstSecHits || 0) + 1;
      return;
    }

    const elapsedMs = ts - lastBurst.startedAt;
    if (elapsedMs <= 1000) {
      wStat.firstSecHits = (wStat.firstSecHits || 0) + 1;
    } else if (elapsedMs <= 3000) {
      wStat.sustainedHits = (wStat.sustainedHits || 0) + 1;
      if (!lastBurst.hasSustainedHit) {
        wStat.sustainedBurstCount = (wStat.sustainedBurstCount || 0) + 1;
        lastBurst.hasSustainedHit = true;
      }
    }
    lastBurst.lastTs = ts;
  }

  public handleEvent(e: any, ts: number, _elapsed: number) {
    switch (e._T) {
      case "LogPlayerTakeDamage":
        this.handleDamage(e, ts);
        break;
      case "LogPlayerMakeGroggy":
      case "LogPlayerMakeDBNO":
        this.handleDown(e, ts);
        break;
      case "LogPlayerKill":
      case "LogPlayerKillV2":
        this.handleKill(e, ts);
        break;
      case "LogPlayerRevive":
        this.handleRevive(e, ts);
        break;
      case "LogPlayerRecall":
      case "LogPlayerRecallShip":
      case "LogPlayerRedeploy":
      case "LogPlayerRedeployBRStart": 
      case "LogPlayerRedeployBrStart": 
      case "LogPlayerCreate": // [V26.1] 태이고 복귀전 등 암시적 부활 대응
        this.handleRecall(e, ts);
        break;
      case "LogMatchEnd":
        this.handleMatchEnd(e);
        break;
    }
  }

  private handleDamage(e: any, ts: number) {
    const attackerName = normalizeName(e.attacker?.name || "");
    const victimName = normalizeName(e.victim?.name || e.victim?.accountId || "");
    const damage = e.damage || 0;

    if (!e.victim) return;

    // 아군 피격 시 최근 피격 시점 업데이트 (Trade/Bait 판정용)
    if (this.state.teamNames.has(victimName) && victimName !== this.state.lowerNickname) {
      this.state.recentTeammateDamageTaken.set(attackerName, ts);
    }

    const isSoloMode = this.state.gameMode.includes('solo');
    const isMeAttacker = this.isMe(e.attacker);
    const isTeammateAttacker = this.isTeammate(e.attacker);
    const isMeVictim = this.isMe(e.victim);
    const isTeammateVictim = this.isTeammate(e.victim);

    if (
      isMeAttacker && 
      !isTeammateVictim && 
      !isSoloMode
    ) {
      const lastTeammateHit = this.state.recentTeammateDamageTaken.get(victimName);
      if (lastTeammateHit && ts - lastTeammateHit < 5000) {
        const lastBaitTs = this.state.baitCooldown.get(victimName) || 0;
        if (ts - lastBaitTs > 10000) {
          this.state.totalBaitCount++;
          this.state.baitCooldown.set(victimName, ts);
        }
      }
    }

    if (attackerName && victimName) {
      this.processDuelData(e, ts, e.attacker, e.victim);
    }



    if (isTeammateAttacker) {
      // 야생 곰 등 비플레이어 몬스터에게 가해진 피해 제외 (딜량 오염 방지)
      if (victimName.toLowerCase().includes("bear")) {
        return;
      }

      if (isMeAttacker) {
        this.state.myActionTimestamps.push(ts);
        this.state.totalCombatIsolationSum += (this.state.isolationData?.isolationIndex || 0);
        this.state.combatIsolationCount++;
      }

      const currentVictimDamage = this.state.victimDamage.get(victimName) || 0;
      this.state.victimDamage.set(victimName, currentVictimDamage + damage);

      // [V66.0] 나를 제외한 아군(팀원)이 공격한 적 개별 플레이어의 누적 데미지 및 마지막 타격 시각을 Map에 기록
      // teamsRosterHit: 전멸 판정용 Roster ID 별도 트랙
      if (victimName && !isTeammateVictim && !isMeAttacker) {
        const existing = this.state.teamsUserHit.get(victimName);
        this.state.teamsUserHit.set(victimName, {
          totalDamage: (existing?.totalDamage ?? 0) + damage,
          lastHitTime: ts,
        });
        // 전멸 판정용 Roster 트래킹
        const vRosterIdForHit = this.state.teamMapping.get(victimName);
        if (vRosterIdForHit) this.state.teamsRosterHit.add(vRosterIdForHit);
      }

      if (isMeAttacker || isTeammateAttacker) {
        // 0. 아군 공격(Friendly Fire) 및 자해 데미지는 본인/아군 무기 교전 통계에서 완벽 배제 (팀원 차량 박치기 딜량 오염 차단)
        if (isTeammateVictim || victimName === attackerName) {
          return;
        }

        if (isMeAttacker) {
          const currentMyDmg = this.state.myVictimDamage.get(victimName) || 0;
          this.state.myVictimDamage.set(victimName, currentMyDmg + damage);
        }

        const wId = e.damageCauserName || (e.damageCauser && e.damageCauser.itemId) || e.weaponId || "Unknown";
        const cleanWId = wId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, "");

        // 1. 제외 무기 필터링 (투척물, 캐릭터 오브젝트, C4, 자전거 등 분석 배제)
        if (!this.isIgnoredWeapon(wId, cleanWId, e.damageTypeCategory)) {
          // 2. 피해자가 이미 기절(groggy) 상태이거나 사망(false) 상태인 경우 딜량 가산 제외 (확킬 딜량 오염 방지)
          const victimStatus = this.state.playerAliveStatus.get(victimName);
          const isVictimGroggy = victimStatus === "groggy" || victimStatus === false;

          if (!isVictimGroggy) {
            if (isMeAttacker) {
              const wStat = this.state.weaponStats.get(cleanWId) || { kills: 0, dbnos: 0, damage: 0, hits: 0 };
              wStat.damage += damage;
              wStat.hits++;
              this.recordWeaponBurst(wStat, victimName, ts);
              this.updateHitDetails(wStat, e.damageReason, damage, true, false, false);
              this.state.weaponStats.set(cleanWId, wStat);

              // goldenTimeDamage도 아군/자해/기절이 완벽 차단된 실질 대인 유효 딜량만 누적하도록 동기화
              const elapsedSec = (ts - this.state.matchStartTime) / 1000;
              if (elapsedSec < 300) this.state.goldenTimeDamage.early += damage;
              else if (elapsedSec < 900) this.state.goldenTimeDamage.mid1 += damage;
              else if (elapsedSec < 1500) this.state.goldenTimeDamage.mid2 += damage;
              else this.state.goldenTimeDamage.late += damage;
            } else {
              const squadWMap = this.state.squadWeaponStats;
              let pStats = squadWMap.get(attackerName);
              if (!pStats) {
                pStats = new Map();
                squadWMap.set(attackerName, pStats);
              }
              const wStat = pStats.get(cleanWId) || { weapon: cleanWId, kills: 0, dbnos: 0, damage: 0, hits: 0, shots: 0 };
              wStat.damage += damage;
              wStat.hits++;
              this.updateHitDetails(wStat, e.damageReason, damage, true, false, false);
              pStats.set(cleanWId, wStat);
            }
          }
        }
        
        if (isMeAttacker) {
          this.state.combatPressure.totalHits++;
          if (victimName) this.state.combatPressure.uniqueVictims.add(victimName);

          const attackerLoc = e.attacker?.location || e.attacker?.loc;
          const victimLoc = e.victim?.location || e.victim?.loc;
          const dist = calcDist3D(attackerLoc, victimLoc);
          if (dist !== 999) {
            const distM = Math.round(dist / 100);
            this.state.combatPressure.maxHitDistance = Math.max(this.state.combatPressure.maxHitDistance, distM);
            if (distM < 50) this.state.itemUseStats.distanceDamage.short += damage;
            else if (distM < 200) this.state.itemUseStats.distanceDamage.mid += damage;
            else this.state.itemUseStats.distanceDamage.long += damage;
          }
        }
      }

      let targetHits = this.state.playerCombatData.get(`hits_${victimName}`) || [];
      targetHits = targetHits.filter((h: any) => ts - h.ts < 1000);
      const otherTeammateHit = targetHits.find((h: any) => h.attacker !== attackerName);
      if (otherTeammateHit) {
        this.state.itemUseStats.focusFireCount++;
      }
      targetHits.push({ attacker: attackerName, ts });
      this.state.playerCombatData.set(`hits_${victimName}`, targetHits);
    }

    if (isMeVictim && attackerName && !isTeammateAttacker) {
      let recentAttackers = this.state.playerCombatData.get("recent_attackers_on_me") || [];
      recentAttackers = recentAttackers.filter((a: any) => ts - a.ts < 10000);

      const myLoc = e.victim?.location || e.victim?.loc;
      const attackerLoc = e.attacker?.location || e.attacker?.loc;

      if (myLoc && attackerLoc) {
        const currentAngle = Math.atan2(attackerLoc.y - myLoc.y, attackerLoc.x - myLoc.x);
        for (const prev of recentAttackers) {
          if (prev.name === attackerName) continue;
          let angleDiff = Math.abs(currentAngle - prev.angle) * (180 / Math.PI);
          if (angleDiff > 180) angleDiff = 360 - angleDiff;
          if (angleDiff > 90) {
            this.state.itemUseStats.crossfireExposureCount++;
            this.state.totalCrossfireCount++;
            break;
          }
        }
        recentAttackers.push({ name: attackerName, angle: currentAngle, ts });
        this.state.playerCombatData.set("recent_attackers_on_me", recentAttackers);
      }
    }
  }

  private handleDown(e: any, ts: number) {
    const attacker = e.attacker || e.maker;
    const makerName = normalizeName(attacker?.name || "");
    const victimName = normalizeName(e.victim?.name || "");
    const weaponId = e.damageCauserName || (e.damageCauser && e.damageCauser.itemId) || e.weaponId || "Unknown";
    const dBNOId = e.dBNOId;

    const isMeMaker = this.isMe(attacker);
    const isMeVictim = this.isMe(e.victim);
    const isTeammateVictim = this.isTeammate(e.victim);

    if (dBNOId !== undefined && dBNOId !== -1) {
      this.state.dbnoMap.set(dBNOId, { attacker: makerName, victim: victimName, weaponId: weaponId, ts: ts, attackerAccountId: attacker?.accountId });
    }

    // 기절한 모든 플레이어의 생존 상태를 실시간 groggy로 업데이트
    if (victimName) {
      this.state.playerAliveStatus.set(victimName, "groggy");
    }

    if (isMeMaker || this.isTeammate(attacker)) {
      if (weaponId && weaponId !== "Unknown" && !isTeammateVictim) {
        const cleanWId = weaponId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, "");
        if (!this.isIgnoredWeapon(weaponId, cleanWId, e.damageTypeCategory)) {
          if (isMeMaker) {
            const wStat = this.state.weaponStats.get(cleanWId) || { kills: 0, dbnos: 0, damage: 0, hits: 0 };
            wStat.dbnos++;
            this.updateHitDetails(wStat, e.damageReason, 0, false, true, false);
            this.state.weaponStats.set(cleanWId, wStat);
          } else {
            const squadWMap = this.state.squadWeaponStats;
            let pStats = squadWMap.get(makerName);
            if (!pStats) {
              pStats = new Map();
              squadWMap.set(makerName, pStats);
            }
            const wStat = pStats.get(cleanWId) || { weapon: cleanWId, kills: 0, dbnos: 0, damage: 0, hits: 0, shots: 0 };
            wStat.dbnos++;
            this.updateHitDetails(wStat, e.damageReason, 0, false, true, false);
            pStats.set(cleanWId, wStat);
          }
        }
      }
    }

    if (this.isTeammate(attacker) && !isMeMaker && victimName) {
      this.checkAndResolveInitiativeAssist(victimName);
    }

    if (isMeMaker) {
      this.state.myActionTimestamps.push(ts);
      this.updateDuelOutcome(attacker, e.victim);
      const killerLoc = attacker?.location || attacker?.loc;
      const victimLoc = e.victim?.location || e.victim?.loc;
      const dist = Math.round(calcDist3D(killerLoc, victimLoc) / 100);

      // [V59.0] 차량 탑승 타격 감지 (로드킬 제외)
      const dmgCat = (e.damageTypeCategory || "").toLowerCase();
      const isRoadkill = dmgCat.includes("vehicle");
      if (!isRoadkill) {
        if (e.victim?.isInVehicle === true) {
          this.state.leadShotKnocks++;
        }
        if (attacker?.isInVehicle === true) {
          this.state.ridingShotKnocks++;
        }
      } else {
        // [V60.0] 차량 충돌 기절(로드킬) 누계
        this.state.roadKnocks++;
      }

      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'KNOCK',
        weapon: WEAPON_NAMES[weaponId] || weaponId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, ""),
        victim: e.victim?.name || victimName,
        distance: dist !== 10 ? dist : undefined,
        isHeadshot: e.damageReason === "HeadShot" || e.isHeadshot,
        isMe: true,
        x: scaleCoordinate(this.state.playerLocations.get(makerName)?.x || attacker?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(makerName)?.y || attacker?.location?.y || 0, this.state.mapSize),
        playerName: this.state.canonicalNickname,
        victimX: scaleCoordinate(this.state.playerLocations.get(victimName)?.x || e.victim?.location?.x || 0, this.state.mapSize),
        victimY: scaleCoordinate(this.state.playerLocations.get(victimName)?.y || e.victim?.location?.y || 0, this.state.mapSize)
      });
    }

    if (isMeVictim) {
      this.state.myDownedIntervals.push({ start: ts, end: null });
      this.updateDuelOutcome(attacker, e.victim);
      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'DOWNED',
        attacker: makerName,
        weapon: WEAPON_NAMES[weaponId] || weaponId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, ""),
        isMe: true,
        x: scaleCoordinate(this.state.playerLocations.get(this.state.lowerNickname)?.x || e.victim?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(this.state.lowerNickname)?.y || e.victim?.location?.y || 0, this.state.mapSize),
        playerName: this.state.canonicalNickname,
        attackerX: scaleCoordinate(this.state.playerLocations.get(makerName)?.x || attacker?.location?.x || 0, this.state.mapSize),
        attackerY: scaleCoordinate(this.state.playerLocations.get(makerName)?.y || attacker?.location?.y || 0, this.state.mapSize)
      });
    }

    if (isTeammateVictim && !isMeVictim) {
      if (this.state.playerAliveStatus.get(this.state.lowerNickname) !== false) {
        this.state.totalTeammateKnocks++;
      }
      this.state.teammateKnockEvents.push(ts);
      this.state.playerAliveStatus.set(victimName, "groggy");
      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'TEAM_KNOCK',
        attacker: attacker?.name || makerName,
        victim: e.victim?.name || victimName,
        weapon: WEAPON_NAMES[weaponId] || weaponId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, ""),
        isMe: false,
        x: scaleCoordinate(this.state.playerLocations.get(victimName)?.x || e.victim?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(victimName)?.y || e.victim?.location?.y || 0, this.state.mapSize),
        playerName: e.victim?.name || victimName,
        attackerX: scaleCoordinate(this.state.playerLocations.get(attacker?.name || makerName)?.x || attacker?.location?.x || 0, this.state.mapSize),
        attackerY: scaleCoordinate(this.state.playerLocations.get(attacker?.name || makerName)?.y || attacker?.location?.y || 0, this.state.mapSize)
      });
    }

    if (victimName === this.state.lowerNickname) {
      this.state.playerAliveStatus.set(victimName, "groggy");
    }
  }

  private handleKill(e: any, ts: number) {
    const victimName = normalizeName(e.victim?.name || e.victim?.accountId || "");
    const isMeKiller = this.isMe(e.killer);
    const isMeFinisher = this.isMe(e.finisher);
    const isMeVictim = this.isMe(e.victim);
    const isTeammateKiller = this.isTeammate(e.killer);
    const isTeammateVictim = this.isTeammate(e.victim);

    const killerName = normalizeName(typeof e.killer === 'string' ? e.killer : e.killer?.name || "");
    const finisherName = normalizeName(typeof e.finisher === 'string' ? e.finisher : e.finisher?.name || "");
    const dBNOMakerName = normalizeName(typeof e.dBNOMaker === 'string' ? e.dBNOMaker : e.dBNOMaker?.name || "");

    const getWeaponId = (ev: any) => {
      let id = ev.weaponId || ev.damageCauserName || (ev.damageCauser && ev.damageCauser.itemId);
      if (!id || id === "None" || id === "Unknown") {
        const info = ev.killerDamageInfo || ev.finishDamageInfo || ev.dBNODamageInfo;
        if (info) id = info.damageCauserName;
      }
      if ((!id || id === "None" || id === "Unknown") && ev.dBNOId !== undefined && ev.dBNOId !== -1) {
        const dbnoInfo = this.state.dbnoMap.get(ev.dBNOId);
        if (dbnoInfo) id = dbnoInfo.weaponId;
      }
      return id || "Unknown";
    };

    const wId = getWeaponId(e);
    const attackerObj = e.killer || e.attacker || e.finisher;

    // [V55.2] 트레이드 킬: '내가' 팀원의 복수를 해준 경우 (isMeKiller)
    if (isMeKiller && victimName && !isTeammateVictim) {
      const lastTeammateKnock = this.state.teammateKnockEvents.length > 0 ? this.state.teammateKnockEvents[this.state.teammateKnockEvents.length - 1] : 0;
      if (lastTeammateKnock > 0 && ts - lastTeammateKnock < 30000) {
        this.state.totalTradeKills++;
        this.state.tradeLatencies.push(ts - lastTeammateKnock);
      }
    }

    // [V55.2] 지원 사격(Support): '내가' 데미지를 50 이상 입혔는데, '팀원'이 킬을 한 경우
    if (isTeammateKiller && !isMeKiller && victimName && !isTeammateVictim) {
      const myDmgOnVictim = this.state.myVictimDamage.get(victimName) || 0;
      if (myDmgOnVictim >= 50) {
        this.state.totalSuppCount++;
      }
    }

    if (isTeammateKiller && !isMeKiller && victimName) {
      this.checkAndResolveInitiativeAssist(victimName);
    }

    if (isMeKiller || isTeammateKiller) {
      if (wId && wId !== "Unknown" && !isTeammateVictim) {
        const cleanWId = wId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, "");
        if (!this.isIgnoredWeapon(wId, cleanWId, e.damageTypeCategory)) {
          if (isMeKiller) {
            const wStat = this.state.weaponStats.get(cleanWId) || { kills: 0, dbnos: 0, damage: 0, hits: 0 };
            wStat.kills++;
            this.updateHitDetails(wStat, e.damageReason || (e.killerDamageInfo && e.killerDamageInfo.damageReason), 0, false, false, true);
            this.state.weaponStats.set(cleanWId, wStat);
          } else {
            const squadWMap = this.state.squadWeaponStats;
            let pStats = squadWMap.get(killerName);
            if (!pStats) {
              pStats = new Map();
              squadWMap.set(killerName, pStats);
            }
            const wStat = pStats.get(cleanWId) || { weapon: cleanWId, kills: 0, dbnos: 0, damage: 0, hits: 0, shots: 0 };
            wStat.kills++;
            this.updateHitDetails(wStat, e.damageReason || (e.killerDamageInfo && e.killerDamageInfo.damageReason), 0, false, false, true);
            pStats.set(cleanWId, wStat);
          }
        }
      }
    }

    if (isMeKiller) {
      this.state.myActionTimestamps.push(ts);
      this.updateDuelOutcome(e.killer, e.victim);
      const killerLoc = attackerObj?.location || attackerObj?.loc;
      const victimLoc = e.victim?.location || e.victim?.loc;
      const dist = Math.round(calcDist3D(killerLoc, victimLoc) / 100);

      // [V59.0] 차량 탑승 킬 감지 (로드킬 제외)
      const dmgCat = (e.damageTypeCategory || "").toLowerCase();
      const isRoadkill = dmgCat.includes("vehicle");
      if (!isRoadkill) {
        if (e.victim?.isInVehicle === true) {
          this.state.leadShotKills++;
        }
        if (attackerObj?.isInVehicle === true) {
          this.state.ridingShotKills++;
        }
      } else {
        // [V60.0] 차량 충돌 킬(로드킬) 누계
        this.state.roadKills++;
      }

      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'KILL',
        weapon: WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|Vehicle_|BP_|_Projectile|_C/g, ""),
        victim: e.victim?.name || victimName,
        distance: dist !== 10 ? dist : undefined,
        isHeadshot: e.damageReason === "HeadShot" || e.killer?.damageReason === "HeadShot",
        isMe: true,
        x: scaleCoordinate(this.state.playerLocations.get(this.state.lowerNickname)?.x || killerLoc?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(this.state.lowerNickname)?.y || killerLoc?.y || 0, this.state.mapSize),
        playerName: this.state.canonicalNickname,
        victimX: scaleCoordinate(this.state.playerLocations.get(victimName)?.x || victimLoc?.x || 0, this.state.mapSize),
        victimY: scaleCoordinate(this.state.playerLocations.get(victimName)?.y || victimLoc?.y || 0, this.state.mapSize)
      });

      if (victimName && !this.state.teamNames.has(victimName)) {
        const hitInfo = this.state.teamsUserHit.get(victimName);
        const isAssist =
          hitInfo !== undefined &&
          hitInfo.totalDamage >= TACTICAL_THRESHOLDS.ASSIST_DAMAGE_THRESHOLD &&
          (ts - hitInfo.lastHitTime) <= TACTICAL_THRESHOLDS.ASSIST_TIME_LIMIT_MS;
        if (isAssist) this.state.killContribution.assist++;
        else {
          // [유지 결정] 타 적 스쿼드가 기절시킨 적을 내가 가로채서 확킬한 경우(cleanup)도 현재는 게임 내 솔로 킬 수와 일치를 위해 solo++로 유지함.
          // 향후 순수 1:1 교전 실력을 더 엄격히 구분하고자 할 경우, dBNOMaker!==나 && dBNOMaker!=="" 조건을 대조하여 cleanup++로 세분화 가능.
          this.state.killContribution.solo++;
        }
      }
    } else if (isMeFinisher) {
      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'FINISH',
        weapon: WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|Vehicle_|BP_|_Projectile|_C/g, ""),
        victim: e.victim?.name || victimName,
        attacker: e.killer?.name || e.finisher?.name || killerName || dBNOMakerName || "Unknown",
        isMe: true,
        x: scaleCoordinate(attackerObj?.location?.x ?? (this.state.playerLocations.get(this.state.lowerNickname)?.x || 0), this.state.mapSize),
        y: scaleCoordinate(attackerObj?.location?.y ?? (this.state.playerLocations.get(this.state.lowerNickname)?.y || 0), this.state.mapSize),
        playerName: this.state.canonicalNickname
      });
    } else if (isTeammateKiller) {
      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'TEAM_KILL',
        attacker: e.killer?.name || killerName,
        victim: e.victim?.name || victimName,
        weapon: WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|Vehicle_|BP_|_Projectile|_C/g, ""),
        isMe: false,
        x: scaleCoordinate(this.state.playerLocations.get(killerName)?.x || attackerObj?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(killerName)?.y || attackerObj?.location?.y || 0, this.state.mapSize),
        playerName: e.killer?.name || killerName || "Teammate",
        victimX: scaleCoordinate(this.state.playerLocations.get(victimName)?.x || e.victim?.location?.x || 0, this.state.mapSize),
        victimY: scaleCoordinate(this.state.playerLocations.get(victimName)?.y || e.victim?.location?.y || 0, this.state.mapSize)
      });
    }

    if (victimName) {
      this.state.playerAliveStatus.set(victimName, false);

      const vRosterId = this.state.teamMapping.get(victimName);
      if (vRosterId && vRosterId !== this.state.myRosterId) {
        const members = this.state.teamAliveMembers.get(vRosterId);
        if (members) {
          members.delete(victimName);
          if (members.size === 0 && (this.state.teamsRosterHit.has(vRosterId) || killerName === this.state.lowerNickname)) {
            this.state.wipedTeamsByUserParticipation.add(vRosterId);
          }
        }
      }
    }

    if (isTeammateVictim) {
      this.state.playerAliveStatus.set(victimName, false);
      if (!isMeVictim) {
        this.state.timeline.push({
          ts: ts - this.state.matchStartTime,
          type: 'TEAM_DIED',
          attacker: e.killer?.name || e.finisher?.name || killerName || finisherName || "Unknown",
          victim: e.victim?.name || victimName,
          weapon: WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|Vehicle_|BP_|_Projectile|_C/g, ""),
          isMe: false,
          x: scaleCoordinate(this.state.playerLocations.get(victimName)?.x || e.victim?.location?.x || 0, this.state.mapSize),
          y: scaleCoordinate(this.state.playerLocations.get(victimName)?.y || e.victim?.location?.y || 0, this.state.mapSize),
          playerName: e.victim?.name || victimName,
          attackerX: scaleCoordinate(this.state.playerLocations.get(killerName)?.x || (typeof e.killer !== 'string' ? e.killer?.location?.x : 0) || 0, this.state.mapSize),
          attackerY: scaleCoordinate(this.state.playerLocations.get(killerName)?.y || (typeof e.killer !== 'string' ? e.killer?.location?.y : 0) || 0, this.state.mapSize)
        });
      }
    }

    if (isMeVictim) {
      this.state.myDeathTime = ts;
      // [BUG-FIX] 사망 순간의 페이즈를 즉시 스냅샷으로 저장 (이후 currentPhase 덮어쓰기 방지)
      this.state.deathPhaseSnapshot = this.state.currentPhase;
      this.state.playerAliveStatus.set(this.state.lowerNickname, false);
      this.state.playerAliveStatus.set(this.state.myAccountId, false);
      this.updateDuelOutcome(e.killer || e.finisher || e.dBNOMaker, e.victim);
      const killerLoc = attackerObj?.location || attackerObj?.loc;
      const myLoc = this.state.playerLocations.get(this.state.lowerNickname);
      if (killerLoc && myLoc) this.state.deathDistance = Math.round(calcDist3D(killerLoc, myLoc) / 100);
      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'DIED',
        attacker: e.killer?.name || e.finisher?.name || killerName || finisherName || "Unknown",
        weapon: WEAPON_NAMES[wId] || wId.replace(/Item_Weapon_|Weap|Vehicle_|BP_|_Projectile|_C/g, ""),
        isMe: true,
        x: scaleCoordinate(myLoc?.x ?? 0, this.state.mapSize),
        y: scaleCoordinate(myLoc?.y ?? 0, this.state.mapSize),
        playerName: this.state.canonicalNickname,
        attackerX: scaleCoordinate(this.state.playerLocations.get(killerName)?.x || attackerObj?.location?.x || 0, this.state.mapSize),
        attackerY: scaleCoordinate(this.state.playerLocations.get(killerName)?.y || attackerObj?.location?.y || 0, this.state.mapSize)
      });
    }
  }

  private handleRevive(e: any, ts: number) {
    const isMeReviver = this.isMe(e.reviver);
    const isTeammateReviver = this.isTeammate(e.reviver);
    const isMeVictim = this.isMe(e.victim);
    const isTeammateVictim = this.isTeammate(e.victim);
    const victimName = normalizeName(e.victim?.name || "");

    const isPreviouslyDead = this.state.playerAliveStatus.get(victimName) === false;

    const revType = (e.reviveType || "").toLowerCase();
    const isBr = revType === "br" || revType === "redeploy";
    const isRecall = revType === "recall" || revType === "bluechip" || isPreviouslyDead;

    if (isRecall || isBr) {
      this.handleRecall(e, ts, isBr);
      return;
    }
    this.state.playerAliveStatus.set(victimName, true);

    if (isTeammateReviver || isTeammateVictim) {
      this.state.totalReviveEvents.push(ts);
      
      const isSelfRevive = isMeReviver && isMeVictim;
      const reviverLoc = e.reviver?.location || e.reviver?.loc;

      if (isMeReviver) {
        this.state.myReviveCount++;
        this.state.myActionTimestamps.push(ts);
        this.state.timeline.push({ 
          ts: ts - this.state.matchStartTime, 
          type: 'REVIVE', 
          attacker: e.reviver?.name || this.state.canonicalNickname,
          victim: e.victim?.name || victimName,
          isMe: true,
          isSelfRevive,
          x: scaleCoordinate(reviverLoc?.x ?? (this.state.playerLocations.get(this.state.lowerNickname)?.x || 0), this.state.mapSize),
          y: scaleCoordinate(reviverLoc?.y ?? (this.state.playerLocations.get(this.state.lowerNickname)?.y || 0), this.state.mapSize)
        });
      } else {
        this.state.timeline.push({ 
          ts: ts - this.state.matchStartTime, 
          type: isMeVictim ? 'REVIVE' : 'TEAM_REVIVE', 
          attacker: e.reviver?.name || "동료", 
          victim: e.victim?.name || victimName,
          isMe: isMeVictim,
          isRecall: false,
          isSelfRevive: false,
          x: scaleCoordinate(reviverLoc?.x ?? (this.state.playerLocations.get(normalizeName(e.reviver?.name || ""))?.x || 0), this.state.mapSize),
          y: scaleCoordinate(reviverLoc?.y ?? (this.state.playerLocations.get(normalizeName(e.reviver?.name || ""))?.y || 0), this.state.mapSize)
        });
      }
    }
  }

  private handleRecall(e: any, ts: number, forceBr: boolean = false) {
    const recaller = e.recaller || e.reviver || e.attacker;
    const isMeRecaller = this.isMe(recaller);
    const isTeammateRecaller = this.isTeammate(recaller);

    const victims: any[] = [];
    if (e.recalledPlayers && Array.isArray(e.recalledPlayers)) {
      e.recalledPlayers.forEach((p: any) => victims.push(p));
    } else {
      // character (LogPlayerRecallShip, LogPlayerRedeploy), victim (LogPlayerRevive-Recall)
      victims.push(e.victim || e.character || e.recallingPlayer || e.recalledPlayer);
    }

    const eventType = e._T || "";
    const isRedeploy = forceBr || 
                      eventType.toLowerCase().includes("redeploy") || 
                      (e.reviveType || "").toLowerCase() === "br";

    victims.forEach(v => {
      if (!v) return;
      const vName = normalizeName(v.name || "");
      const isTeammateVictim = this.isTeammate(v);
      const isMeVictim = this.isMe(v);

      if (isTeammateRecaller || isTeammateVictim || isMeVictim || isMeRecaller) {
        const isPreviouslyDead = this.state.playerAliveStatus.get(vName) === false;
        if (isPreviouslyDead) {
          // [V26.1] UI 표시를 위해 원본 이름(v.name) 보존하여 기록
          const displayName = v.name || vName; 
          this.state.timeline.push({
            ts: ts - this.state.matchStartTime,
            type: isRedeploy ? 'REDEPLOY' : (isMeVictim ? 'RECALL' : 'TEAM_RECALL'),
            attacker: recaller?.name || "시스템", // 원본 이름 보존
            victim: displayName,
            isMe: isMeVictim || isMeRecaller,
            isRecall: !isRedeploy,
            x: scaleCoordinate(v.location?.x ?? (this.state.playerLocations.get(vName)?.x || 0), this.state.mapSize),
            y: scaleCoordinate(v.location?.y ?? (this.state.playerLocations.get(vName)?.y || 0), this.state.mapSize)
          });
        }
        this.state.playerAliveStatus.set(vName, true);
        if (isMeVictim) {
          this.state.myDeathTime = null;
        }
      }
    });
  }

  private processDuelData(e: any, ts: number, attacker: any, victim: any) {
    if (!attacker || !victim) return;

    // [거리 제한 가드] 150m를 초과하는 장거리 피격은 피지컬 대응사격 측정(교전 세션)에서 제외
    const attackerLoc = attacker.location || attacker.loc;
    const victimLoc = victim.location || victim.loc;
    if (attackerLoc && victimLoc) {
      const distMeters = calcDist3D(attackerLoc, victimLoc) / 100;
      if (distMeters > TACTICAL_THRESHOLDS.REACTION_MAX_DISTANCE_METERS) {
        return;
      }
    }

    const attackerName = normalizeName(attacker?.name || "");
    const victimName = normalizeName(victim?.name || "");

    [attacker, victim].forEach(char => {
      if (!char) return;
      const isMe = this.isMe(char);
      const isElite = this.isElite(char);
      if (isMe || isElite) {
        const myName = isMe ? this.state.myAccountId : (char.accountId || normalizeName(char.name));
        let pData = this.state.playerCombatData.get(myName);
        if (!pData) {
          pData = { total: 0, success: 0, duelWins: 0, duelLosses: 0, reversalWins: 0, reversalAttempts: 0, sessions: new Map() };
          this.state.playerCombatData.set(myName, pData);
        }
        
        const opponent = char === attacker ? victimName : attackerName;
        let session = pData.sessions.get(opponent);
        const lastActivity = session ? Math.max(session.lastHitByEnemy || 0, session.lastHitByUser || 0) : 0;
        const isExpired = session && ts - lastActivity > 180000;

        if (!session || isExpired) {
          session = {
            lastHitByEnemy: char === victim ? ts : 0,
            lastHitByUser: char === attacker ? ts : 0,
            userStarted: char === attacker,
            alreadySucceeded: false,
            outcome: null
          };
          pData.sessions.set(opponent, session);
          if (char === attacker) pData.total++;
          else pData.reversalAttempts++;
        } else {
          if (char === attacker) {
            session.lastHitByUser = ts;
            if (!session.userStarted && session.lastHitByEnemy > 0 && pData.reversalAttempts > 0) {
              const latency = ts - session.lastHitByEnemy;
              if (latency >= 0 && latency < 3000) {
                this.state.reactLatSum += latency;
                this.state.reactCount++;
              }
            }
          } else {
            session.lastHitByEnemy = ts;
          }
        }
      }
    });
  }

  private updateDuelOutcome(attacker: any, victim: any) {
    if (!attacker || !victim) return;
    const attackerName = normalizeName(attacker.name || "");
    const victimName = normalizeName(victim.name || "");

    [attacker, victim].forEach(char => {
      const isMe = this.isMe(char);
      if (isMe || this.isElite(char)) {
        const myName = isMe ? this.state.myAccountId : (char.accountId || normalizeName(char.name));
        const pData = this.state.playerCombatData.get(myName);
        if (pData) {
          const opponent = char === attacker ? victimName : attackerName;
          const session = pData.sessions.get(opponent);
          if (session && !session.outcome) {
            if (char === attacker) {
              session.outcome = "win";
              pData.duelWins++;
              if (session.userStarted && !session.alreadySucceeded) {
                pData.success++;
                session.alreadySucceeded = true;
              }
              if (!session.userStarted) pData.reversalWins++;
            } else {
              session.outcome = "lose";
              pData.duelLosses++;
            }
          }
        }
      }
    });
  }

  private checkAndResolveInitiativeAssist(victimName: string) {
    const isSoloMode = this.state.teamNames.size <= 1;
    if (isSoloMode) return;

    const pData = this.state.playerCombatData.get(this.state.myAccountId);
    if (!pData) return;

    const session = pData.sessions.get(victimName);
    if (session && session.userStarted && !session.alreadySucceeded && !session.outcome) {
      const myDmg = this.state.myVictimDamage.get(victimName) || 0;
      if (myDmg >= TACTICAL_THRESHOLDS.ASSIST_DAMAGE_THRESHOLD) {
        session.outcome = "win";
        pData.duelWins++;
        pData.success++;
        session.alreadySucceeded = true;
      }
    }
  }

  private handleMatchEnd(e: any) {
    if (!e.allWeaponStats || !Array.isArray(e.allWeaponStats)) return;

    // 1. accountId -> canonicalName 맵 구축
    const accountToNameMap = new Map<string, string>();
    if (e.characters && Array.isArray(e.characters)) {
      e.characters.forEach((c: any) => {
        const char = c.character || c;
        if (char && char.accountId && char.name) {
          accountToNameMap.set(char.accountId, char.name);
        }
      });
    }

    // 2. allWeaponStats 순회
    e.allWeaponStats.forEach((playerStat: any) => {
      const accId = playerStat.accountId;
      if (!accId) return;

      const isMe = accId === this.state.myAccountId;
      const isTeammate = this.state.teamAccountIds.has(accId) && !isMe;

      if (isMe) {
        // 본인 무기 통계 정밀 오버라이트 보정
        if (playerStat.stats && Array.isArray(playerStat.stats)) {
          playerStat.stats.forEach((w: any) => {
            const wId = w.weapon || "Unknown";
            const cleanWId = wId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, "");
            
            // 제외 무기 필터링 (투척물, 주먹, 프라이팬, 캐릭터 오브젝트, C4, 자전거 등 분석 배제)
            if (
              IGNORE_WEAPONS.includes(wId) || 
              IGNORE_WEAPONS.includes(cleanWId) ||
              cleanWId === "None" ||
              cleanWId === "Unknown" ||
              cleanWId.startsWith("Proj") ||
              cleanWId.includes("Projectile") ||
              cleanWId.includes("Grenade") ||
              cleanWId.includes("Molotov") ||
              cleanWId.includes("Smoke") ||
              cleanWId.includes("Flash") ||
              cleanWId.includes("Sticky") ||
              cleanWId.includes("PlayerFemale") ||
              cleanWId.includes("PlayerMale") ||
              cleanWId.includes("Punch") ||
              cleanWId.includes("Melee") ||
              cleanWId.includes("Pan") ||
              cleanWId.includes("Cowbar") ||
              cleanWId.includes("Crowbar") ||
              cleanWId.includes("C4") ||
              cleanWId.includes("Bike") ||
              cleanWId.includes("Flare")
            ) {
              return;
            }
            
            const existing = this.state.weaponStats.get(cleanWId) || { kills: 0, dbnos: 0, damage: 0, hits: 0 };
            
            // 1. API(w)의 누적 딜량 대신, 우리가 handleDamage에서 정밀 계산한 순수 대인 유효 딜량(existing.damage)을 최종 유지함.
            // 2. 단, 무기의 shots, holdingTime 등 메타정보는 API 값을 반영함.
            existing.shots = w.shots ?? 0;
            existing.dBNODamage = w.dBNODamage ?? 0;
            existing.dBNOHits = w.dBNOHits ?? 0;
            existing.holdingTime = w.holdingTime ?? 0;
            
            // [V60.0 Fallback] API(w)의 hitDetails가 비어있지 않으면 우선 적용, 비어있으면 실시간 누적본(existing.hitDetails)을 유지함.
            if (w.hitDetails && Array.isArray(w.hitDetails) && w.hitDetails.length > 0) {
              existing.hitDetails = w.hitDetails;
            } else {
              existing.hitDetails = existing.hitDetails || [];
            }
            
            existing.accuracy = existing.shots > 0 ? Math.round((existing.hits / existing.shots) * 100) : 0;

            // [V58.4 Fix] 킬/기절 데이터를 API 최상위 필드 또는 hitDetails에서 합산하여 복구
            let hdKills = 0;
            let hdDbnos = 0;
            if (Array.isArray(existing.hitDetails)) {
              existing.hitDetails.forEach((hd: any) => {
                hdKills += hd.kills || 0;
                hdDbnos += hd.dBNOs || hd.dbnos || 0;
              });
            }
            existing.kills = Math.max(existing.kills || 0, w.kills || 0, hdKills);
            existing.dbnos = Math.max(existing.dbnos || 0, w.dBNOs || w.dbnos || 0, hdDbnos);

            // 3. 만약 정제된 순수 유효 딜량과 타격수가 모두 0인 무기(들고만 다녔거나, 0딜 권총 등)인 경우 목록에서 완전히 소거
            if (existing.damage === 0 && existing.hits === 0) {
              this.state.weaponStats.delete(cleanWId);
              return;
            }

            this.state.weaponStats.set(cleanWId, existing);
          });
        }
      } else if (isTeammate) {
        // 아군 무기 통계 적재
        const tName = accountToNameMap.get(accId) || accId;
        const realTimeSquadStatsKey = normalizeName(tName);
        const tWeaponList: any[] = [];
        
        // [V60.0 Fallback] 실시간 수집된 해당 아군의 무기 맵 가져오기
        const realTimeSquadStatsMap = this.state.squadWeaponStats.get(realTimeSquadStatsKey);

        if (playerStat.stats && Array.isArray(playerStat.stats)) {
          playerStat.stats.forEach((w: any) => {
            const wId = w.weapon || "Unknown";
            const cleanWId = wId.replace(/Item_Weapon_|Weap|_Projectile|_C/g, "");
            
            // 제외 무기 필터링 (투척물, 주먹, 프라이팬, 캐릭터 오브젝트, C4, 자전거 등 분석 배제)
            if (
              IGNORE_WEAPONS.includes(wId) || 
              IGNORE_WEAPONS.includes(cleanWId) ||
              cleanWId === "None" ||
              cleanWId === "Unknown" ||
              cleanWId.startsWith("Proj") ||
              cleanWId.includes("Projectile") ||
              cleanWId.includes("Grenade") ||
              cleanWId.includes("Molotov") ||
              cleanWId.includes("Smoke") ||
              cleanWId.includes("Flash") ||
              cleanWId.includes("Sticky") ||
              cleanWId.includes("PlayerFemale") ||
              cleanWId.includes("PlayerMale") ||
              cleanWId.includes("Punch") ||
              cleanWId.includes("Melee") ||
              cleanWId.includes("Pan") ||
              cleanWId.includes("Cowbar") ||
              cleanWId.includes("Crowbar") ||
              cleanWId.includes("C4") ||
              cleanWId.includes("Bike") ||
              cleanWId.includes("Flare")
            ) {
              return;
            }
            
            const realTimeWStat = (realTimeSquadStatsMap && typeof realTimeSquadStatsMap.get === "function")
              ? realTimeSquadStatsMap.get(cleanWId)
              : undefined;

            const apiDamage = w.damage ?? 0;
            const apiHits = w.hits ?? 0;
            const finalDamage = (apiDamage === 0 && realTimeWStat) ? (realTimeWStat.damage ?? 0) : apiDamage;
            const finalHits = (apiHits === 0 && realTimeWStat) ? (realTimeWStat.hits ?? 0) : apiHits;

            // 0딜 및 0히트인 아군 무기는 스쿼드 무기 목록에서 완전히 소거
            if (finalDamage === 0 && finalHits === 0) {
              return;
            }

            let finalHitDetails = w.hitDetails ?? [];
            if ((!finalHitDetails || finalHitDetails.length === 0) && realTimeWStat && realTimeWStat.hitDetails) {
              finalHitDetails = realTimeWStat.hitDetails;
            }

            // [V58.4 Fix] 아군 스쿼드 무기 통계에서도 킬/기절 데이터를 정상 추출
            let tHdKills = 0;
            let tHdDbnos = 0;
            if (Array.isArray(finalHitDetails)) {
              finalHitDetails.forEach((hd: any) => {
                tHdKills += hd.kills || 0;
                tHdDbnos += hd.dBNOs || hd.dbnos || 0;
              });
            }

            tWeaponList.push({
              weapon: cleanWId,
              damage: finalDamage,
              dBNODamage: w.dBNODamage ?? 0,
              shots: w.shots ?? 0,
              hits: finalHits,
              dBNOHits: w.dBNOHits ?? 0,
              holdingTime: w.holdingTime ?? 0,
              hitDetails: finalHitDetails,
              accuracy: w.shots > 0 ? Math.round((finalHits / w.shots) * 100) : 0,
              kills: Math.max(w.kills || 0, tHdKills),
              dbnos: Math.max(w.dBNOs || w.dbnos || 0, tHdDbnos)
            });
          });
        }
        
        if (tWeaponList.length > 0) {
          // 실시간 수집은 normalizeName 키, 공식 종료 통계는 원래 닉네임 키를 사용한다.
          // 둘을 함께 남기면 화면에서 같은 팀원의 딜이 이중 합산되므로 실시간 키를 교체한다.
          if (realTimeSquadStatsKey !== tName) {
            this.state.squadWeaponStats.delete(realTimeSquadStatsKey);
          }
          this.state.squadWeaponStats.set(tName, tWeaponList);
        }
      }
    });
  }
}
