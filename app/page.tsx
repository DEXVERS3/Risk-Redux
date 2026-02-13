"use client";

import React, { useEffect, useMemo, useState } from "react";

/**
 * RISK-REDUX v1 — deterministic engine per rr_v1_spec.md
 * - No prediction
 * - Enforces user-defined risk caps derived from bankroll
 * - Stable evaluation order & reason ordering
 */

type ProposedBet = {
  stake: number;
  odds: number;      // American odds integer; invalid triggers HIGH_RISK_ODDS_GATE
  group1_id: string; // generic: event_id / asset_id / policy_id / property_id / deal_id
  group2_id: string; // generic: team_id / sector_id / risk_class / market_id / industry_id
};

type Exposures = {
  daily_staked: number;
  weekly_staked: number;       // ISO week Mon 00:00 local
  same_group1_staked: number;  // group1 concentration
  same_group2_7d_staked: number; // rolling 7d concentration
  bets_today: number;
};

type BehavioralState = {
  warnings_last_24h: number;
  warnings_last_7d: number;
  overrides_last_7d: number;
  consecutive_overrides: number;
  cooldown_violations: number;
  stake_velocity_spike: boolean;
  frequency_spike: boolean;
  cooldown_active: boolean; // normalized input
};

type Verdict = "ALLOW" | "WARN" | "HARD_WARN" | "RED_ALERT";

type DecisionResult = {
  verdict: Verdict;
  reasons: string[];
  friction_required: boolean;
  cooldown_triggered: boolean;
};

const REASONS = {
  UNIT_SIZE: "UNIT_SIZE_CAP_EXCEEDED",
  DAILY: "DAILY_EXPOSURE_CAP_EXCEEDED",
  WEEKLY: "WEEKLY_EXPOSURE_CAP_EXCEEDED",
  GROUP1: "SAME_EVENT_CONCENTRATION_CAP_EXCEEDED",
  GROUP2: "SAME_TEAM_7D_CONCENTRATION_CAP_EXCEEDED",
  FREQ: "ACTION_FREQUENCY_CAP_EXCEEDED",
  ODDS: "HIGH_RISK_ODDS_GATE",
  STAKE_SPIKE: "STAKE_VELOCITY_SPIKE",
  FREQ_SPIKE: "FREQUENCY_SPIKE",
  CONS_OVR: "CONSECUTIVE_OVERRIDES_HIGH",
  CD_HIST: "COOLDOWN_VIOLATION_HISTORY",
  CD_ACTIVE: "COOLDOWN_ACTIVE"
} as const;

function isValidAmericanOdds(n: number): boolean {
  // Accept non-zero integers like -110, +150, +300
  return Number.isFinite(n) && Number.isInteger(n) && n !== 0;
}

function tierRank(v: Verdict): number {
  return v === "ALLOW" ? 0 : v === "WARN" ? 1 : v === "HARD_WARN" ? 2 : 3;
}
function maxTier(a: Verdict, b: Verdict): Verdict {
  return tierRank(a) >= tierRank(b) ? a : b;
}
function escalateOneTier(v: Verdict): Verdict {
  return v === "ALLOW" ? "WARN" : v === "WARN" ? "HARD_WARN" : "RED_ALERT";
}

/**
 * Core engine per spec:
 * - Evaluation order is stable
 * - Cap breaches use strict >
 * - Odds gate triggers on odds >= +250 OR invalid odds
 * - Cooldown hard stop: RED_ALERT + COOLDOWN_ACTIVE, skip others
 * - Base mapping + amplifications
 * - Reasons ordered: violations, gates, behavior flags
 */
