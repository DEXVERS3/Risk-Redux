"use client";
import React, { useEffect, useMemo, useState } from "react";

/** ---------- Types ---------- */
type UserRules = {
  unit_pct: number;
  daily_pct: number;
  weekly_pct: number;
  group1_pct: number;
  group2_pct: number;
  freq_cap: number;
  odds_gate: number;
};
type ProposedBet = { stake: number; odds: number; group1_id: string; group2_id: string; };
type Exposures = { daily_staked: number; weekly_staked: number; same_group1_staked: number; same_group2_7d_staked: number; bets_today: number; };
type BehavioralState = { stake_velocity_spike: boolean; frequency_spike: boolean; consecutive_overrides: number; cooldown_violations: number; cooldown_active: boolean; };
type Verdict = "ALLOW" | "WARN" | "HARD_WARN" | "RED_ALERT";
type DecisionResult = { verdict: Verdict; reasons: string[]; friction_required: boolean; cooldown_triggered: boolean; };

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
  unit_pct: 2, daily_pct: 6, weekly_pct: 20, group1_pct: 4, group2_pct: 8, freq_cap: 5, odds_gate: 250
};

function isValidAmericanOdds(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n) && n !== 0;
}
function rank(v: Verdict): number { return v === "ALLOW" ? 0 : v === "WARN" ? 1 : v === "HARD_WARN" ? 2 : 3; }
function maxTier(a: Verdict, b: Verdict): Verdict { return rank(a) >= rank(b) ? a : b; }
function escalateOneTier(v: Verdict): Verdict { return v === "ALLOW" ? "WARN" : v === "WARN" ? "HARD_WARN" : "RED_ALERT"; }

function evaluate_v1(bankroll: number, rules: UserRules, bet: ProposedBet, exp: Exposures, beh: BehavioralState): DecisionResult {
  if (beh.cooldown_active) return { verdict: "RED_ALERT", reasons: [R.CD_ACTIVE], friction_required: true, cooldown_triggered: true };

  const B = bankroll, S = bet.stake;
  const unit_cap = B * (rules.unit_pct / 100);
  const daily_cap = B * (rules.daily_pct / 100);
  const weekly_cap = B * (rules.weekly_pct / 100);
  const event_cap = B * (rules.group1_pct / 100);
  const team_cap = B * (rules.group2_pct / 100);

  const post_daily = exp.daily_staked + S;
  const post_weekly = exp.weekly_staked + S;
  const post_event = exp.same_group1_staked + S;
  const post_team7d = exp.same_group2_7d_staked + S;
  const post_bets = exp.bets_today + 1;

  const violations: string[] = [];
  const gates: string[] = [];
  const flags: string[] = [];

  if (S > unit_cap) violations.push(R.UNIT);
  if (post_daily > daily_cap) violations.push(R.DAILY);
  if (post_weekly > weekly_cap) violations.push(R.WEEKLY);
  if (post_event > event_cap) violations.push(R.EVENT);
  if (post_team7d > team_cap) violations.push(R.TEAM);
  if (post_bets > rules.freq_cap) violations.push(R.FREQ);

  const oddsInvalid = !isValidAmericanOdds(bet.odds);
  if (oddsInvalid || bet.odds >= rules.odds_gate) gates.push(R.ODDS);

  if (beh.stake_velocity_spike) flags.push(R.STAKE_SPIKE);
  if (beh.frequency_spike) flags.push(R.FREQ_SPIKE);
  if (beh.consecutive_overrides >= 2) flags.push(R.CONS_OVR);
  if (beh.cooldown_violations >= 1) flags.push(R.CD_HIST);

  let verdict: Verdict = "ALLOW";
  const vCount = violations.length;
  const gCount = gates.length;

  if (vCount === 0 && gCount === 0) verdict = "ALLOW";
  else if (vCount === 0 && gCount > 0) verdict = "WARN";
  else if (vCount === 1) verdict = "WARN";
  else if (vCount >= 2) verdict = "HARD_WARN";

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

/** ---------- Storage ---------- */
type LedgerEntry = { id: string; ts: number; stake: number; odds: number; group1_id: string; group2_id: string; verdict: Verdict; reasons: string[]; };
const LEDGER_KEY = "rr_v1_ledger";
const RULES_KEY = "rr_v1_rules";

function loadLedger(): LedgerEntry[] {
  try { const raw = localStorage.getItem(LEDGER_KEY); if (!raw) return []; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveLedger(entries: LedgerEntry[]) { localStorage.setItem(LEDGER_KEY, JSON.stringify(entries)); }
function loadRules(): UserRules {
  try { const raw = localStorage.getItem(RULES_KEY); if (!raw) return DEFAULT_RULES; const parsed = JSON.parse(raw); return { ...DEFAULT_RULES, ...parsed }; }
  catch { return DEFAULT_RULES; }
}
function saveRules(rules: UserRules) { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); }

function startOfLocalDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0).getTime(); }
function startOfISOWeekLocal(d: Date): number {
  const day = d.getDay();
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  return startOfLocalDay(monday);
}
const MS_7D = 7*24*60*60*1000;

