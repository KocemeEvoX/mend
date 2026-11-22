// mend: one patch tool for every AI edit format.
// Node 22, standard library only. SPEC.md is the contract: unified diffs,
// SEARCH/REPLACE blocks, V4A patches and JSON edits, applied to a tree of
// text files, every file changed or none.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

type Failure = { code: string; path: string };
type ParseOut<T> = { ok: true; value: T } | { ok: false; line: number };

interface Edit {
  paths: string[];
  apply(t: Tree, strict: boolean): Failure | null;
}

// ---------------------------------------------------------------------------
// Working tree: files are read from disk lazily and changed only in memory
// until the whole patch has succeeded.
// ---------------------------------------------------------------------------

class Tree {
  orig = new Map<string, string | null>();
  work = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];

  get(p: string): string | null {
    if (this.work.has(p)) return this.work.get(p) as string | null;
    let v: string | null = null;
    try {
      if (existsSync(p)) v = readFileSync(p, 'utf8');
    } catch {
      v = null;
    }
    this.orig.set(p, v);
    this.work.set(p, v);
    return v;
  }

  set(p: string, v: string | null): void {
    this.work.set(p, v);
  }

  exists(p: string): boolean {
    return this.get(p) !== null;
  }
}

function isSafePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text and lines. A file's line break is CRLF when its first line feed
// follows a carriage return, and LF otherwise.
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function renderLines(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// A patch's lines: split at \n, one trailing \r removed from each, no empty
// piece after a final \n.
function patchLines(text: string): string[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Three-tier line matching (SPEC section 5).
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number; // index into O for context lines, -1 otherwise
}

// Build the replacement lines for a matched occurrence. Context lines are
// written as the file's own matched line, never the patch's. At tier 2 every
// other line is re-indented from the old lines' indent to the file's.
function buildReplacement(n: NLine[], o: string[], file: string[], start: number, tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  const f = leadingWs(file[start]);
  for (const item of n) {
    if (item.ctx) {
      out.push(file[start + item.oIdx]);
    } else if (tier === 2) {
      const t = item.text;
      if (t === '' || /^[ \t]+$/.test(t)) out.push(t);
      else if (t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// Count overlapping occurrences of needle in text.
function countOverlapping(text: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) return n;
    n++;
    from = i + 1;
  }
}

// ---------------------------------------------------------------------------
// Command line (SPEC section 1) and format detection (section 4).
// ---------------------------------------------------------------------------

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseCli(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let afterDashDash = false;
  const formats = ['unified', 'search-replace', 'v4a', 'json', 'auto'];
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        const v = arg.slice('--format='.length);
        if (!formats.includes(v)) return null;
        seenFormat = true;
        format = v;
      } else {
        return null;
      }
      continue;
    }
    if (patch !== null) return null;
    patch = arg;
  }
  return { format: format ?? 'auto', check, strict, patch };
}

