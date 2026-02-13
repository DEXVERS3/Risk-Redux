"use client";
import React, { useEffect, useMemo, useState } from "react";

/** ---------- Types ---------- */
type UserRules = {
  unit_pct: number;      // default 2
  daily_pct: number;     // default 6
  weekly_pct: number;    // default 20
  group1_pct: number;    // default 4
  group2_pct: number;    // default 8 (rolling 7d)
  freq_cap: number;      // default 5 bets/day
  odds_gate: number;     // default +250
};

type ProposedBet = {
  stake: number;
  odds: number;      // American odds integer: -110, +150, +300
  group1_id: string; // event/asset/policy/property/deal
  group2_id: string; // team/sector/risk class/market/industry
};

type Exposures = {
  daily_staked: number;
  weekly_staked: number;          // ISO week Mon 00:00 local
  same_group1_staked: number;     // group1 concentration
  same_group2_7d_staked: number;  // rolling 7d
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
  friction_required: boolean;
  cooldown_triggered: boolean;
};

/** ---------- Canonical reason codes (v1) ---------- */
const R = {
  UNIT: "UNIT_SIZE_CAP_EXCEEDED",
  DAILY: "DAILY_EXPOSURE_CAP_EXCEEDED",
  WEEKLY: "WEEKLY_EXPOSURE_CAP_EXCEEDED",
  EVENT: "SAME_EVENT_CONCENTRATION_CAP_EXCEEDED",
  TEAM: "SAME_TEAM_7D_CONCENTRATION_CAP_EXCEEDED",
  FREQ: "ACTION_FREQUENCY_CAP_EXCEEDED",
  ODDS: "HIGH_RISK_ODDS_GATE",
  STAKE_SPIKE: "STAKE_VELOCITY_SPIKE",
  FREQ_SPIKE: "FREQUENCY_SPIKE",
  CONS_OVR: "CONSECUTIVE_OVERRIDES_HIGH",
  CD_HIST: "COOLDOWN_VIOLATION_HISTORY",
  CD_ACTIVE: "COOLDOWN_ACTIVE"
} as const;

const DEFAULT_RULES: UserRules = {
  unit_pct: 2,
  daily_pct: 6,
  weekly_pct: 20,
  group1_pct: 4,
  group2_pct: 8,
  freq_cap: 5,
  odds_gate: 250
};

function isValidAmericanOdds(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n) && n !== 0;
}
function rank(v: Verdict): number {
  return v === "ALLOW" ? 0 : v === "WARN" ? 1 : v === "HARD_WARN" ? 2 : 3;
}
function maxTier(a: Verdict, b: Verdict): Verdict {
  return rank(a) >= rank(b) ? a : b;
}
function escalateOneTier(v: Verdict): Verdict {
  return v === "ALLOW" ? "WARN" : v === "WARN" ? "HARD_WARN" : "RED_ALERT";
}

