// Pure: from the facts read off an article folder (and its PRs) to a stage. No I/O, no clock.
//
// The stage is never written by hand. Rules, the furthest progress wins:
//   override.stage                         -> that stage (status.override.json is the only hand-set state)
//   a PR is merged (none open)             -> 公開済み
//   a PR is open (or GitHub could not say) and the editor has not confirmed (finished.json missing) -> awaiting-confirm
//   confirmed, PR open, CI green, pr_gate MERGE_OK / NEEDS_AUTHOR on the current head -> マージ待ち
//   confirmed, PR open otherwise (CI pending or failing, no gate yet, gate BLOCKED / MANUAL_CHECK, gate for an older head) -> ゲート/CI
//   every editor target has finished.json, no PR found -> PR不明 (it may be unmade or made without a record,
//                                            so "waiting for a PR" is not claimed)
//   an editor target has no finished.json  -> awaiting-confirm
//   latest review report is needs_input    -> awaiting-decision
//   otherwise                              -> 執筆中
// "Confirmed" means an editor run exists and every target has finished.json. An article with no editor run is not confirmed.
// An older needs_input report next to an editor run is stale: the run is made from the answered review.
import { loadSettings } from './config.ts';
import { WAITING_FOR_STAGE, type EditorRun, type Override, type PrInfo, type Stage, type WaitingOn } from './schema.ts';

export type ReportFact = { file: string; status: string | null; mtimeMs: number; questionIds: string[] };

export type StageFacts = {
  reports: ReportFact[];
  editorRuns: Pick<EditorRun, 'relPath' | 'targets'>[];
  prs: PrInfo[];
  override: Override | null;
  /** 〔<author>の…〕 style placeholders left in the manuscript text. */
  placeholders?: string[];
  /** Stage names to put in the reasons. Default: the configured ones. */
  labels?: Record<Stage, string>;
};

export type StageResult = { stage: Stage; waitingOn: WaitingOn; openDecisions: number | null; reasons: string[]; warnings: string[] };

export const latestReviewReport = (reports: ReportFact[]): ReportFact | null =>
  reports.filter((r) => r.status).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;

