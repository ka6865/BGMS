import { BaseHandler } from './BaseHandler';
import { normalizeName, calcDist3D, scaleCoordinate } from '../utils';
import { WEAPON_NAMES } from '../constants';

export class UtilityHandler extends BaseHandler {
  private processedThrowIds = new Set<string>();
  private underCoverKnocks = new Set<string>(); // victim + knock timestamp; simultaneous knocks remain distinct
  private victimToKnockTs = new Map<string, number>(); // 피해자 이름 -> 기절 시점 매핑

  private getThrowEventKey(e: any, ts: number, actorName: string, itemId: string): string {
    const rawAttackId = e.attackId ?? e.attack_id ?? e.projectileId;
    if (rawAttackId !== undefined && rawAttackId !== null && rawAttackId !== "") {
      return `attack:${actorName}:${String(rawAttackId)}`;
    }
    return `fallback:${actorName || "unknown"}:${itemId || "unknown"}:${ts}`;
  }

  handleEvent(e: any, ts: number): void {
    switch (e._T) {
      case "LogPlayerTakeDamage":
        this.handleUtilityDamage(e);
        break;
      case "LogItemUse":
        this.handleItemUse(e);
        break;
      case "LogPlayerUseHeal":
        this.handleHeal(e, ts);
        break;
      case "LogPlayerUseThrowable":
        this.handleUseThrowable(e, ts);
        break;
      case "LogHeal":
        this.handleHeal(e, ts);
        break;
      case "LogThrowableUse":
        this.handleThrowable(e, ts);
        break;
      case "LogWeaponFire":
        this.handleWeaponFire(e, ts);
        break;
      case "LogPlayerRevive":
        this.handleRevive(e);
        break;
      case "LogPlayerKill":
      case "LogPlayerKillV2":
        this.handleKill(e);
        break;
      case "LogPlayerMakeGroggy":
      case "LogPlayerMakeDBNO":
        this.handleDown(e, ts);
        break;
    }
  }

  private handleUseThrowable(e: any, ts: number) {
    const attackerName = normalizeName(e.attacker?.name || e.character?.name || "");
    const itemId = (e.weaponId || e.weapon?.itemId || e.weapon?.name || "").toLowerCase();
    const throwKey = this.getThrowEventKey(e, ts, attackerName, itemId);

    const isMeAttacker = this.isMe(e.attacker || e.character);
    const isTeammateAttacker = this.isTeammate(e.attacker || e.character);

    // 본인 또는 팀원이 투척물을 던진 경우
    if (isTeammateAttacker && !this.processedThrowIds.has(throwKey)) {
      this.processedThrowIds.add(throwKey);
      if (isMeAttacker) {
        this.state.itemUseStats.throwCount++;
      }

      // [V41.0] 타임라인 기록 (매핑 테이블 우선 순위, 대소문자 무시 정규식 적용)
      const mappedName = WEAPON_NAMES[e.weaponId] || WEAPON_NAMES[itemId] || itemId.replace(/Item_Weapon_|Weap|_C/gi, "");

      // 이름이 없는 아이템은 제외
      if (!mappedName || mappedName.trim() === "") return;

      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'ITEM_USE',
        weapon: mappedName,
        attacker: isMeAttacker ? undefined : (e.attacker?.name || e.character?.name || attackerName),
        playerName: isMeAttacker ? this.state.canonicalNickname : (e.attacker?.name || e.character?.name || attackerName),
        x: scaleCoordinate(this.state.playerLocations.get(attackerName)?.x || (e.attacker || e.character)?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(attackerName)?.y || (e.attacker || e.character)?.location?.y || 0, this.state.mapSize)
      });