function detectFormat(lines: string[]): string | null {
  const nonBlank = lines.filter((l) => l.trim() !== '');
  if (nonBlank.length === 0) return null;
  if (nonBlank[0].trim() === '*** Begin Patch') return 'v4a';
  const first = nonBlank[0].replace(/^\s+/, '');
  if (first.startsWith('[') || first.startsWith('{')) return 'json';
  if (lines.some((l) => stripTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l) => l.startsWith('diff --git '))) return 'unified';
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6).
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  rawEmpty: boolean; // the raw patch line was empty (not ' ')
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): ParseOut<Section[]> {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;

  const newSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    hasPair = false;
    return s;
  };

  const parseDiffGit = (l: string): [string, string] | null => {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l.replace(/[ \t]+$/, ''));
    return m ? [m[1], m[2]] : null;
  };

  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

  const headerPath = (rest: string): string | null => {
    const p = rest.split('\t')[0].trim();
    if (p === '/dev/null') return null;
    return stripPrefix(p);
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (!dg) return { ok: false, line: i + 1 };
      const s = newSection();
      s.oldPath = dg[0];
      s.newPath = dg[1];
      i++;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.oldPath = headerPath(l.slice(4));
        cur.newPath = headerPath(lines[i + 1].slice(4));
        hasPair = true;
      } else {
        const s = newSection();
        s.oldPath = headerPath(l.slice(4));
        s.newPath = headerPath(lines[i + 1].slice(4));
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) {
      return { ok: false, line: i + 2 };
    }
    if (l.startsWith('@@')) {
      if (cur === null) return { ok: false, line: i + 1 };
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) return { ok: false, line: i + 1 };
      const hunk: Hunk = { a: parseInt(m[1], 10), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
          i++;
        } else if (b.startsWith(' ')) {
          hunk.body.push({ kind: 'ctx', text: b.slice(1), rawEmpty: false });
          i++;
        } else if (b.startsWith('-')) {
          hunk.body.push({ kind: 'old', text: b.slice(1), rawEmpty: false });
          i++;
        } else if (b.startsWith('+')) {
          hunk.body.push({ kind: 'new', text: b.slice(1), rawEmpty: false });
          i++;
        } else if (b.startsWith('\\')) {
          hunk.body.push({ kind: 'bs', text: '', rawEmpty: false });
          i++;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.rawEmpty) hunk.body.pop();
        else break;
      }
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.creation = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return { ok: true, value: sections };
}

// Whether a '\' line follows the hunk's last context or '+' line.
function backslashAfterLast(body: BodyLine[]): boolean {
  let lastIdx = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k].kind === 'ctx' || body[k].kind === 'new') lastIdx = k;
  }
  if (lastIdx < 0) return false;
  return body[lastIdx + 1] !== undefined && body[lastIdx + 1].kind === 'bs';
}

function hunkON(hunk: Hunk): { o: NLine[]; n: NLine[] } {
  const o: NLine[] = [];
  const n: NLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push({ text: b.text, ctx: true, oIdx: idx });
      n.push({ text: b.text, ctx: true, oIdx: idx });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false, oIdx: -1 });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

interface HunkResult {
  lines: string[];
  finalBreak: boolean;
  dDelta: number;
  fail?: string;
}

function applyHunk(
  lines: string[],
  finalBreak: boolean,
  hunk: Hunk,
  strict: boolean,
  d: number,
): HunkResult {
  const { o, n } = hunkON(hunk);
  const oTexts = o.map((x) => x.text);
  const bs = backslashAfterLast(hunk.body);
  if (oTexts.length === 0) {
    const ins = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const nLines = n.map((x) => x.text);
    const nl = [...lines];
    nl.splice(ins, 0, ...nLines);
    let fb = finalBreak;
    if (ins === lines.length && nLines.length > 0) fb = !bs;
    return { lines: nl, finalBreak: fb, dDelta: nLines.length };
  }
  const found = findTier(lines, oTexts, strict);
  if (!found) return { lines, finalBreak, dDelta: 0, fail: 'no-match' };
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const rep = buildReplacement(n, oTexts, lines, best, found.tier);
  const nl = [...lines];
  nl.splice(best, oTexts.length, ...rep);
  let fb = finalBreak;
  if (best + oTexts.length === lines.length) fb = !bs;
  return { lines: nl, finalBreak: fb, dDelta: rep.length - oTexts.length };
}