function computeExposures(ledger: LedgerEntry[], group1_id: string, group2_id: string): Exposures {
  const now = new Date();
  const dayStart = startOfLocalDay(now);
  const weekStart = startOfISOWeekLocal(now);
  const t7 = now.getTime() - MS_7D;

  let daily=0, weekly=0, sameG1=0, sameG2=0, betsToday=0;
  for (const e of ledger) {
    if (e.ts >= dayStart) { daily += e.stake; betsToday += 1; if (e.group1_id === group1_id) sameG1 += e.stake; }
    if (e.ts >= weekStart) weekly += e.stake;
    if (e.ts >= t7 && e.group2_id === group2_id) sameG2 += e.stake;
  }
  return { daily_staked: daily, weekly_staked: weekly, same_group1_staked: sameG1, same_group2_7d_staked: sameG2, bets_today: betsToday };
}

/** ---------- UI helpers ---------- */
function money(n: number): string { if (!Number.isFinite(n)) return "—"; return n.toFixed(2); }
function clamp01(x: number): number { if (!Number.isFinite(x)) return 0; return x < 0 ? 0 : x > 1 ? 1 : x; }
function pct(x: number): string { if (!Number.isFinite(x)) return "—"; return `${Math.round(x*100)}%`; }

function badgeClass(v: Verdict): string {
  if (v === "ALLOW") return "badge badgeOK";
  if (v === "WARN") return "badge badgeWARN";
  if (v === "HARD_WARN") return "badge badgeHARD";
  return "badge badgeRED flashRed";
}
function statusLabel(v: Verdict): string {
  if (v === "ALLOW") return "CLEAR";
  if (v === "WARN") return "WARM WARNING";
  if (v === "HARD_WARN") return "HARD WARNING";
  return "RED ALERT";
}