/** ---------- Engine (v1, deterministic) ---------- */
function evaluate_v1(
  bankroll: number,
  rules: UserRules,
  bet: ProposedBet,
  exp: Exposures,
  beh: BehavioralState
): DecisionResult {
  // 1) Cooldown hard stop
  if (beh.cooldown_active) {
    return {
      verdict: "RED_ALERT",
      reasons: [R.CD_ACTIVE],
      friction_required: true,
      cooldown_triggered: true
    };
  }

  const B = bankroll;
  const S = bet.stake;

  // Cap thresholds
  const unit_cap = B * (rules.unit_pct / 100);
  const daily_cap = B * (rules.daily_pct / 100);
  const weekly_cap = B * (rules.weekly_pct / 100);
  const event_cap = B * (rules.group1_pct / 100);
  const team_cap = B * (rules.group2_pct / 100);

  // Post-bet projections
  const post_daily = exp.daily_staked + S;
  const post_weekly = exp.weekly_staked + S;
  const post_event = exp.same_group1_staked + S;
  const post_team7d = exp.same_group2_7d_staked + S;
  const post_bets = exp.bets_today + 1;

  const violations: string[] = [];
  const gates: string[] = [];
  const flags: string[] = [];

  // Evaluation order (stable) — cap comparisons strict >
  if (S > unit_cap) violations.push(R.UNIT);
  if (post_daily > daily_cap) violations.push(R.DAILY);
  if (post_weekly > weekly_cap) violations.push(R.WEEKLY);
  if (post_event > event_cap) violations.push(R.EVENT);
  if (post_team7d > team_cap) violations.push(R.TEAM);
  if (post_bets > rules.freq_cap) violations.push(R.FREQ);

  // Odds gate: >= threshold OR invalid odds triggers
  const oddsInvalid = !isValidAmericanOdds(bet.odds);
  if (oddsInvalid || bet.odds >= rules.odds_gate) gates.push(R.ODDS);

  // Behavior flags (canonical order)
  if (beh.stake_velocity_spike) flags.push(R.STAKE_SPIKE);
  if (beh.frequency_spike) flags.push(R.FREQ_SPIKE);
  if (beh.consecutive_overrides >= 2) flags.push(R.CONS_OVR);
  if (beh.cooldown_violations >= 1) flags.push(R.CD_HIST);

  // Base verdict mapping
  let verdict: Verdict = "ALLOW";
  const vCount = violations.length;
  const gCount = gates.length;

  if (vCount === 0 && gCount === 0) verdict = "ALLOW";
  else if (vCount === 0 && gCount > 0) verdict = "WARN";
  else if (vCount === 1) verdict = "WARN";
  else if (vCount >= 2) verdict = "HARD_WARN";

  // Amplifications (v1)
  if (violations.includes(R.WEEKLY)) verdict = "RED_ALERT";
  if (beh.consecutive_overrides >= 3) verdict = "RED_ALERT";
  if (beh.cooldown_violations >= 1 && vCount >= 1) verdict = "RED_ALERT";
  if (vCount >= 1 && (beh.stake_velocity_spike || beh.frequency_spike)) verdict = escalateOneTier(verdict);
  if (gates.includes(R.ODDS) && (beh.stake_velocity_spike || beh.frequency_spike)) verdict = maxTier(verdict, "HARD_WARN");

  const reasons = [...violations, ...gates, ...flags];
  const friction_required = verdict !== "ALLOW";
  const cooldown_triggered = verdict === "RED_ALERT";

  return { verdict, reasons, friction_required, cooldown_triggered };
}

/** ---------- Ledger / exposures ---------- */
type LedgerEntry = {
  id: string;
  ts: number;
  stake: number;
  odds: number;
  group1_id: string;
  group2_id: string;
  verdict: Verdict;
  reasons: string[];
};

const LEDGER_KEY = "rr_v1_ledger";
const RULES_KEY = "rr_v1_rules";

function loadLedger(): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveLedger(entries: LedgerEntry[]) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
}
function loadRules(): UserRules {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_RULES, ...parsed };
  } catch {
    return DEFAULT_RULES;
  }
}
function saveRules(rules: UserRules) {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}
function startOfISOWeekLocal(d: Date): number {
  const day = d.getDay(); // 0..6
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  return startOfLocalDay(monday);
}
const MS_7D = 7 * 24 * 60 * 60 * 1000;

function computeExposures(ledger: LedgerEntry[], group1_id: string, group2_id: string): Exposures {
  const now = new Date();
  const dayStart = startOfLocalDay(now);
  const weekStart = startOfISOWeekLocal(now);
  const t7 = now.getTime() - MS_7D;

  let daily = 0, weekly = 0, sameG1 = 0, sameG2 = 0, betsToday = 0;

  for (const e of ledger) {
    if (e.ts >= dayStart) {
      daily += e.stake;
      betsToday += 1;
      if (e.group1_id === group1_id) sameG1 += e.stake;
    }
    if (e.ts >= weekStart) weekly += e.stake;
    if (e.ts >= t7 && e.group2_id === group2_id) sameG2 += e.stake;
  }

  return {
    daily_staked: daily,
    weekly_staked: weekly,
    same_group1_staked: sameG1,
    same_group2_7d_staked: sameG2,
    bets_today: betsToday
  };
}