function unifiedEdit(sec: Section): Edit {
  const creation = sec.oldPath === null || sec.creation;
  const deletion = !creation && (sec.newPath === null || sec.deletion);
  const move = !creation && !deletion && sec.oldPath !== sec.newPath;
  const oldPath = sec.oldPath ?? '';
  const newPath = sec.newPath ?? '';
  const paths = creation ? [newPath] : deletion ? [oldPath] : move ? [oldPath, newPath] : [oldPath];
  return {
    paths,
    apply(t: Tree, strict: boolean): Failure | null {
      if (creation) {
        if (t.exists(newPath)) return { code: 'exists', path: newPath };
        const plus: string[] = [];
        let noFinal = false;
        for (const hunk of sec.hunks) {
          let lastPlus = -1;
          for (let k = 0; k < hunk.body.length; k++) {
            if (hunk.body[k].kind === 'new') lastPlus = k;
          }
          if (lastPlus >= 0) {
            noFinal = hunk.body[lastPlus + 1] !== undefined && hunk.body[lastPlus + 1].kind === 'bs';
          }
          for (const b of hunk.body) {
            if (b.kind === 'new') plus.push(b.text);
          }
        }
        t.set(newPath, renderLines(plus, '\n', plus.length > 0 && !noFinal));
        return null;
      }
      if (deletion) {
        if (!t.exists(oldPath)) return { code: 'missing', path: oldPath };
        t.set(oldPath, null);
        return null;
      }
      const cur = t.get(oldPath);
      if (cur === null) return { code: 'missing', path: oldPath };
      if (move && t.exists(newPath)) return { code: 'exists', path: newPath };
      let fl = parseLines(cur);
      let lines = fl.lines;
      let fb = fl.finalBreak;
      let d = 0;
      for (const hunk of sec.hunks) {
        const r = applyHunk(lines, fb, hunk, strict, d);
        if (r.fail) return { code: r.fail, path: oldPath };
        lines = r.lines;
        fb = r.finalBreak;
        d += r.dDelta;
      }
      const text = renderLines(lines, fl.br, fb);
      if (move) {
        t.set(oldPath, null);
        t.set(newPath, text);
        t.moves.push({ old: oldPath, nw: newPath });
      } else {
        t.set(oldPath, text);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7).
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): ParseOut<Edit[]> {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  const isMarker = (l: string, m: string): boolean => stripTrail(l) === m;
  while (i < lines.length) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const tr = lines[j].trim();
      if (tr === '' || tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) return { ok: false, line: searchIdx + 1 };
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '<<<<<<< SEARCH')) break;
      if (isMarker(lines[j], '=======')) {
        eq = j;
        break;
      }
    }
    if (eq === -1) return { ok: false, line: searchIdx + 1 };
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (isMarker(lines[j], '<<<<<<< SEARCH')) break;
      if (isMarker(lines[j], '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep === -1) return { ok: false, line: searchIdx + 1 };
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      paths: [p],
      apply(t: Tree, strict: boolean): Failure | null {
        if (oldLines.length === 0) {
          if (t.exists(p)) return { code: 'exists', path: p };
          t.set(p, renderLines(newLines, '\n', newLines.length > 0));
          return null;
        }
        const cur = t.get(p);
        if (cur === null) return { code: 'missing', path: p };
        const fl = parseLines(cur);
        const found = findTier(fl.lines, oldLines, strict);
        if (!found) return { code: 'no-match', path: p };
        if (found.occ.length > 1) return { code: 'ambiguous', path: p };
        const nItems: NLine[] = newLines.map((text) => ({ text, ctx: false, oIdx: -1 }));
        const repLines = buildReplacement(nItems, oldLines, fl.lines, found.occ[0], found.tier);
        const nl = [...fl.lines];
        nl.splice(found.occ[0], oldLines.length, ...repLines);
        t.set(p, renderLines(nl, fl.br, fl.finalBreak));
        return null;
      },
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return { ok: true, value: edits };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function parseV4a(lines: string[]): ParseOut<VSection[]> {
  const fb = lines.findIndex((l) => l.trim() !== '');
  if (fb === -1) return { ok: false, line: 1 };
  if (lines[fb].trim() !== '*** Begin Patch') return { ok: false, line: fb + 1 };
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      lb = k;
      break;
    }
  }
  if (lines[lb].trim() !== '*** End Patch') return { ok: false, line: lines.length + 1 };
  const secStart = (l: string): { kind: string; path: string } | null => {
    const m = /^\*\*\* (Add|Delete|Update) File:(.*)$/.exec(l);
    if (!m) return null;
    return { kind: m[1].toLowerCase(), path: m[2].trim() };
  };
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const l = lines[i];
    if (l.trim() === '') {
      i++;
      continue;
    }
    const ss = secStart(l);
    if (!ss) return { ok: false, line: i + 1 };
    const secLine = i + 1;
    let j = i + 1;
    while (j < lb && !secStart(lines[j])) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
    if (ss.kind === 'add') {
      const fl: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k];
        if (r.startsWith('+')) fl.push(r.slice(1));
        else if (r === '') fl.push('');
        else return { ok: false, line: i + 2 + k };
      }
      sections.push({ kind: 'add', path: ss.path, lines: fl });
    } else if (ss.kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (raw[k].trim() !== '') return { ok: false, line: i + 2 + k };
      }
      sections.push({ kind: 'delete', path: ss.path });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0].startsWith('*** Move to:')) {
        moveTo = raw[0].slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      for (let k = idx; k < raw.length; k++) {
        const r = raw[k];
        const ln = i + 2 + k;
        if (r.startsWith('@@')) {
          const anchor = r.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
          continue;
        }
        if (r.trim() === '*** End of File' && !r.startsWith(' ')) {
          if (!cur) return { ok: false, line: ln };
          cur.eof = true;
          cur = null;
          continue;
        }
        if (r === '' || r.startsWith(' ') || r.startsWith('-') || r.startsWith('+')) {
          if (!cur) {
            if (!firstChunk) return { ok: false, line: ln };
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          if (r === '') cur.body.push({ kind: 'ctx', text: '', rawEmpty: true });
          else if (r.startsWith(' ')) cur.body.push({ kind: 'ctx', text: r.slice(1), rawEmpty: false });
          else if (r.startsWith('-')) cur.body.push({ kind: 'old', text: r.slice(1), rawEmpty: false });
          else cur.body.push({ kind: 'new', text: r.slice(1), rawEmpty: false });
          continue;
        }
        return { ok: false, line: ln };
      }
      if (chunks.length === 0 && moveTo === null) return { ok: false, line: secLine };
      sections.push({ kind: 'update', path: ss.path, moveTo, chunks });
    }
    i = j;
  }
  return { ok: true, value: sections };
}

