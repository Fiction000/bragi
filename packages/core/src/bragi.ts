#!/usr/bin/env node
// bragi: read-only CLI over the ledger and the list.
//   bragi context <draft>   Markdown of the decisions that apply to the article
//   bragi list              one line per article
//   bragi candidates <slug> the questions in the article's copy-review reports, as candidate decisions (nothing is written)
//   bragi recurrence [slug] how many articles each decision recurs in (with a slug: only decisions that article's findings fall under)
//   bragi edit-volume <dir> how much the author changed each confirmed draft (a run folder, or a folder searched for finished.json). A record only: no comparison, no cause
// Options: --drafts-root <dir> --ledger <dir> --tasknotes <dir> --drafts-index <file> --github (ask GitHub; off by default) --json (candidates, recurrence)
import { parseArgs } from 'node:util';
import { createGhGraphql } from './github.ts';
import { getCandidates, getContextWithMedium, getRecurrence, listDrafts } from './service.ts';
import { getEditVolume, renderEditVolume } from './edit-volume.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'drafts-root': { type: 'string' }, ledger: { type: 'string' }, tasknotes: { type: 'string' }, 'drafts-index': { type: 'string' }, github: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } },
});
const options = { draftsRoot: values['drafts-root'], ledgerDir: values.ledger, taskNotesDir: values.tasknotes, draftsIndex: values['drafts-index'], github: values.github ? createGhGraphql() : null };
const [command, arg] = positionals;

try {
  if (command === 'context' && arg) {
    const r = await getContextWithMedium(options, arg);
    process.stdout.write(r.text);
    // stderr only: stdout stays the Markdown a machine reads.
    if (r.medium === null) process.stderr.write(`bragi: medium is unknown for ${arg}: add \`medium:\` to article.yaml\n`);
  }
  else if (command === 'list') {
    for (const d of (await listDrafts(options)).drafts) process.stdout.write(`${d.slug}\t${d.medium ?? '-'}\t${d.stageLabel}\t${d.waitingOn}\t${d.due ?? '-'}\n`);
  } else if (command === 'candidates' && arg) {
    const r = await getCandidates(options, arg);
    process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : r.text);
  } else if (command === 'recurrence') {
    const r = await getRecurrence(options, arg);
    process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : r.text);
  } else if (command === 'edit-volume' && arg) {
    const r = await getEditVolume(arg);
    process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : renderEditVolume(r));
  } else {
    process.stderr.write('usage: bragi context <draft> | bragi list | bragi candidates <draft> | bragi recurrence [draft] | bragi edit-volume <run-or-folder>  [--drafts-root dir] [--ledger dir] [--tasknotes dir] [--drafts-index file] [--github] [--json]\n');
    process.exitCode = command ? 2 : values.help ? 0 : 2;
  }
} catch (e) {
  process.stderr.write(`bragi: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
