-- Isolated fixture only. This file must never run against shared databases.
DO $test$
DECLARE
 u uuid := '00000000-0000-4000-8000-00000000f001';
 old_u uuid := '00000000-0000-4000-8000-00000000f002';
 r jsonb; w billing.user_wallets; n integer;
BEGIN
 INSERT INTO app_core.users(id) VALUES (u),(old_u),('00000000-0000-4000-8000-00000000f003');
 INSERT INTO billing.vip_memberships(user_id,valid_from,valid_until,last_plan_id)
 VALUES(u,now(),now()+interval '31 days','month');
 PERFORM admin.validate_vip_checkin_bonus_config('150');
 PERFORM admin.validate_vip_checkin_bonus_config('{"bonus_credits":120,"main_credits":30}');
 PERFORM vip_t3a_test.expect_raise($q$SELECT admin.validate_vip_checkin_bonus_config('{"bonus_credits":120,"main_credits":-1}')$q$,'negative main');
 PERFORM vip_t3a_test.expect_raise($q$SELECT admin.validate_vip_checkin_bonus_config('{"bonus_credits":120,"main_credits":30,"typo":1}')$q$,'unknown checkin key');
 UPDATE app_core.runtime_config SET value='{"bonus_credits":120,"main_credits":30}' WHERE key='vip_checkin_bonus_config';
 r:=miniapp_features.claim_daily_checkin(u);
 SELECT * INTO w FROM billing.user_wallets WHERE user_id=u;
 ASSERT w.main_credits=30 AND w.bonus_credits=120, 'checkin split';
 ASSERT (r#>>'{checkin,reward_credits}')::integer=150 AND (r#>>'{checkin,main_reward_credits}')::integer=30, 'checkin DTO';
 ASSERT (r#>>'{checkin,next_claim_at}')::timestamptz=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai','calendar preserved';
 PERFORM vip_t3a_test.expect_raise(format('SELECT miniapp_features.claim_daily_checkin(%L)',u),'repeat claim');
 ASSERT (SELECT count(*) FROM billing.wallet_ledger WHERE user_id=u)=1,'one combined checkin ledger';
 ASSERT (SELECT sum(main_delta+bonus_delta) FROM billing.wallet_ledger WHERE user_id=u)=150,'ledger total';
 ASSERT (SELECT total_paid_amount FROM billing.user_wallets WHERE user_id=u)=0,'gift is not revenue';
 INSERT INTO billing.payment_orders(id,user_id,payment_type,amount_cents,credits_amount,bonus_credits,expires_at,product_type,product_id,vip_duration_days,vip_bonus_credits,vip_bonus_main_credits)
 VALUES('vip-mixed-test',u,'alipay',3888,0,0,now()+interval '1 hour','vip','month',31,2000,1000);
 INSERT INTO billing.payment_orders(id,user_id,payment_type,amount_cents,credits_amount,bonus_credits,expires_at,product_type,product_id,vip_duration_days,vip_bonus_credits)
 VALUES('vip-legacy-test',old_u,'alipay',3888,0,0,now()+interval '1 hour','vip','month',31,3000);
 PERFORM billing.complete_payment_order('vip-mixed-test','mixed-provider','webhook');
 PERFORM billing.complete_payment_order('vip-mixed-test','mixed-provider','query');
 SELECT * INTO w FROM billing.user_wallets WHERE user_id=u;
 ASSERT w.main_credits=1030 AND w.bonus_credits=2120,'mixed purchase once';
 ASSERT w.total_paid_amount=38.88,'payment revenue once';
 ASSERT (SELECT bonus_main_credits FROM billing.vip_purchase_grants WHERE order_id='vip-mixed-test')=1000,'audit main snapshot';
 ASSERT (SELECT count(*) FROM billing.wallet_ledger WHERE reference_id='vip-mixed-test')=1,'purchase ledger once';
 PERFORM billing.complete_payment_order('vip-legacy-test','legacy-provider','cron');
 SELECT * INTO w FROM billing.user_wallets WHERE user_id=old_u;
 ASSERT w.main_credits=0 AND w.bonus_credits=3000,'legacy order preserved';
 PERFORM admin.validate_vip_plan_terms('{"price_cents":3888,"duration_days":31,"bonus_credits":2000,"bonus_main_credits":1000,"title":"月卡","description":null,"badge_text":null}','month');
 PERFORM vip_t3a_test.expect_raise($q$SELECT admin.validate_vip_plan_terms('{"price_cents":1599,"duration_days":7,"bonus_credits":0,"bonus_main_credits":1,"title":"周卡","description":null,"badge_text":null}','week')$q$,'week main rejected');
 ASSERT NOT has_function_privilege('anon','billing.grant_vip_reward(uuid,numeric,numeric,text,text,text,jsonb)','execute'),'anon cannot grant';
 ASSERT NOT has_function_privilege('authenticated','billing.grant_vip_reward(uuid,numeric,numeric,text,text,text,jsonb)','execute'),'authenticated cannot grant';
END;
$test$;
-- Force the second leg to fail and prove the first leg and checkin are rolled back together.
CREATE FUNCTION vip_t3a_test.fail_main_reward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.user_id='00000000-0000-4000-8000-00000000f003'::uuid AND NEW.main_delta>0 THEN RAISE EXCEPTION 'forced main failure'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER fail_mixed_main BEFORE INSERT OR UPDATE ON billing.wallet_ledger FOR EACH ROW EXECUTE FUNCTION vip_t3a_test.fail_main_reward();
INSERT INTO billing.vip_memberships(user_id,valid_from,valid_until,last_plan_id)
VALUES('00000000-0000-4000-8000-00000000f003',now(),now()+interval '31 days','month');
SELECT vip_t3a_test.expect_raise($$SELECT miniapp_features.claim_daily_checkin('00000000-0000-4000-8000-00000000f003')$$,'main failure');
DO $$BEGIN
 ASSERT NOT EXISTS(SELECT 1 FROM miniapp_features.daily_checkins WHERE user_id='00000000-0000-4000-8000-00000000f003'),'no half checkin';
 ASSERT NOT EXISTS(SELECT 1 FROM billing.wallet_ledger WHERE user_id='00000000-0000-4000-8000-00000000f003'),'no half ledger';
 ASSERT NOT EXISTS(SELECT 1 FROM billing.user_wallets WHERE user_id='00000000-0000-4000-8000-00000000f003'),'no half wallet';
END;$$;
DROP TRIGGER fail_mixed_main ON billing.wallet_ledger;
