# Active-publishing pause browser regression
ActualPanel/page inisolatedViteharness, auth/API mocked. Fixture nowenforcesrealDB invariant publishingEnabled impliesenabled. RealSQLverification remainsseparate.

RED beforefinalfix (2026-09-09): setfixtureenabled=true,publishingEnabled=true, clickactual 일시중지. CapturedPOSTpatch {enabled:false}; response503, alert설정을저장하지못했습니다, persistedfixtureenabled=true/publishing=true. ConfirmsUI+constraint integration failure, no productionoperation.

Vitesession18262 on127.0.0.1:4176; dedicatedbrowserbgms-community-qa staysactiveforthesame-stateGREENcheck. Controllerownsfixture.

GREEN afterfinalUIpatch: sameactivefixturestateandactualpausebutton producedPOST {enabled:false,publishingEnabled:false}; bothpersistedfalse andalertnull. Subsequent 수집재개 producedenabledtrue/publishingfalse, soonlycollectionresumes. Thisusesfixtureinvariant, actualSQLregression executedseparatelybyfixer.