function evaluate_v1(
  bankroll: number,
  bet: ProposedBet,
  exposures: Exposures,
  behavioral: BehavioralState
): DecisionResult {
  // 1) Cooldown hard stop
  if (behavioral.cooldown_active === true) {
    return {
      verdict: "RED_ALERT",
      reasons: [REASONS.CD_ACTIVE],
      friction_required: true,
      cooldown_triggered: true
    };
  }

  const B = bankroll;
  const S = bet.stake;

  // 3.1 Cap thresholds (bankroll-derived)
  const unit_cap = B * 0.02;
  const daily_cap = B * 0.06;
  const weekly_cap = B * 0.20;
  const group1_cap = B * 0.04;
  const group2_cap = B * 0.08;

  // 3.2 Post-bet projections
  const post_daily = exposures.daily_staked + S;
  const post_weekly = exposures.weekly_staked + S;
  const post_group1 = exposures.same_group1_staked + S;
  const post_group2 = exposures.same_group2_7d_staked + S;
  const post_bets = exposures.bets_today + 1;

  // Collect reasons in required ordering buckets
  const violations: string[] = [];
  const gates: string[] = [];
  const flags: string[] = [];

  // 2) Unit cap
  if (S > unit_cap) violations.push(REASONS.UNIT_SIZE);

  // 3) Daily cap
  if (post_daily > daily_cap) violations.push(REASONS.DAILY);

  // 4) Weekly cap
  if (post_weekly > weekly_cap) violations.push(REASONS.WEEKLY);

  // 5) Same-event / group1 cap
  if (post_group1 > group1_cap) violations.push(REASONS.GROUP1);

  // 6) Same-team 7d / group2 cap
  if (post_group2 > group2_cap) violations.push(REASONS.GROUP2);

  // 7) Frequency cap (5/day) strict >
  if (post_bets > 5) violations.push(REASONS.FREQ);

  // 8) Odds gate: >= +250 OR invalid odds triggers
  const oddsInvalid = !isValidAmericanOdds(bet.odds);
  if (oddsInvalid || bet.odds >= 250) gates.push(REASONS.ODDS);

  // 9) Behavioral flags collection (canonical order)
  if (behavioral.stake_velocity_spike) flags.push(REASONS.STAKE_SPIKE);
  if (behavioral.frequency_spike) flags.push(REASONS.FREQ_SPIKE);
  if (behavioral.consecutive_overrides >= 2) flags.push(REASONS.CONS_OVR);
  if (behavioral.cooldown_violations >= 1) flags.push(REASONS.CD_HIST);

  // 10) Base verdict mapping
  let verdict: Verdict = "ALLOW";
  const violationCount = violations.length;
  const gateCount = gates.length;

  if (violationCount === 0 && gateCount === 0) verdict = "ALLOW";
  else if (violationCount === 0 && gateCount > 0) verdict = "WARN";
  else if (violationCount === 1) verdict = "WARN";
  else if (violationCount >= 2) verdict = "HARD_WARN";

  // 11) Amplifications (in order)
  // 1. If WEEKLY_EXPOSURE_CAP_EXCEEDED -> RED_ALERT
  if (violations.includes(REASONS.WEEKLY)) verdict = "RED_ALERT";

  // 2. If consecutive_overrides >= 3 -> RED_ALERT
  if (behavioral.consecutive_overrides >= 3) verdict = "RED_ALERT";

  // 3. If cooldown_violations >=1 AND any violation exists -> RED_ALERT
  if (behavioral.cooldown_violations >= 1 && violationCount >= 1) verdict = "RED_ALERT";

  // 4. If any violation AND (stake_velocity_spike OR frequency_spike) -> escalate one tier
  if (violationCount >= 1 && (behavioral.stake_velocity_spike || behavioral.frequency_spike)) {
    verdict = escalateOneTier(verdict);
  }

  // 5. If HIGH_RISK_ODDS_GATE AND (stake_velocity_spike OR frequency_spike) -> at least HARD_WARN
  if (gates.includes(REASONS.ODDS) && (behavioral.stake_velocity_spike || behavioral.frequency_spike)) {
    verdict = maxTier(verdict, "HARD_WARN");
  }

  const reasons = [...violations, ...gates, ...flags];
  const friction_required = verdict !== "ALLOW";
  const cooldown_triggered = verdict === "RED_ALERT";

  return { verdict, reasons, friction_required, cooldown_triggered };
}

/** ---------- Ledger + Exposure aggregation ---------- */

type LedgerEntry = {
  id: string;
  ts: number; // ms
  category: string;
  stake: number;
  odds: number;
  group1_id: string;
  group2_id: string;
  verdict: Verdict;
  reasons: string[];
};

const LS_KEY = "rr_v1_ledger";

function loadLedger(): LedgerEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLedger(entries: LedgerEntry[]) {
  window.localStorage.setItem(LS_KEY, JSON.stringify(entries));
}