function v4aEdit(sec: VSection): Edit {
  if (sec.kind === 'add') {
    return {
      paths: [sec.path],
      apply(t: Tree): Failure | null {
        if (t.exists(sec.path)) return { code: 'exists', path: sec.path };
        t.set(sec.path, renderLines(sec.lines, '\n', sec.lines.length > 0));
        return null;
      },
    };
  }
  if (sec.kind === 'delete') {
    return {
      paths: [sec.path],
      apply(t: Tree): Failure | null {
        if (!t.exists(sec.path)) return { code: 'missing', path: sec.path };
        t.set(sec.path, null);
        return null;
      },
    };
  }
  const paths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
  return {
    paths,
    apply(t: Tree, strict: boolean): Failure | null {
      const cur = t.get(sec.path);
      if (cur === null) return { code: 'missing', path: sec.path };
      if (sec.moveTo !== null && t.exists(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
      const fl = parseLines(cur);
      let lines = fl.lines;
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const tiers = strict ? [0] : [0, 1, 2];
          let foundAt: number | null = null;
          for (const tier of tiers) {
            for (let j = cursor; j < lines.length; j++) {
              if (lineEq(lines[j], chunk.anchor, tier)) {
                foundAt = j;
                break;
              }
            }
            if (foundAt !== null) break;
          }
          if (foundAt === null) return { code: 'no-match', path: sec.path };
          cursor = foundAt + 1;
        }
        const o: NLine[] = [];
        const n: NLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            const idx = o.length;
            o.push({ text: b.text, ctx: true, oIdx: idx });
            n.push({ text: b.text, ctx: true, oIdx: idx });
          } else if (b.kind === 'old') {
            o.push({ text: b.text, ctx: false, oIdx: -1 });
          } else if (b.kind === 'new') {
            n.push({ text: b.text, ctx: false, oIdx: -1 });
          }
        }
        const oTexts = o.map((x) => x.text);
        if (oTexts.length === 0) {
          const ins = chunk.eof ? lines.length : cursor;
          const nl = [...lines];
          nl.splice(ins, 0, ...n.map((x) => x.text));
          lines = nl;
          cursor = ins + n.length;
          continue;
        }
        const tiers = strict ? [0] : [0, 1, 2];
        let chosen: { tier: number; occ: number } | null = null;
        for (const tier of tiers) {
          const occs = findOccurrences(lines, oTexts, tier).filter((pos) => pos >= cursor);
          const good = chunk.eof ? occs.filter((pos) => pos + oTexts.length === lines.length) : occs;
          if (good.length > 0) {
            chosen = { tier, occ: good[0] };
            break;
          }
        }
        if (!chosen) return { code: 'no-match', path: sec.path };
        const rep = buildReplacement(n, oTexts, lines, chosen.occ, chosen.tier);
        const nl = [...lines];
        nl.splice(chosen.occ, oTexts.length, ...rep);
        lines = nl;
        cursor = chosen.occ + rep.length;
      }
      const text = renderLines(lines, fl.br, fl.finalBreak);
      if (sec.moveTo !== null) {
        t.set(sec.path, null);
        t.set(sec.moveTo, text);
        t.moves.push({ old: sec.path, nw: sec.moveTo });
      } else {
        t.set(sec.path, text);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9).
// ---------------------------------------------------------------------------

interface JsonEditRaw {
  path: string;
  command: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function validateJsonEdit(obj: unknown): JsonEditRaw | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { path: o.path, command: 'create', fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'str_replace', oldStr: o.old_str, newStr: o.new_str ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'insert', insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): ParseOut<Edit[]> {
  const nonBlankIdx = lines.findIndex((l) => l.trim() !== '');
  if (nonBlankIdx === -1) return { ok: false, line: 1 };
  const first = lines[nonBlankIdx].replace(/^\s+/, '');
  const raws: JsonEditRaw[] = [];
  if (first.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      return { ok: false, line: nonBlankIdx + 1 };
    }
    if (!Array.isArray(arr)) return { ok: false, line: nonBlankIdx + 1 };
    for (const el of arr) {
      const v = validateJsonEdit(el);
      if (!v) return { ok: false, line: nonBlankIdx + 1 };
      raws.push(v);
    }
  } else {
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[k]);
      } catch {
        return { ok: false, line: k + 1 };
      }
      const v = validateJsonEdit(obj);
      if (!v) return { ok: false, line: k + 1 };
      raws.push(v);
    }
  }
  if (raws.length === 0) return { ok: false, line: 1 };
  const edits: Edit[] = raws.map((raw) => ({
    paths: [raw.path],
    apply(t: Tree): Failure | null {
      if (raw.command === 'create') {
        if (t.exists(raw.path)) return { code: 'exists', path: raw.path };
        t.set(raw.path, raw.fileText as string);
        return null;
      }
      if (raw.command === 'str_replace') {
        const cur = t.get(raw.path);
        if (cur === null) return { code: 'missing', path: raw.path };
        const fl = parseLines(cur);
        const crlf = fl.br === '\r\n';
        const text = crlf ? cur.replace(/\r\n/g, '\n') : cur;
        const oldStr = crlf ? (raw.oldStr as string).replace(/\r\n/g, '\n') : (raw.oldStr as string);
        const newStr = crlf ? (raw.newStr as string).replace(/\r\n/g, '\n') : (raw.newStr as string);
        const count = countOverlapping(text, oldStr);
        if (count === 0) return { code: 'no-match', path: raw.path };
        if (count > 1) return { code: 'ambiguous', path: raw.path };
        const idx = text.indexOf(oldStr);
        const done = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
        t.set(raw.path, crlf ? done.replace(/\n/g, '\r\n') : done);
        return null;
      }
      // insert
      const cur = t.get(raw.path);
      if (cur === null) return { code: 'missing', path: raw.path };
      const fl = parseLines(cur);
      const lineNo = raw.insertLine as number;
      if (lineNo < 0 || lineNo > fl.lines.length) return { code: 'no-match', path: raw.path };
      const ns = raw.newStr as string;
      let newLines: string[];
      if (ns === '') {
        newLines = [];
      } else {
        const parts = ns.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
        if (ns.endsWith('\n')) parts.pop();
        newLines = parts;
      }
      const nl = [...fl.lines];
      nl.splice(lineNo, 0, ...newLines);
      t.set(raw.path, renderLines(nl, fl.br, fl.finalBreak));
      return null;
    },
  }));
  return { ok: true, value: edits };
}