export function deriveStage(facts: StageFacts): StageResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const L = facts.labels ?? loadSettings().stageLabels;
  const report = latestReviewReport(facts.reports);
  const targets = facts.editorRuns.flatMap((r) => r.targets);
  const known = facts.prs.filter((p) => p.state !== 'unknown');
  const merged = known.filter((p) => p.state === 'merged');
  const open = known.filter((p) => p.state === 'open');
  const unchecked = facts.prs.length > 0 && known.length === 0;

  const finished = targets.length > 0 && targets.every((t) => t.finished);
  const openPr = [...open].sort((x, y) => y.number - x.number)[0];

  let stage: Stage;
  let verdict: string | null = null;
  if (merged.length > 0 && open.length === 0) {
    stage = 'published';
    reasons.push(`PR ${merged.map((p) => `#${p.number}`).join('・')} がマージ済み → ${L.published}`);
  } else if (open.length > 0 || unchecked) {
    const label = open.length > 0 ? `PR ${open.map((p) => `#${p.number}`).join('・')} が open` : '報告に PR の記載があるが GitHub から状態を取れなかった（open と仮定）';
    if (unchecked) warnings.push('PR の状態を取得できなかったため、段階は仮定');
    if (open.length > 0 && merged.length > 0) warnings.push(`マージ済みの PR（${merged.map((p) => `#${p.number}`).join('・')}）と open の PR が混在。open がある間は open として扱う`);
    if (!finished) {
      stage = 'awaiting-confirm';
      reasons.push(`${label}、ただし finished.json がない（${targets.length === 0 ? 'editor-run なし' : `未確定の対象 ${targets.filter((t) => !t.finished).length} 件`}）→ ${L['awaiting-confirm']}`);
    } else if (!openPr) {
      stage = 'gate-ci';
      reasons.push(`${label} → ${L['gate-ci']} と仮定`);
    } else {
      const ci = openPr.ci?.state ?? 'none';
      const gate = openPr.gate && !openPr.gate.stale ? openPr.gate : null;
      if (openPr.gate?.stale) warnings.push(`pr_gate の判定（${openPr.gate.verdict}）は古い head（${openPr.gate.headSha?.slice(0, 7)}）のもの。現在の head は ${openPr.headSha?.slice(0, 7)}`);
      if (ci === 'success' && gate && (gate.verdict === 'MERGE_OK' || gate.verdict === 'NEEDS_AUTHOR')) {
        stage = 'merge-ready';
        verdict = gate.verdict;
        reasons.push(`確定済み、${label}、CI green、pr_gate ${gate.verdict} → ${L['merge-ready']}`);
      } else {
        stage = 'gate-ci';
        reasons.push(`確定済み、${label}、CI ${ci}${openPr.ci?.failing.length ? `（失敗: ${openPr.ci.failing.join('・')}）` : ''}、pr_gate ${gate ? gate.verdict : '未判定'} → ${L['gate-ci']}`);
      }
    }
  } else if (finished) {
    stage = 'pr-unknown';
    reasons.push(`editor-run のすべての対象に finished.json があるが、記録にも報告にも PR 一覧のブランチ名にも PR が見つからない → ${L['pr-unknown']}（${L['awaiting-pr']}とは言い切らない）`);
  } else if (targets.some((t) => !t.finished)) {
    stage = 'awaiting-confirm';
    reasons.push(`finished.json のない対象が ${targets.filter((t) => !t.finished).length} 件 → ${L['awaiting-confirm']}`);
  } else if (report?.status === 'needs_input') {
    stage = 'awaiting-decision';
    reasons.push(`最新の copy-review 報告（${report.file}）が needs_input → ${L['awaiting-decision']}`);
  } else {
    stage = 'writing';
    reasons.push(report ? `最新の copy-review 報告（${report.file}）は ${report.status}、editor-run も PR もない → ${L.writing}` : `報告・editor-run・PR のどれもない → ${L.writing}`);
  }
  if (facts.prs.some((p) => p.state === 'closed') && known.every((p) => p.state === 'closed')) reasons.push('見つかった PR はすべて closed（未マージ）なので段階には使わない');

  let waitingOn: WaitingOn = WAITING_FOR_STAGE[stage];
  if (stage === 'merge-ready' && verdict === 'MERGE_OK') waitingOn = 'agent';
  const o = facts.override;
  if (o?.stage) {
    stage = o.stage;
    waitingOn = WAITING_FOR_STAGE[stage];
    reasons.push(`status.override.json の stage（${L[stage]}）を優先`);
  }
  if (o?.waiting_on) {
    waitingOn = o.waiting_on;
    reasons.push(`status.override.json の waiting_on（${o.waiting_on}）を優先`);
  }

  // 未決: questions still open in the needs_input report that holds the article at the decision step, plus the
  // placeholders (〔<author>の体験：…〕) left in the text. null only when there is nothing at all to count from.
  const placeholders = facts.placeholders ?? [];
  const questions = stage === 'awaiting-decision' && report?.status === 'needs_input' ? report.questionIds.length : 0;
  const countable = report !== null || facts.editorRuns.length > 0;
  const openDecisions = countable ? questions + placeholders.length : null;
  if (placeholders.length > 0) reasons.push(`本文に未記入の ${placeholders.length} 件（${placeholders.slice(0, 3).join(' / ')}）→ 未決に加算`);
  return { stage, waitingOn, openDecisions, reasons, warnings };
}

const PLACEHOLDER = /〔([^〕\n]{1,200})〕/g;
/** Labels of the 〔…〕 placeholders that ask the author for something (〔<author>の体験：…〕, 要確認, TODO). Structural markers such as 〔図1：キャプション〕 are not counted. */
export function findPlaceholders(text: string, author: string = loadSettings().author): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((label) => label.startsWith(author) || /(要確認|要入力|未記入|TBD|TODO)/i.test(label));
}