export default function Page() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [rules, setRules] = useState<UserRules>(DEFAULT_RULES);

  const [bankroll, setBankroll] = useState(1000);
  const [stake, setStake] = useState(20);
  const [odds, setOdds] = useState(-110);
  const [group1, setGroup1] = useState("EVENT-1");
  const [group2, setGroup2] = useState("TEAM-1");

  const [stakeSpike, setStakeSpike] = useState(false);
  const [freqSpike, setFreqSpike] = useState(false);
  const [consOverrides, setConsOverrides] = useState(0);
  const [cdViolations, setCdViolations] = useState(0);
  const [cdActive, setCdActive] = useState(false);

  useEffect(() => { setLedger(loadLedger()); setRules(loadRules()); }, []);
  useEffect(() => { saveRules(rules); }, [rules]);

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
    const bet: ProposedBet = { stake: Number(stake) || 0, odds: Number(odds), group1_id: group1.trim(), group2_id: group2.trim() };
    const beh: BehavioralState = { stake_velocity_spike: stakeSpike, frequency_spike: freqSpike, consecutive_overrides: consOverrides, cooldown_violations: cdViolations, cooldown_active: cdActive };
    return evaluate_v1(Number(bankroll) || 0, rules, bet, exposures, beh);
  }, [bankroll, rules, stake, odds, group1, group2, exposures, stakeSpike, freqSpike, consOverrides, cdViolations, cdActive]);

  function addToLedger() {
    const entry: LedgerEntry = { id: crypto.randomUUID(), ts: Date.now(), stake: Number(stake) || 0, odds: Number(odds), group1_id: group1.trim(), group2_id: group2.trim(), verdict: decision.verdict, reasons: decision.reasons };
    const next = [entry, ...ledger].slice(0, 500);
    setLedger(next);
    saveLedger(next);
  }
  function resetLedger() { setLedger([]); saveLedger([]); }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div className="kicker">RISK GOVERNANCE TERMINAL</div>
      <h1 className="h1">RISK-REDUX</h1>
      <div className="sub">Deterministic framework enforcement. No outcome prediction. Your rules. Your exposure. Your call.</div>

      <div className="hr" />

      <div className="grid">
        <div className="panel"><div className="panel-inner">
          <div className="pills" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="kicker">INPUTS</div>
              <div style={{ fontWeight: 900, fontSize: 16, marginTop: 4 }}>Capital & Position</div>
            </div>
            <div className={badgeClass(decision.verdict)}><span className="dot" /><span>{statusLabel(decision.verdict)}</span></div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label className="label">Capital (Bankroll)</label>
            <input className="input" type="number" value={bankroll} onChange={(e) => setBankroll(Number(e.target.value))} />
          </div>

          <div className="row2" style={{ marginTop: 12 }}>
            <div>
              <label className="label">Stake</label>
              <input className="input" type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))} />
              <div className="note">Unit cap: {money(caps.unit_cap)}</div>
            </div>
            <div>
              <label className="label">Odds (American)</label>
              <input className="input" type="number" value={odds} onChange={(e) => setOdds(Number(e.target.value))} />
              <div className="note">Gate triggers at ≥ +{rules.odds_gate}</div>
            </div>
          </div>

          <div className="row2" style={{ marginTop: 12 }}>
            <div>
              <label className="label">Group1 ID (event / asset / policy)</label>
              <input className="input" value={group1} onChange={(e) => setGroup1(e.target.value)} />
            </div>
            <div>
              <label className="label">Group2 ID (team / sector / market)</label>
              <input className="input" value={group2} onChange={(e) => setGroup2(e.target.value)} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            <button className="btn btnPrimary" onClick={addToLedger}>Commit to Ledger</button>
            <button className="btn" onClick={resetLedger}>Reset Ledger</button>
          </div>

          <div className="hr" />

          <details>
            <summary>RULE SETTINGS (user-owned)</summary>
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <RuleRow label="Unit cap %" value={rules.unit_pct} onChange={(v) => setRules({ ...rules, unit_pct: v })} />
              <RuleRow label="Daily cap %" value={rules.daily_pct} onChange={(v) => setRules({ ...rules, daily_pct: v })} />
              <RuleRow label="Weekly cap %" value={rules.weekly_pct} onChange={(v) => setRules({ ...rules, weekly_pct: v })} />
              <RuleRow label="Group1 cap %" value={rules.group1_pct} onChange={(v) => setRules({ ...rules, group1_pct: v })} />
              <RuleRow label="Group2 cap % (rolling 7d)" value={rules.group2_pct} onChange={(v) => setRules({ ...rules, group2_pct: v })} />
              <RuleRow label="Bets/day cap" value={rules.freq_cap} onChange={(v) => setRules({ ...rules, freq_cap: v })} />
              <RuleRow label="Odds gate threshold (+)" value={rules.odds_gate} onChange={(v) => setRules({ ...rules, odds_gate: v })} />
            </div>
          </details>

          <details style={{ marginTop: 12 }}>
            <summary>BEHAVIOR FLAGS (optional)</summary>
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              <Toggle label="stake_velocity_spike" checked={stakeSpike} onChange={setStakeSpike} />
              <Toggle label="frequency_spike" checked={freqSpike} onChange={setFreqSpike} />
              <RuleRow label="consecutive_overrides" value={consOverrides} onChange={(v) => setConsOverrides(v)} />
              <RuleRow label="cooldown_violations" value={cdViolations} onChange={(v) => setCdViolations(v)} />
              <Toggle label="cooldown_active (hard stop)" checked={cdActive} onChange={setCdActive} />
            </div>
          </details>
        </div></div>

        <div className="panel"><div className="panel-inner">
          <div className="kicker">OUTPUT</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <div style={{ fontWeight: 900, fontSize: 18, marginTop: 6 }}>Capital Status</div>
            <div style={{ fontFamily: "var(--mono)" as any, color: "var(--muted)" as any, fontSize: 12 }}>
              friction: {String(decision.friction_required)} • cooldown: {String(decision.cooldown_triggered)}
            </div>
          </div>

          <div className="hr" />

          <div className="miniGrid">
            <Metric label="verdict" value={decision.verdict} />
            <Metric label="ledger_entries" value={String(ledger.length)} />
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="kicker">REASONS (ordered)</div>
            {decision.reasons.length === 0 ? (
              <div style={{ marginTop: 8, color: "var(--muted)" as any }}>None</div>
            ) : (
              <ul style={{ marginTop: 8, paddingLeft: 18, fontFamily: "var(--mono)" as any, fontSize: 12 }}>
                {decision.reasons.map((r, i) => <li key={`${r}-${i}`}>{r}</li>)}
              </ul>
            )}
          </div>

          <div className="hr" />

          <div className="kicker">FRAMEWORK USAGE (current → projected)</div>

          <ProgressCard title="Daily Exposure" subtitle={`Cap ${money(caps.daily_cap)} (${rules.daily_pct}%)`} current={exposures.daily_staked} projected={projected.daily} cap={caps.daily_cap} />
          <ProgressCard title="Weekly Exposure" subtitle={`Cap ${money(caps.weekly_cap)} (${rules.weekly_pct}%)`} current={exposures.weekly_staked} projected={projected.weekly} cap={caps.weekly_cap} />

          <details style={{ marginTop: 12 }}>
            <summary>MORE METRICS</summary>
            <div style={{ marginTop: 10 }}>
              <ProgressCard title="Same Group1 Concentration" subtitle={`Cap ${money(caps.event_cap)} (${rules.group1_pct}%)`} current={exposures.same_group1_staked} projected={projected.event} cap={caps.event_cap} />
              <ProgressCard title="Same Group2 Concentration (rolling 7d)" subtitle={`Cap ${money(caps.team_cap)} (${rules.group2_pct}%)`} current={exposures.same_group2_7d_staked} projected={projected.team7d} cap={caps.team_cap} />
              <ProgressCard title="Action Frequency" subtitle={`Cap ${rules.freq_cap} / day`} current={exposures.bets_today} projected={projected.bets} cap={rules.freq_cap} isCount />
            </div>
          </details>

          <div className="hr" />

          <div className="kicker">CURRENT EXPOSURES</div>
          <div className="miniGrid" style={{ marginTop: 10 }}>
            <Metric label="daily_staked" value={money(exposures.daily_staked)} />
            <Metric label="weekly_staked" value={money(exposures.weekly_staked)} />
            <Metric label="group1_staked" value={money(exposures.same_group1_staked)} />
            <Metric label="group2_7d_staked" value={money(exposures.same_group2_7d_staked)} />
            <Metric label="bets_today" value={String(exposures.bets_today)} />
            <Metric label="odds_gate" value={String(rules.odds_gate)} />
          </div>

          <div className="note" style={{ marginTop: 12 }}>
            This tool enforces your self-defined framework. It does not predict outcomes or guarantee results.
          </div>
        </div></div>
      </div>
    </div>
  );
}

function RuleRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--mono)" as any, fontSize: 12, color: "var(--muted)" as any }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
function ProgressCard({ title, subtitle, current, projected, cap, isCount }: { title: string; subtitle: string; current: number; projected: number; cap: number; isCount?: boolean; }) {
  const curPct = cap > 0 ? current / cap : 0;
  const projPct = cap > 0 ? projected / cap : 0;
  return (
    <div className="progress" style={{ marginTop: 10 }}>
      <div className="progressTop">
        <div>
          <div className="progressTitle">{title}</div>
          <div className="progressSub">{subtitle}</div>
        </div>
        <div className="progressNumbers">
          {isCount ? `${current} → ${projected}` : `${money(current)} → ${money(projected)}`}
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted2)" as any }}>{pct(curPct)} current • {pct(projPct)} projected</div>
        </div>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${clamp01(curPct) * 100}%` }} />
        <div className="overlay" style={{ width: `${clamp01(projPct) * 100}%` }} />
      </div>
      {projPct > 1 && (
        <div className="note" style={{ color: "var(--warn)" as any, fontFamily: "var(--mono)" as any }}>
          Projected exceeds cap by {pct(projPct - 1)}.
        </div>
      )}
    </div>
  );
}
