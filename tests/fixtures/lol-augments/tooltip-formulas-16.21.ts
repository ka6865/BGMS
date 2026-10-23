// 로컬 16.21 원본의 계산 입력과 선택 문장 회귀 사례다.
const formulaCases = [
  {
    "id": 1048,
    "tooltip": "스킬에 <crit>치명타</crit>가 적용되어 @CritDamageTooltip@% 증가한 피해를 입힐 수 있습니다.<br><br><crit>치명타 확률%i:scaleCrit%을" +
    " @CritGranted@</crit> 얻습니다.<br><br>챔피언에게 입힌 피해량: @f2@",
    "description": "스킬에 <crit>치명타</crit>가 적용될 수 있습니다. <br><br><crit>치명타 확률%i:scaleCrit%을 @CritGranted@</crit> 얻습니다.",
    "dataValues": [
      {
        "name": "CritDamage",
        "values": [
          1.4500000476837158
        ]
      },
      {
        "name": "CritChance",
        "values": [
          0.25
        ]
      },
      {
        "name": "CritConverRatio",
        "values": [
          0.00044999999227002263
        ]
      },
      {
        "name": "CritDamageTooltip",
        "values": [
          45
        ]
      }
    ],
    "calculations": {
      "CritGranted": {
        "mFormulaParts": [
          {
            "mDataValue": "CritChance",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mDataValue": "CritConverRatio",
            "__type": "StatByNamedDataValueCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      }
    },
    "expected": "스킬에 치명타가 적용될 수 있습니다. \n\n치명타 확률을 25% (+주문력 100당 4.5%) 얻습니다."
  },
  {
    "id": 1310,
    "tooltip": "<spellName>암습</spellName>: 뒤에서 공격 시 @BasicAttackDamage@의 <physicalDamage>추가 물리 피해</physicalDamage>를 " +
    "입힙니다.<br><br><spellName>속임수</spellName>: 근처로 순간이동해 @StealthDuration@초 동안 <keywordStealth>투명</keyword" +
    "Stealth> 상태가 됩니다. <keywordStealth>투명</keywordStealth> 상태에서 다음 기본 공격 시 <physicalDamage>@TotalDamage@의" +
    " 물리 피해</physicalDamage>를 추가로 입힙니다. 뒤에서 기본 공격 시 치명타가 적용되어 @QCritDamageMod@의 피해를 입힙니다.<br><br><spellNa" +
    "me>환각: 죽음</spellName>: 사망 시 <trueDamage>최대 체력의 @FearDamage*100@%에 해당하는 고정 피해</trueDamage>를 입히고 주변을 @" +
    "FearDuration@초 동안 공포에 빠뜨립니다.",
    "description": "<spellName>속임수</spellName> 소환사 주문을 얻습니다.<br><spellName>암습</spellName> 기본 지속 효과를 얻습니다.<br><br>사망 시, 엄" +
    "청난 <trueDamage>고정 피해</trueDamage>를 입히고 주변 적을 <status>공포</status>에 빠뜨립니다.",
    "dataValues": [
      {
        "name": "StealthDuration",
        "values": [
          3
        ]
      },
      {
        "name": "PseudoCastTime",
        "values": [
          0.125
        ]
      },
      {
        "name": "ExtraAATime",
        "values": [
          1
        ]
      },
      {
        "name": "CastRange",
        "values": [
          400
        ]
      },
      {
        "name": "FearDuration",
        "values": [
          1
        ]
      },
      {
        "name": "FearRadius",
        "values": [
          350
        ]
      },
      {
        "name": "FearDamage",
        "values": [
          0.25
        ]
      },
      {
        "name": "EDITDECEIVEFORREALVALUES",
        "values": [

        ]
      },
      {
        "name": "BaseDamage",
        "values": [
          100
        ]
      }
    ],
    "calculations": {
      "TotalDamage": {
        "mFormulaParts": [
          {
            "mDataValue": "BaseDamage",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mStat": 2,
            "mStatFormula": 2,
            "mCoefficient": 1.5,
            "__type": "StatByCoefficientCalculationPart"
          },
          {
            "mCoefficient": 0.550000011920929,
            "__type": "StatByCoefficientCalculationPart"
          }
        ],
        "__type": "GameCalculation"
      },
      "QCritDamageMod": {
        "mFormulaParts": [
          {
            "mSubparts": [
              {
                "mNumber": 1.5499999523162842,
                "__type": "NumberCalculationPart"
              },
              {
                "mStat": 9,
                "mStatFormula": 2,
                "mCoefficient": 1,
                "__type": "StatByCoefficientCalculationPart"
              }
            ],
            "__type": "SumOfSubPartsCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      },
      "BasicAttackDamage": {
        "mFormulaParts": [
          {
            "mStartValue": 20,
            "mEndValue": 35,
            "__type": "ByCharLevelInterpolationCalculationPart"
          },
          {
            "mCoefficient": 0.3499999940395355,
            "__type": "StatByCoefficientCalculationPart"
          },
          {
            "mStat": 2,
            "mStatFormula": 2,
            "mCoefficient": 0.5,
            "__type": "StatByCoefficientCalculationPart"
          }
        ],
        "__type": "GameCalculation"
      }
    },
    "expected": "암습: 뒤에서 공격 시 20~35 + 주문력의 35% + 추가 공격력의 50%의 추가 물리 피해를 입힙니다.\n\n속임수: 근처로 순간이동해 3초 동안 투명 상태가 됩니다. 투명 상태" +
    "에서 다음 기본 공격 시 100 + 추가 공격력의 150% + 주문력의 55%의 물리 피해를 추가로 입힙니다. 뒤에서 기본 공격 시 치명타가 적용되어 155% (+추가 치명타 피해" +
    "량 1%당 1%)의 피해를 입힙니다.\n\n환각: 죽음: 사망 시 최대 체력의 25%에 해당하는 고정 피해를 입히고 주변을 1초 동안 공포에 빠뜨립니다."
  },
  {
    "id": 1311,
    "tooltip": "<scaleMana>마나</scaleMana> 소모량이 2배가 됩니다. 스킬의 <healing>체력 회복량</healing>, <shield>보호막 흡수량</shield> 및 피해" +
    "량이 <scaleMana>@ManaCalc@</scaleMana> 증가합니다.",
    "description": "<scaleMana>마나</scaleMana> 소모량이 2배가 됩니다. <br><br>스킬의 <healing>체력 회복량</healing>, <shield>보호막 흡수량</shie" +
    "ld> 및 피해량이 <scaleMana>최대 마나</scaleMana>에 비례해 증가합니다.",
    "dataValues": [
      {
        "name": "InitialAmpPercent",
        "values": [
          10
        ]
      }
    ],
    "calculations": {
      "ManaCalc": {
        "mMultiplier": {
          "mNumber": 0.009999999776482582,
          "__type": "NumberCalculationPart"
        },
        "mFormulaParts": [
          {
            "mDataValue": "InitialAmpPercent",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mCoefficient": 0.004999999888241291,
            "__type": "AbilityResourceByCoefficientCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      }
    },
    "expected": "마나 소모량이 2배가 됩니다. 스킬의 체력 회복량, 보호막 흡수량 및 피해량이 10% (+최대 마나 100당 0.5%) 증가합니다."
  },
  {
    "id": 1334,
    "tooltip": "눈덩이의 스킬 가속이 @AbilityHaste@만큼 증가합니다. <br>대상에게 눈덩이가 적중하면 @BaseDuration@초 동안 영역을 생성하여 내부의 적을 @TotalSlow" +
    "Amount@만큼 <status>둔화</status>시키고 매초 <magicDamage>@TotalDamagePerSecond@의 마법 피해</magicDamage>를 입힙니다. " +
    "(최대 <magicDamage>@TotalDamage@의 마법 피해</magicDamage>)<br><br><br>",
    "description": "<spellName>눈덩이</spellName>의 스킬 가속이 @AbilityHaste@만큼 증가합니다. 적에게 눈덩이가 적중하면 눈이 내려 주변 적에게 <magic>광역 피해</" +
    "magic>를 입히고 <status>둔화</status>시킵니다.<br><br><rules>눈덩이를 보유하지 않은 경우 <spellName>눈덩이</spellName>를 얻습니다." +
    "</rules><br>",
    "dataValues": [
      {
        "name": "AbilityHaste",
        "values": [
          50
        ]
      },
      {
        "name": "BaseDamagePerSecond",
        "values": [
          100
        ]
      },
      {
        "name": "BaseDuration",
        "values": [
          2
        ]
      },
      {
        "name": "BaseSlowAmount",
        "values": [
          0.5
        ]
      },
      {
        "name": "APRatioPerSecond",
        "values": [
          0.6000000238418579
        ]
      },
      {
        "name": "TicksPerSecond",
        "values": [
          4
        ]
      },
      {
        "name": "CastDelay",
        "values": [
          0.25
        ]
      },
      {
        "name": "SlowPer100AP",
        "values": [
          0.0006000000284984708
        ]
      },
      {
        "name": "BonusADRatio",
        "values": [
          1
        ]
      }
    ],
    "calculations": {
      "TotalDamagePerSecond": {
        "mSimpleTooltipCalculationDisplay": 6,
        "mFormulaParts": [
          {
            "mDataValue": "BaseDamagePerSecond",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mDataValue": "APRatioPerSecond",
            "__type": "StatByNamedDataValueCalculationPart"
          },
          {
            "mStat": 2,
            "mStatFormula": 2,
            "mDataValue": "BonusADRatio",
            "__type": "StatByNamedDataValueCalculationPart"
          }
        ],
        "__type": "GameCalculation"
      },
      "TotalSlowAmount": {
        "mFormulaParts": [
          {
            "mDataValue": "BaseSlowAmount",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mDataValue": "SlowPer100AP",
            "__type": "StatByNamedDataValueCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      },
      "TotalDamage": {
        "mMultiplier": {
          "mDataValue": "BaseDuration",
          "__type": "NamedDataValueCalculationPart"
        },
        "mModifiedGameCalculation": "TotalDamagePerSecond",
        "__type": "GameCalculationModified"
      },
      "BaseDamage": {
        "mFormulaParts": [
          {
            "mStartValue": 90,
            "mEndValue": 180,
            "__type": "ByCharLevelInterpolationCalculationPart"
          }
        ],
        "__type": "GameCalculation"
      }
    },
    "expected": "눈덩이의 스킬 가속이 50만큼 증가합니다. \n대상에게 눈덩이가 적중하면 2초 동안 영역을 생성하여 내부의 적을 50% (+주문력 100당 6%)만큼 둔화시키고 매초 100 + 주문" +
    "력의 60% + 추가 공격력의 100%의 마법 피해를 입힙니다. (최대 200 + 주문력의 120% + 추가 공격력의 200%의 마법 피해)\n\n\n"
  },
  {
    "id": 2009,
    "tooltip": "<attention>치명타 확률을 @Calc_Crit_Chance@</attention>, <attackSpeed>공격 속도를 @Calc_AS@</attackSpeed> 얻습니다.",
    "description": "<attention>치명타 확률을 @Calc_Crit_Chance@</attention>, <attackSpeed>공격 속도를 @Calc_AS@</attackSpeed> 얻습니다.",
    "dataValues": [
      {
        "name": "ASAPRatio",
        "values": [
          0.0005000000237487257
        ]
      },
      {
        "name": "CritAPRatio",
        "values": [
          0.0005000000237487257
        ]
      },
      {
        "name": "MaxLevel",
        "values": [
          1
        ]
      },
      {
        "name": "BaseAttackSpd",
        "values": [
          0.3499999940395355
        ]
      },
      {
        "name": "BaseCritChance",
        "values": [
          0.25
        ]
      }
    ],
    "calculations": {
      "Calc_AS": {
        "mFormulaParts": [
          {
            "mDataValue": "BaseAttackSpd",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mDataValue": "ASAPRatio",
            "__type": "StatByNamedDataValueCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      },
      "Calc_Crit_Chance": {
        "mFormulaParts": [
          {
            "mDataValue": "BaseCritChance",
            "__type": "NamedDataValueCalculationPart"
          },
          {
            "mDataValue": "CritAPRatio",
            "__type": "StatByNamedDataValueCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      }
    },
    "expected": "치명타 확률을 25% (+주문력 100당 5%), 공격 속도를 35% (+주문력 100당 5%) 얻습니다."
  },
  {
    "id": 2132,
    "tooltip": "<lifeSteal>모든 피해 흡혈을 @Calc_Vamp@</lifeSteal> 얻습니다.",
    "description": "<lifeSteal>모든 피해 흡혈을 @Calc_Vamp@</lifeSteal> 얻습니다.",
    "dataValues": [
      {
        "name": "MaxLevel",
        "values": [
          1
        ]
      }
    ],
    "calculations": {
      "Calc_Vamp": {
        "mFormulaParts": [
          {
            "mNumber": 0.10000000149011612,
            "__type": "NumberCalculationPart"
          },
          {
            "mCoefficient": 0.0003499999875202775,
            "__type": "StatByCoefficientCalculationPart"
          }
        ],
        "mDisplayAsPercent": true,
        "__type": "GameCalculation"
      }
    },
    "expected": "모든 피해 흡혈을 10% (+주문력 100당 3.5%) 얻습니다."
  }
];

export default formulaCases;