/** ---------- UI ---------- */
export default function Page() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [rules, setRules] = useState<UserRules>(DEFAULT_RULES);

  const [bankroll, setBankroll] = useState<number>(1000);
  const [stake, setStake] = useState<number>(25);
  const [odds, setOdds] = useState<number>(-110);
  const [group1, setGroup1] = useState<string>("EVENT-1");
  const [group2, setGroup2] = useState<string>("TEAM-1");

  // Behavior inputs (optional)
  const [stakeSpike, setStakeSpike] = useState(false);
  const [freqSpike, setFreqSpike] = useState(false);
  const [consOverrides, setConsOverrides] = useState(0);
  const [cdViolations, setCdViolations] = useState(0);
  const [cdActive, setCdActive] = useState(false);

  useEffect(() => {
    setLedger(loadLedger());
    setRules(loadRules());
  }, []);

  useEffect(() => {
    saveRules(rules);
  }, [rules]);

  const exposures = useMemo(() => computeExposures(ledger, group1, group2), [ledger, group1, group2]);

  const caps = useMemo(() => {
    const B = Number(bankroll) || 0;
    return {
      unit_cap: B * (rules.unit_pct / 100),
      daily_cap: B * (rules.daily_pct / 100),
      weekly_cap: B * (rules.weekly_pct / 100),
      event_cap: B * (rules.group1_pct / 100),
      team_cap: B * (rules.group2_pct / 100)
    };
  }, [bankroll, rules]);

  const projected = useMemo(() => {
    const S = Number(stake) || 0;
    return {
      daily: exposures.daily_staked + S,
      weekly: exposures.weekly_staked + S,
      event: exposures.same_group1_staked + S,
      team7d: exposures.same_group2_7d_staked + S,
      bets: exposures.bets_today + 1
    };
  }, [exposures, stake]);

  const decision = useMemo(() => {
    const bet: ProposedBet = {
      stake: Number(stake) || 0,
      odds: Number(odds),
      group1_id: String(group1 || "").trim(),
      group2_id: String(group2 || "").trim()
    };

    const beh: BehavioralState = {
      stake_velocity_spike: stakeSpike,
      frequency_spike: freqSpike,
      consecutive_overrides: consOverrides,
      cooldown_violations: cdViolations,
      cooldown_active: cdActive
    };

    return evaluate_v1(Number(bankroll) || 0, rules, bet, exposures, beh);
  }, [bankroll, rules, stake, odds, group1, group2, exposures, stakeSpike, freqSpike, consOverrides, cdViolations, cdActive]);

  function addToLedger() {
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      stake: Number(stake) || 0,
      odds: Number(odds),
      group1_id: group1.trim(),
      group2_id: group2.trim(),
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

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h1 style={{ margin: 0 }}>RISK-REDUX</h1>
      <div style={{ marginTop: 8, color: "#555" }}>
        Deterministic framework enforcement. No outcome prediction.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Capital & Position</h2>

          <label style={{ display: "block", marginBottom: 10 }}>
            Capital (Bankroll)
            <input
              type="number"
              value={bankroll}
              onChange={(e) => setBankroll(Number(e.target.value))}
              style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
            />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "block" }}>
              Stake
              <input
                type="number"
                value={stake}
                onChange={(e) => setStake(Number(e.target.value))}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
              />
            </label>

            <label style={{ display: "block" }}>
              Odds (American)
              <input
                type="number"
                value={odds}
                onChange={(e) => setOdds(Number(e.target.value))}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
              />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <label style={{ display: "block" }}>
              Group1 ID (Event/Asset/Policy/etc.)
              <input
                value={group1}
                onChange={(e) => setGroup1(e.target.value)}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
              />
            </label>

            <label style={{ display: "block" }}>
              Group2 ID (Team/Sector/Market/etc.)
              <input
                value={group2}
                onChange={(e) => setGroup2(e.target.value)}
                style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button onClick={addToLedger} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #111", background: "#111", color: "#fff", cursor: "pointer" }}>
              Save Position
            </button>
            <button onClick={resetLedger} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
              Reset Ledger
            </button>
          </div>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Rule Settings (user-owned)</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              <RuleRow label="Unit cap %" value={rules.unit_pct} onChange={(v) => setRules({ ...rules, unit_pct: v })} />
              <RuleRow label="Daily cap %" value={rules.daily_pct} onChange={(v) => setRules({ ...rules, daily_pct: v })} />
              <RuleRow label="Weekly cap %" value={rules.weekly_pct} onChange={(v) => setRules({ ...rules, weekly_pct: v })} />
              <RuleRow label="Group1 cap %" value={rules.group1_pct} onChange={(v) => setRules({ ...rules, group1_pct: v })} />
              <RuleRow label="Group2 cap % (rolling 7d)" value={rules.group2_pct} onChange={(v) => setRules({ ...rules, group2_pct: v })} />
              <RuleRow label="Bets/day cap" value={rules.freq_cap} onChange={(v) => setRules({ ...rules, freq_cap: v })} />
              <RuleRow label="Odds gate threshold (+)" value={rules.odds_gate} onChange={(v) => setRules({ ...rules, odds_gate: v })} />
            </div>
          </details>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Behavior inputs (optional)</summary>
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              <label><input type="checkbox" checked={stakeSpike} onChange={(e) => setStakeSpike(e.target.checked)} /> stake_velocity_spike</label>
              <label><input type="checkbox" checked={freqSpike} onChange={(e) => setFreqSpike(e.target.checked)} /> frequency_spike</label>
              <label>consecutive_overrides
                <input type="number" value={consOverrides} onChange={(e) => setConsOverrides(Number(e.target.value))}
                  style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
              </label>
              <label>cooldown_violations
                <input type="number" value={cdViolations} onChange={(e) => setCdViolations(Number(e.target.value))}
                  style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }} />
              </label>
              <label><input type="checkbox" checked={cdActive} onChange={(e) => setCdActive(e.target.checked)} /> cooldown_active (hard stop)</label>
            </div>
          </details>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Decision</h2>

          <div style={{ padding: 14, borderRadius: 12, border: "1px solid #eee", background: "#fafafa" }}>
            <div style={{ fontSize: 28, fontWeight: 900 }}>{decision.verdict}</div>

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
              <Metric label="friction_required" value={String(decision.friction_required)} />
              <Metric label="cooldown_triggered" value={String(decision.cooldown_triggered)} />
            </div>
          </div>

          <h3 style={{ marginTop: 18, fontSize: 14 }}>Framework Usage (visual)</h3>

          <ProgressCard
            title="Daily Exposure"
            subtitle={`Cap: ${money(caps.daily_cap)} (${rules.daily_pct}%)`}
            current={exposures.daily_staked}
            projected={projected.daily}
            cap={caps.daily_cap}
          />
          <ProgressCard
            title="Weekly Exposure"
            subtitle={`Cap: ${money(caps.weekly_cap)} (${rules.weekly_pct}%)`}
            current={exposures.weekly_staked}
            projected={projected.weekly}
            cap={caps.weekly_cap}
          />
          <ProgressCard
            title="Same Group1 Concentration"
            subtitle={`Cap: ${money(caps.event_cap)} (${rules.group1_pct}%)`}
            current={exposures.same_group1_staked}
            projected={projected.event}
            cap={caps.event_cap}
          />
          <ProgressCard
            title="Same Group2 Concentration (rolling 7d)"
            subtitle={`Cap: ${money(caps.team_cap)} (${rules.group2_pct}%)`}
            current={exposures.same_group2_7d_staked}
            projected={projected.team7d}
            cap={caps.team_cap}
          />
          <ProgressCard
            title="Action Frequency"
            subtitle={`Cap: ${rules.freq_cap} / day`}
            current={exposures.bets_today}
            projected={projected.bets}
            cap={rules.freq_cap}
            isCount
          />

          <h3 style={{ marginTop: 18, fontSize: 14 }}>Current Exposures (numbers)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Metric label="daily_staked" value={money(exposures.daily_staked)} />
            <Metric label="weekly_staked (ISO week)" value={money(exposures.weekly_staked)} />
            <Metric label="same_group1_staked" value={money(exposures.same_group1_staked)} />
            <Metric label="same_group2_7d_staked" value={money(exposures.same_group2_7d_staked)} />
            <Metric label="bets_today" value={String(exposures.bets_today)} />
            <Metric label="ledger_entries" value={String(ledger.length)} />
          </div>

          <p style={{ marginTop: 14, fontSize: 12, color: "#666" }}>
            This tool enforces your self-defined framework. It does not predict outcomes or guarantee results.
          </p>
        </div>
      </div>
    </div>
  );
}