// Local helpers for date windows (local time)
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function startOfISOWeekLocal(d: Date): Date {
  // ISO week starts Monday. Compute local Monday 00:00.
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = (day === 0 ? -6 : 1) - day; // move to Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const sod = startOfLocalDay(monday);
  return sod;
}
function msDays(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

function computeExposuresNow(ledger: LedgerEntry[], group1_id: string, group2_id: string): Exposures {
  const now = new Date();
  const dayStart = startOfLocalDay(now).getTime();
  const weekStart = startOfISOWeekLocal(now).getTime();
  const sevenDaysAgo = now.getTime() - msDays(7);

  let daily = 0;
  let weekly = 0;
  let sameG1 = 0;
  let sameG2_7d = 0;
  let betsToday = 0;

  for (const e of ledger) {
    if (e.ts >= dayStart) {
      daily += e.stake;
      betsToday += 1;
      if (e.group1_id === group1_id) sameG1 += e.stake;
    }
    if (e.ts >= weekStart) weekly += e.stake;
    if (e.ts >= sevenDaysAgo && e.group2_id === group2_id) sameG2_7d += e.stake;
  }

  return {
    daily_staked: daily,
    weekly_staked: weekly,
    same_group1_staked: sameG1,
    same_group2_7d_staked: sameG2_7d,
    bets_today: betsToday
  };
}

/** ---------- UI ---------- */

const CATEGORIES = [
  { key: "betting", label: "Sports Betting", g1: "Event", g2: "Team" },
  { key: "investing", label: "Investing", g1: "Asset", g2: "Sector" },
  { key: "insurance", label: "Insurance", g1: "Policy", g2: "Risk Class" },
  { key: "real_estate", label: "Real Estate", g1: "Property", g2: "Market" },
  { key: "sponsorship", label: "Sponsorship", g1: "Deal", g2: "Industry" }
];

export default function Page() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [category, setCategory] = useState(CATEGORIES[0].key);

  const cat = useMemo(() => CATEGORIES.find(c => c.key === category)!, [category]);

  const [bankroll, setBankroll] = useState<number>(1000);

  // Inputs
  const [stake, setStake] = useState<number>(25);
  const [odds, setOdds] = useState<number>(-110);
  const [group1, setGroup1] = useState<string>("EVENT-1");
  const [group2, setGroup2] = useState<string>("TEAM-1");

  // Behavioral (v1 input; default quiet)
  const [stakeSpike, setStakeSpike] = useState(false);
  const [freqSpike, setFreqSpike] = useState(false);
  const [consecutiveOverrides, setConsecutiveOverrides] = useState<number>(0);
  const [cooldownViolations, setCooldownViolations] = useState<number>(0);
  const [cooldownActive, setCooldownActive] = useState(false);

  useEffect(() => {
    setLedger(loadLedger());
  }, []);

  const exposures = useMemo(() => computeExposuresNow(ledger, group1, group2), [ledger, group1, group2]);

  const behavioral: BehavioralState = useMemo(() => ({
    warnings_last_24h: 0,
    warnings_last_7d: 0,
    overrides_last_7d: 0,
    consecutive_overrides: consecutiveOverrides,
    cooldown_violations: cooldownViolations,
    stake_velocity_spike: stakeSpike,
    frequency_spike: freqSpike,
    cooldown_active: cooldownActive
  }), [stakeSpike, freqSpike, consecutiveOverrides, cooldownViolations, cooldownActive]);

  const decision = useMemo(() => {
    const bet: ProposedBet = {
      stake: Number(stake) || 0,
      odds: Number(odds),
      group1_id: String(group1 || "").trim(),
      group2_id: String(group2 || "").trim()
    };
    const B = Number(bankroll) || 0;
    return evaluate_v1(B, bet, exposures as any, behavioral);
  }, [bankroll, stake, odds, group1, group2, exposures, behavioral]);

  function addToLedger() {
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      category,
      stake: Number(stake) || 0,
      odds: Number(odds),
      group1_id: String(group1 || "").trim(),
      group2_id: String(group2 || "").trim(),
      verdict: decision.verdict,
      reasons: decision.reasons
    };
    const next = [entry, ...ledger].slice(0, 500);
    setLedger(next);
    saveLedger(next);
  }

  function resetLedger() {
    setLedger([]);
    saveLedger([]);
  }

  const compliantLabel = decision.verdict === "ALLOW" ? "COMPLIANT" : "CHECK REQUIRED";

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>RISK-REDUX v1</h1>
      <p style={{ marginTop: 6, color: "#444" }}>
        Deterministic capital governance. No outcome prediction. Evaluates your proposed position against your rules.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Inputs</h2>

          <label style={{ display: "block", marginBottom: 10 }}>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}>
              {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>

          <label style={{ display: "block", marginBottom: 10 }}>
            Capital (Bankroll)
            <input type="number" value={bankroll} onChange={(e) => setBankroll(Number(e.target.value))}
              style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "block" }}>
              Stake
              <input type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
            </label>

            <label style={{ display: "block" }}>
              Odds (American)
              <input type="number" value={odds} onChange={(e) => setOdds(Number(e.target.value))}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <label style={{ display: "block" }}>
              {cat.g1} ID (group1)
              <input value={group1} onChange={(e) => setGroup1(e.target.value)}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
            </label>

            <label style={{ display: "block" }}>
              {cat.g2} ID (group2)
              <input value={group2} onChange={(e) => setGroup2(e.target.value)}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
            </label>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>Behavior flags (v1 inputs)</summary>
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <label><input type="checkbox" checked={stakeSpike} onChange={(e) => setStakeSpike(e.target.checked)} /> stake_velocity_spike</label>
              <label><input type="checkbox" checked={freqSpike} onChange={(e) => setFreqSpike(e.target.checked)} /> frequency_spike</label>
              <label>consecutive_overrides
                <input type="number" value={consecutiveOverrides} onChange={(e) => setConsecutiveOverrides(Number(e.target.value))}
                  style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
              </label>
              <label>cooldown_violations
                <input type="number" value={cooldownViolations} onChange={(e) => setCooldownViolations(Number(e.target.value))}
                  style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
              </label>
              <label><input type="checkbox" checked={cooldownActive} onChange={(e) => setCooldownActive(e.target.checked)} /> cooldown_active (hard stop)</label>
            </div>
          </details>

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button onClick={addToLedger} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #111", background: "#111", color: "#fff", cursor: "pointer" }}>
              Save to Ledger
            </button>
            <button onClick={resetLedger} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
              Reset Ledger
            </button>
          </div>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Decision</h2>

          <div style={{ padding: 14, borderRadius: 12, border: "1px solid #eee", background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#555" }}>{compliantLabel}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{decision.verdict}</div>
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "#555" }}>Reasons (ordered)</div>
              {decision.reasons.length === 0 ? (
                <div style={{ marginTop: 6, color: "#333" }}>None</div>
              ) : (
                <ul style={{ marginTop: 6 }}>
                  {decision.reasons.map((r, i) => <li key={`${r}-${i}`}>{r}</li>)}
                </ul>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: "#555" }}>friction_required</div>
                <div style={{ fontWeight: 700 }}>{String(decision.friction_required)}</div>
              </div>
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: "#555" }}>cooldown_triggered</div>
                <div style={{ fontWeight: 700 }}>{String(decision.cooldown_triggered)}</div>
              </div>
            </div>
          </div>

          <h3 style={{ marginTop: 18, fontSize: 14 }}>Current Exposures (auto from ledger)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Metric label="daily_staked" value={exposures.daily_staked} />
            <Metric label="weekly_staked (ISO week)" value={exposures.weekly_staked} />
            <Metric label={`same_${cat.g1.toLowerCase()}_staked`} value={exposures.same_group1_staked} />
            <Metric label={`same_${cat.g2.toLowerCase()}_7d_staked`} value={exposures.same_group2_7d_staked} />
            <Metric label="bets_today" value={exposures.bets_today} />
            <Metric label="ledger_entries" value={ledger.length} />
          </div>

          <h3 style={{ marginTop: 18, fontSize: 14 }}>Ledger (most recent)</h3>
          <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid #eee", borderRadius: 10 }}>
            {ledger.length === 0 ? (
              <div style={{ padding: 12, color: "#555" }}>No entries yet.</div>
            ) : (
              ledger.slice(0, 25).map(e => (
                <div key={e.id} style={{ padding: 12, borderBottom: "1px solid #f0f0f0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 700 }}>{e.verdict}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>{new Date(e.ts).toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
                    {CATEGORIES.find(c => c.key === e.category)?.label} • stake {e.stake} • odds {e.odds} • {cat.g1}:{e.group1_id} • {cat.g2}:{e.group2_id}
                  </div>
                  {e.reasons.length > 0 && (
                    <div style={{ fontSize: 12, color: "#333", marginTop: 6 }}>
                      Reasons: {e.reasons.join(", ")}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <p style={{ marginTop: 18, fontSize: 12, color: "#666" }}>
        Note: This tool enforces user-defined risk parameters. It does not predict outcomes or guarantee results.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 12, color: "#555" }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{typeof value === "number" ? value.toFixed(2) : String(value)}</div>
    </div>
  );
}