      if (itemId.includes("smoke") || itemId.includes("m79")) {
        if (isMeAttacker) {
          this.state.itemUseSummary.smokes = (this.state.itemUseSummary.smokes || 0) + 1;

          // [V14.2] handleUseThrowable에서도 세이브 판정 로직 수행 (LogThrowableUse 누락 대비)
          this.markSmokeAttempt(e.attacker || e.character, ts);
        }
      } else if (itemId.includes("grenade") || itemId.includes("c4")) {
        if (isMeAttacker) {
          this.state.itemUseSummary.frags = (this.state.itemUseSummary.frags || 0) + 1;
          this.state.itemUseStats.lethalThrowCount++;
        }
      } else if (itemId.includes("molotov")) {
        if (isMeAttacker) {
          this.state.itemUseSummary.molotovs = (this.state.itemUseSummary.molotovs || 0) + 1;
          this.state.itemUseStats.lethalThrowCount++;
        }
      } else {
        if (isMeAttacker) {
          this.state.itemUseSummary.others = (this.state.itemUseSummary.others || 0) + 1;
        }
      }
    }
  }


  private handleUtilityDamage(e: any) {
    const dmgCat = (e.damageTypeCategory || "").toLowerCase();
    const weapon = (e.damageCauserName || e.damageCauser?.itemId || e.weaponId || "").toLowerCase();
    const damage = e.damage || 0;

    if (this.isMe(e.attacker)) {
      const isUtility = ["grenade", "molotov", "c4", "explosion", "explosive"].some(k =>
        dmgCat.includes(k) || weapon.includes(k)
      );
      if (isUtility) {
        this.state.utilitySummary.totalDamage += damage;
        this.state.utilitySummary.hitCount++;
        this.state.combatPressure.utilityDamage += damage;
        this.state.combatPressure.utilityHits++;
      }
    }
  }

  private handleItemUse(e: any) {
    if (this.isMe(e.character)) {
      const itemId = (e.item?.itemId || e.item?.name || e.itemId || "").toLowerCase();

      // 투척물 (LogItemUse로 기록됨)
      const isThrowable = itemId.includes("grenade") || itemId.includes("smoke") || itemId.includes("flashbang") || itemId.includes("molotov");
      if (isThrowable) {
        // LogItemUse는 인벤토리 사용(핀 뽑기 등) 시점에 발생할 수 있으나, throwCount 중복 방지를 위해 UseThrowable과 이원화 관리
        if (itemId.includes("smoke")) {
          // 이미 handleUseThrowable에서 처리하므로 여기서는 세부 로그 보정만 수행
        }
      }
    }
  }

  private handleHeal(e: any, ts: number) {
    const characterName = normalizeName(e.character?.name || "");
    const isMe = this.isMe(e.character);
    // 본인 또는 팀원이 아이템을 사용한 경우
    if (isMe || this.isTeammate(e.character)) {
      const itemId = (e.item?.itemId || e.item?.name || e.itemId || "").toLowerCase();

      // [V41.0] 타임라인 기록 (매핑 테이블 우선 순위, 대소문자 무시 정규식 적용)
      const mappedName = WEAPON_NAMES[e.item?.itemId] || WEAPON_NAMES[itemId] || itemId.replace(/Item_Weapon_|Item_Heal_|Item_Boost_|_C/gi, "");

      // 이름이 없는 아이템(불필요한 시스템 로그)은 타임라인에서 제외
      if (!mappedName || mappedName.trim() === "") return;

      this.state.timeline.push({
        ts: ts - this.state.matchStartTime,
        type: 'ITEM_USE',
        weapon: mappedName,
        attacker: isMe ? undefined : (e.character?.name || characterName),
        playerName: isMe ? this.state.canonicalNickname : (e.character?.name || characterName),
        x: scaleCoordinate(this.state.playerLocations.get(characterName)?.x || e.character?.location?.x || 0, this.state.mapSize),
        y: scaleCoordinate(this.state.playerLocations.get(characterName)?.y || e.character?.location?.y || 0, this.state.mapSize)
      });

      if (!isMe) return;

      if (itemId.includes("firstaid") || itemId.includes("medkit") || itemId.includes("bandage")) {
        this.state.itemUseStats.heals++;
      } else if (itemId.includes("energydrink") || itemId.includes("painkiller") || itemId.includes("adrenaline")) {
        this.state.itemUseStats.boosts++;
      }
    }
  }

  private markSmokeAttempt(actor: any, ts: number) {
    const myLoc = actor?.location ?? actor?.loc ?? this.state.playerLocations.get(this.state.lowerNickname);
    if (!myLoc) return;
    for (const [victim, knockTs] of this.victimToKnockTs) {
      const key = `${victim}:${knockTs}`;
      if (ts < knockTs || ts - knockTs >= 20000 || this.underCoverKnocks.has(key)) continue;
      const victimLoc = this.state.playerLocations.get(victim);
      const distanceM = victimLoc ? calcDist3D(myLoc, victimLoc) / 100 : NaN;
      if (!Number.isFinite(distanceM) || distanceM >= 100) continue;
      this.state.totalSmokeCount++;
      this.underCoverKnocks.add(key);
      break;
    }
  }

  private handleRevive(e: any) {
    const victim = normalizeName(e.victim?.name || "");
    const knockTs = this.victimToKnockTs.get(victim);
    if (knockTs !== undefined && this.underCoverKnocks.delete(`${victim}:${knockTs}`)) {
      this.state.totalSmokeRescues++;
    }
    // Every revive closes the episode, even if no smoke was used.
    this.victimToKnockTs.delete(victim);
  }

  private handleKill(e: any) {
    const victim = normalizeName(e.victim?.name || "");
    const knockTs = this.victimToKnockTs.get(victim);
    if (knockTs !== undefined) this.underCoverKnocks.delete(`${victim}:${knockTs}`);
    this.victimToKnockTs.delete(victim);
  }

  private handleThrowable(e: any, ts: number) {
    const isMe = this.isMe(e.attacker || e.character);
    const actorName = normalizeName(e.attacker?.name || e.character?.name || "");
    const wId = (e.weaponId || e.weapon?.itemId || e.weapon?.name || "").toLowerCase();
    const throwKey = this.getThrowEventKey(e, ts, actorName, wId);

    if (isMe && !this.processedThrowIds.has(throwKey)) {
      this.processedThrowIds.add(throwKey);

      // 연막 세이브 판정 강화 (V14.2: 시간 + 거리 기반)
      if (wId.includes("smoke") || wId.includes("m79")) {
        this.markSmokeAttempt(e.attacker || e.character, ts);
      }

      this.state.myActionTimestamps.push(ts);
      this.state.utilityTracker.set(e.attackId ?? throwKey, {
        type: wId, ts, damage: 0, hits: 0, kills: 0, isLanded: false
      });
      this.state.itemUseStats.throwCount++;

      if (wId.includes("smoke")) this.state.itemUseSummary.smokes++;
      else if (wId.includes("grenade")) {
        this.state.itemUseSummary.frags++;
        this.state.itemUseStats.lethalThrowCount++;
      }
      else if (wId.includes("molotov")) {
        this.state.itemUseSummary.molotovs++;
        this.state.itemUseStats.lethalThrowCount++;
      }
      else {
        this.state.itemUseSummary.others++;
      }
    }
  }

  private handleWeaponFire(e: any, ts: number) {
    const weaponId = (e.weaponId || "").toLowerCase();

    if (this.isMe(e.character) && weaponId.includes("m79")) {
      const actorName = normalizeName(e.character?.name || "");
      const fireId = this.getThrowEventKey(e, ts, actorName, weaponId);
      if (this.processedThrowIds.has(fireId)) return;
      this.processedThrowIds.add(fireId);

      this.markSmokeAttempt(e.character, ts);
      this.state.itemUseStats.throwCount++;
      this.state.itemUseSummary.smokes = (this.state.itemUseSummary.smokes || 0) + 1;
    }
  }

  private handleDown(e: any, ts: number) {
    const victimName = normalizeName(e.victim?.name || "");

    if (this.isTeammate(e.victim)) {
      this.victimToKnockTs.set(victimName, ts);
    }
  }
}