/** ---------- UI helpers ---------- */
function RuleRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "block" }}>
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
      />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 12, color: "#555" }}>{label}</div>
      <div style={{ fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function money(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function ProgressCard({
  title,
  subtitle,
  current,
  projected,
  cap,
  isCount
}: {
  title: string;
  subtitle: string;
  current: number;
  projected: number;
  cap: number;
  isCount?: boolean;
}) {
  const curPct = cap > 0 ? current / cap : 0;
  const projPct = cap > 0 ? projected / cap : 0;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 900 }}>{title}</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{subtitle}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "#666" }}>Current → Projected</div>
          <div style={{ fontWeight: 900 }}>
            {isCount ? `${current} → ${projected}` : `${money(current)} → ${money(projected)}`}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
          {pctLabel(curPct)} current • {pctLabel(projPct)} projected
        </div>

        {/* Base bar */}
        <div style={{ position: "relative", height: 12, borderRadius: 999, background: "#f0f0f0", overflow: "hidden" }}>
          {/* Current fill */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${clamp01(curPct) * 100}%`,
              background: "#999"
            }}
          />
          {/* Projected overlay (darker) */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${clamp01(projPct) * 100}%`,
              background: "#111",
              opacity: 0.35
            }}
          />
        </div>

        {/* Cap marker line */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#777", marginTop: 6 }}>
          <span>0%</span>
          <span>100%</span>
        </div>

        {/* Over-cap note */}
        {projPct > 1 && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 800 }}>
            Projected exceeds cap by {pctLabel(projPct - 1)}.
          </div>
        )}
      </div>
    </div>
  );
}

function pctLabel(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}