// ---------------------------------------------------------------------------
// Patch dispatch, output and exit codes (SPEC sections 2 and 10).
// ---------------------------------------------------------------------------

function parsePatch(format: string, lines: string[], patchText: string, strict: boolean): ParseOut<Edit[]> {
  if (format === 'unified') {
    const p = parseUnified(lines);
    if (!p.ok) return p;
    return { ok: true, value: p.value.map(unifiedEdit) };
  }
  if (format === 'search-replace') return parseSearchReplace(lines);
  if (format === 'v4a') {
    const p = parseV4a(lines);
    if (!p.ok) return p;
    return { ok: true, value: p.value.map(v4aEdit) };
  }
  return parseJson(lines, patchText);
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function runCli(argv: string[]): number {
  const out: string[] = [];
  const cli = parseCli(argv);
  if (!cli) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (cli.patch === null || cli.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(cli.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let format = cli.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = detected;
  }
  const parsed = parsePatch(format, lines, patchText, cli.strict);
  if (!parsed.ok) {
    process.stdout.write(`error: parse ${parsed.line}\n`);
    return 2;
  }
  const edits = parsed.value;
  if (edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    return 2;
  }
  const tree = new Tree();
  const failures: Failure[] = [];
  for (const edit of edits) {
    const unsafe = edit.paths.find((p) => !isSafePath(p));
    if (unsafe !== undefined) {
      failures.push({ code: 'unsafe', path: unsafe });
      continue;
    }
    const f = edit.apply(tree, cli.strict);
    if (f) failures.push(f);
  }
  if (failures.length > 0) {
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }
  // Change lines, in byte order of the paths; an R line sorts by its new path.
  interface Change {
    key: string;
    line: string;
  }
  const changes: Change[] = [];
  const paths = new Set<string>([...tree.orig.keys(), ...tree.work.keys()]);
  for (const p of paths) {
    const before = tree.orig.has(p) ? (tree.orig.get(p) as string | null) : undefined;
    const after = tree.work.has(p) ? (tree.work.get(p) as string | null) : undefined;
    if (before === undefined || after === undefined) continue;
    if (before === after) continue;
    if (before === null && after !== null) changes.push({ key: p, line: `A ${p}` });
    else if (before !== null && after === null) changes.push({ key: p, line: `D ${p}` });
    else changes.push({ key: p, line: `M ${p}` });
  }
  for (const m of tree.moves) {
    const beforeOld = tree.orig.get(m.old);
    const afterOld = tree.work.get(m.old);
    const beforeNew = tree.orig.get(m.nw);
    const afterNew = tree.work.get(m.nw);
    if (beforeOld !== null && beforeOld !== undefined && afterOld === null && beforeNew === null && afterNew !== null && afterNew !== undefined) {
      const di = changes.findIndex((c) => c.line === `D ${m.old}`);
      if (di >= 0) changes.splice(di, 1);
      const ai = changes.findIndex((c) => c.line === `A ${m.nw}`);
      if (ai >= 0) changes.splice(ai, 1);
      changes.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  changes.sort((a, b) => byteCompare(a.key, b.key));
  if (!cli.check) {
    for (const p of paths) {
      const before = tree.orig.has(p) ? (tree.orig.get(p) as string | null) : undefined;
      const after = tree.work.has(p) ? (tree.work.get(p) as string | null) : undefined;
      if (before === undefined || after === undefined) continue;
      if (before === after) continue;
      if (after === null) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore: the file was already gone
        }
      } else {
        const dir = dirname(p);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(p, after);
      }
    }
  }
  for (const c of changes) out.push(c.line);
  out.push(`ok: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
