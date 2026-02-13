"use client";

import React, { useEffect, useMemo, useState } from "react";

type UserRules = {
  unit_pct: number;
  daily_pct: number;
  weekly_pct: number;
  group1_pct: number;
  group2_pct: number;
  freq_cap: number;
  odds_gate: number;
};

type ProposedBet = {
  stake: number;
  odds: number;
  group1_id: string;
  group2_id: string;
};

type Exposures = {
  daily_staked: number;
  weekly_staked: number;
  same_group1_staked: number;
  same_group2_7d_staked: number;
  bets_today: number;
};

type BehavioralState = {
  stake_velocity_spike: boolean;
  frequency_spike: boolean;
  consecutive_overrides: number;
  cooldown_violations: number;
  cooldown_active: boolean;
};

type Verdict = "ALLOW" | "WARN" | "HARD_WARN" | "RED_ALERT";

type DecisionResult = {
  verdict: Verdict;
  reasons: string[];
};

const DEFAULT_RULES: UserRules = {
  unit_pct: 2,
  daily_pct: 6,
  weekly_pct: 20,
  group1_pct: 4,
  group2_pct: 8,
  freq_cap: 5,
  odds_gate: 250
};

function evaluate_v1(
  bankroll: number,
  rules: UserRules,
  bet: ProposedBet,
  exposures: Exposures,
  behavioral: BehavioralState
): DecisionResult {

  if (behavioral.cooldown_active) {
    return { verdict: "RED_ALERT", reasons: ["COOLDOWN_ACTIVE"] };
  }

  const B = bankroll;
  const S = bet.stake;

  const unit_cap = B * (rules.unit_pct / 100);
  const daily_cap = B * (rules.daily_pct / 100);
  const weekly_cap = B * (rules.weekly_pct / 100);
  const group1_cap = B * (rules.group1_pct / 100);
  const group2_cap = B * (rules.group2_pct / 100);

  const post_daily = exposures.daily_staked + S;
  const post_weekly = exposures.weekly_staked + S;
  const post_group1 = exposures.same_group1_staked + S;
  const post_group2 = exposures.same_group2_7d_staked + S;
  const post_bets = exposures.bets_today + 1;

  const violations: string[] = [];
  const gates: string[] = [];

  if (S > unit_cap) violations.push("UNIT_SIZE_CAP_EXCEEDED");
  if (post_daily > daily_cap) violations.push("DAILY_EXPOSURE_CAP_EXCEEDED");
  if (post_weekly > weekly_cap) violations.push("WEEKLY_EXPOSURE_CAP_EXCEEDED");
  if (post_group1 > group1_cap) violations.push("GROUP1_CAP_EXCEEDED");
  if (post_group2 > group2_cap) violations.push("GROUP2_7D_CAP_EXCEEDED");
  if (post_bets > rules.freq_cap) violations.push("ACTION_FREQUENCY_CAP_EXCEEDED");

  if (!Number.isInteger(bet.odds) || bet.odds >= rules.odds_gate) {
    gates.push("HIGH_RISK_ODDS_GATE");
  }

  let verdict: Verdict = "ALLOW";

  if (violations.length === 0 && gates.length === 0) verdict = "ALLOW";
  else if (violations.length === 1) verdict = "WARN";
  else if (violations.length >= 2) verdict = "HARD_WARN";

  if (violations.includes("WEEKLY_EXPOSURE_CAP_EXCEEDED"))
    verdict = "RED_ALERT";

  return {
    verdict,
    reasons: [...violations, ...gates]
  };
}

export default function Page() {
  const [bankroll, setBankroll] = useState(1000);
  const [stake, setStake] = useState(25);
  const [odds, setOdds] = useState(-110);
  const [group1, setGroup1] = useState("GROUP1");
  const [group2, setGroup2] = useState("GROUP2");
  const [ledger, setLedger] = useState<any[]>([]);
  const [rules, setRules] = useState<UserRules>(DEFAULT_RULES);

  useEffect(() => {
    const stored = localStorage.getItem("rr_rules");
    if (stored) setRules(JSON.parse(stored));
  }, []);

  useEffect(() => {
    localStorage.setItem("rr_rules", JSON.stringify(rules));
  }, [rules]);

  const exposures = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
    weekStart.setHours(0,0,0,0);

    let daily = 0, weekly = 0, g1 = 0, g2 = 0, betsToday = 0;

    ledger.forEach(e => {
      if (e.ts >= todayStart) {
        daily += e.stake;
        betsToday++;
        if (e.group1 === group1) g1 += e.stake;
      }
      if (e.ts >= weekStart.getTime()) weekly += e.stake;
      if (e.group2 === group2 && now - e.ts <= 7*24*60*60*1000)
        g2 += e.stake;
    });

    return {
      daily_staked: daily,
      weekly_staked: weekly,
      same_group1_staked: g1,
      same_group2_7d_staked: g2,
      bets_today: betsToday
    };
  }, [ledger, group1, group2]);

  const decision = evaluate_v1(
    bankroll,
    rules,
    { stake, odds, group1_id: group1, group2_id: group2 },
    exposures,
    {
      stake_velocity_spike: false,
      frequency_spike: false,
      consecutive_overrides: 0,
      cooldown_violations: 0,
      cooldown_active: false
    }
  );

  function addToLedger() {
    const entry = {
      ts: Date.now(),
      stake,
      odds,
      group1,
      group2,
      verdict: decision.verdict
    };
    setLedger([entry, ...ledger]);
  }

  return (
    <div style={{ padding: 30, maxWidth: 800, margin: "auto" }}>
      <h1>RISK-REDUX</h1>

      <h3>Capital</h3>
      <input type="number" value={bankroll} onChange={e=>setBankroll(Number(e.target.value))}/>

      <h3>Position</h3>
      <input type="number" value={stake} onChange={e=>setStake(Number(e.target.value))}/>
      <input type="number" value={odds} onChange={e=>setOdds(Number(e.target.value))}/>
      <input value={group1} onChange={e=>setGroup1(e.target.value)}/>
      <input value={group2} onChange={e=>setGroup2(e.target.value)}/>

      <button onClick={addToLedger}>Save Position</button>

      <h2>{decision.verdict}</h2>
      <pre>{decision.reasons.join("\n")}</pre>

      <details>
        <summary>Rule Settings</summary>
        {Object.entries(rules).map(([key,value])=>(
          <div key={key}>
            {key}
            <input type="number"
              value={value}
              onChange={e=>setRules({...rules, [key]:Number(e.target.value)})}
            />
          </div>
        ))}
      </details>
    </div>
  );
}
