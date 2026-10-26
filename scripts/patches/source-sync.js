  // marimo notebooks keep imports in `with app.setup:` and model classes as
  // top-level `@app.class_definition` cells. The upstream merge drops those
  // decorators and inserts imports at column 0, which marimo rejects.
  const isMarimo = src => /^import marimo\b/m.test(src) && /^\w+\s*=\s*marimo\.App\(/m.test(src);
  const mergePlain = mergeIntoSource;
  function mergeMarimo(src, gen, used) {
    const out = mergePlain(src, gen, used);
    if (out == null) return null;
    const app = /^(\w+)\s*=\s*marimo\.App\(/m.exec(src)[1];
    const before = new Set(src.replace(/\r\n/g, '\n').split('\n'));
    const topIn = new Set(used || []);
    const lines = out.split('\n');
    // Imports that upstream added at column 0 belong in the setup cell instead.
    const IMPORTS = [
      ['import torch', /^[ \t]*import torch[ \t]*$/m, /\btorch\./],
      ['import torch.nn as nn', /^[ \t]*(import torch\.nn as nn|from torch import nn)\b/m, /\bnn\./],
      ['import torch.nn.functional as F', /^[ \t]*import torch\.nn\.functional as F\b/m, /\bF\./],
    ];
    const added = new Set(IMPORTS.map(i => i[0]).filter(l => lines.includes(l) && !before.has(l)));
    const body = lines.filter(l => !added.has(l));
    const code = body.join('\n');
    const missing = IMPORTS.filter(([, have, uses]) => uses.test(code) && !have.test(code)).map(i => '    ' + i[0]);
    // Decorate every regenerated class and helper that is new to the file.
    const seen = new Set(src.match(/^def \w+/gm) || []);
    const res = [];
    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      const prev = res.length ? res[res.length - 1] : '';
      const decorated = /^@/.test(prev);
      const cls = /^class\s+(\w+)/.exec(l);
      if (cls && !decorated) res.push(`@${app}.class_definition`);
      else if (/^def \w+/.test(l) && !decorated && !seen.has(/^def \w+/.exec(l)[0]) && !before.has(l)) res.push(`@${app}.function`);
      res.push(l);
    }
    if (missing.length) {
      const at = res.findIndex(l => /^with\s+\w+\.setup\b.*:\s*$/.test(l));
      if (at >= 0) {
        let end = at + 1, last = at;
        while (end < res.length && (res[end].trim() === '' || /^\s/.test(res[end]))) { if (res[end].trim() !== '' && /^\s+(import|from)\s/.test(res[end])) last = end; end++; }
        res.splice(last + 1, 0, ...missing);
      } else {
        const appAt = res.findIndex(l => new RegExp('^' + app + '\\s*=\\s*marimo\\.App\\(').test(l));
        res.splice(appAt + 1, 0, '', `with ${app}.setup:`, ...missing);
      }
    }
    return res.join('\n');
  }
  mergeIntoSource = (src, gen, used) => (isMarimo(src) ? mergeMarimo : mergePlain)(src, gen, used);

  // ── source sync: apply diagram edits to the real source without regenerating it ──
  // The file text stays the source of truth. The diagram edit is the difference between
  // the graph imported from that text and the current graph, measured on generated code.
  // Only the constructor statements and methods that difference touches are rewritten;
  // docstrings, comments, extra methods, and unrelated code stay byte for byte.
  const indentOf = l => /^[ \t]*/.exec(l)[0].length;
  const isBlank = l => l.trim() === '';
  const isComment = l => l.trim().startsWith('#');
  // For each line: does a new logical line (statement) begin here?
  function logicalStarts(lines) {
    const starts = []; let depth = 0, tri = null, cont = false;
    for (const s of lines) {
      starts.push(depth === 0 && !tri && !cont);
      cont = false;
      let i = 0;
      while (i < s.length) {
        if (tri) { const j = s.indexOf(tri, i); if (j < 0) i = s.length; else { tri = null; i = j + 3; } continue; }
        const c = s[i];
        if (c === '#') break;
        if (c === '"' || c === "'") {
          if (s.startsWith(c.repeat(3), i)) { tri = c.repeat(3); i += 3; continue; }
          let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
          i = j + 1; continue;
        }
        if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
        i++;
      }
      if (!tri && depth === 0 && /\\\s*$/.test(s)) cont = true;
    }
    return starts;
  }
  // Statements at one indent. a: first line including leading comments and decorators,
  // p: first code line, b: end (exclusive, trailing blank lines excluded).
  function itemsAt(lines, from, to, indent) {
    const ls = lines.slice(from, to), st = logicalStarts(ls), ps = [];
    for (let i = 0; i < ls.length; i++) if (st[i] && !isBlank(ls[i]) && !isComment(ls[i]) && indentOf(ls[i]) === indent) ps.push(i);
    const items = [];
    for (let k = 0; k < ps.length; k++) {
      let a = ps[k]; const lo = k ? items[k - 1].b - from : 0;
      while (a - 1 >= lo && isComment(ls[a - 1]) && indentOf(ls[a - 1]) === indent) a--;
      let b = k + 1 < ps.length ? ps[k + 1] : ls.length;
      if (k + 1 < ps.length) while (b - 1 > ps[k] && (isBlank(ls[b - 1]) || (isComment(ls[b - 1]) && indentOf(ls[b - 1]) === indent))) b--;
      else while (b - 1 > ps[k] && isBlank(ls[b - 1])) b--;
      items.push({ a: a + from, p: ps[k] + from, b: b + from, text: ls[ps[k]].trim() });
    }
    // a decorator belongs to the statement that follows it
    const out = [];
    for (let k = 0; k < items.length; k++) {
      if (items[k].text.startsWith('@') && k + 1 < items.length) { items[k + 1].a = items[k].a; items[k + 1].deco = true; continue; }
      out.push(items[k]);
    }
    return out;
  }
  function classBlocks(lines) {
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^class\s+(\w+)/.exec(lines[i]); if (!m) continue;
      let a = i; while (a > 0 && /^@/.test(lines[a - 1])) a--;
      let j = i + 1; while (j < lines.length && (isBlank(lines[j]) || /^\s/.test(lines[j]))) j++;
      let b = j; while (b > i + 1 && isBlank(lines[b - 1])) b--;
      blocks.push({ name: m[1], a, h: i, b }); i = j - 1;
    }
    return blocks;
  }
  // A class as {lines, indent, methods:[{name, a, b, ...}]}, line numbers relative to the block.
  function classParts(lines) {
    const h = lines.findIndex(l => /^class\s/.test(l));
    let i = h + 1; while (i < lines.length && (isBlank(lines[i]) || isComment(lines[i]))) i++;
    const indent = i < lines.length ? indentOf(lines[i]) : 4;
    const methods = itemsAt(lines, h + 1, lines.length, indent).map(it => {
      const m = /^(?:async\s+)?def\s+(\w+)/.exec(it.text); return m ? Object.assign(it, { name: m[1] }) : null;
    }).filter(Boolean);
    return { lines, indent, methods, h };
  }
  // The def header spans p up to the line before the first body statement.
  function methodParts(lines, it, indent) {
    const st = logicalStarts(lines.slice(it.p, it.b));
    let hb = it.p + 1; while (hb < it.b && !st[hb - it.p]) hb++;
    const body = itemsAt(lines, hb, it.b, indent + 4 > 0 ? indentOf(lines[hb] || '') : 8);
    const docstring = body.length && /^[rRbBuU]*("""|'''|"|')/.test(body[0].text) ? body[0] : null;
    return { head: [it.p, hb], bodyFrom: hb, body, docstring, indent: hb < it.b ? indentOf(lines[hb]) : indent + 4 };
  }
  // ── signature parameters ──
  function splitTop(text, ch) {
    const parts = []; let depth = 0, q = null, last = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      else if (c === ch && depth === 0) { parts.push(text.slice(last, i)); last = i + 1; }
    }
    parts.push(text.slice(last)); return parts;
  }
  function paramsOf(header) {
    const open = header.indexOf('('); let depth = 0, close = -1, q = null;
    for (let i = open; i < header.length; i++) {
      const c = header[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c) && --depth === 0) { close = i; break; }
    }
    if (open < 0 || close < 0) return null;
    const segs = splitTop(header.slice(open + 1, close), ',');
    const params = segs.map(raw => {
      const eq = splitTop(raw, '=').length > 1 ? splitTop(raw, '=')[0].length : -1;
      const nm = /^\s*\*{0,2}(\w+)/.exec(raw);
      return { raw, name: nm ? nm[1] : null, eq, def: eq >= 0 ? raw.slice(eq + 1).trim() : null };
    });
    return { before: header.slice(0, open + 1), after: header.slice(close), params };
  }
  function patchParams(orig, base, cur, preserveRequired = false) {
    const o = paramsOf(orig), b = paramsOf(base), c = paramsOf(cur);
    if (!o || !b || !c) return orig;
    const bm = new Map(b.params.filter(p => p.name).map(p => [p.name, p])), cm = new Map(c.params.filter(p => p.name).map(p => [p.name, p]));
    const segs = o.params.slice();
    const find = n => segs.findIndex(p => p.name === n);
    for (const p of c.params) {
      if (!p.name) continue;
      const bp = bm.get(p.name), i = find(p.name);
      if (i < 0) { const at = segs.length && segs[segs.length - 1].raw.trim() === '' ? segs.length - 1 : segs.length; segs.splice(at, 0, { raw: (at ? ' ' : '') + p.raw.trim(), name: p.name, eq: -1, def: null }); }
      else if (bp && bp.def !== p.def && i >= 0 && segs[i].eq >= 0 && p.def != null) {
        const s = segs[i], tail = s.raw.slice(s.eq + 1), lead = /^\s*/.exec(tail)[0], trail = /\s*$/.exec(tail)[0];
        segs[i] = Object.assign({}, s, { raw: s.raw.slice(0, s.eq + 1) + lead + p.def + trail, def: p.def });
      }
    }
    for (const p of b.params) if (p.name && !cm.has(p.name) && (!preserveRequired || !o.params.some(original => original.name === p.name && original.def == null))) { const i = find(p.name); if (i >= 0) segs.splice(i, 1); }
    return o.before + segs.map(s => s.raw).join(',') + o.after;
  }
  const reindent = (lines, from, to) => from === to ? lines : lines.map(l => (isBlank(l) ? l : ' '.repeat(to) + l.slice(Math.min(from, indentOf(l)))));
  const keyOf = text => { const m = /^self\.(\w+)\s*(?::[^=]+)?=(?!=)/.exec(text); return m ? m[1] : null; };
  const jn = (lines, a, b) => lines.slice(a, b).join('\n');

  // Rewrite one method of the original class so it follows the generated base -> cur change.
  function patchMethod(oL, oIt, bL, bIt, cL, cIt, ci) {
    const O = methodParts(oL, oIt, ci.o), B = methodParts(bL, bIt, ci.b), C = methodParts(cL, cIt, ci.c);
    const name = (/^(?:async\s+)?def\s+(\w+)/.exec(oIt.text) || [])[1];
    // Required constructor arguments are a public interface, even when a diagram
    // replaces their dimension expressions with literals. Keep callers compatible.
    const head = patchParams(jn(oL, O.head[0], O.head[1]), jn(bL, B.head[0], B.head[1]), jn(cL, C.head[0], C.head[1]), name === '__init__').split('\n');
    const lead = oL.slice(oIt.a, oIt.p);
    const bodyOf = (L, M) => reindent(L.slice(M.bodyFrom, M.body.length ? M.body[M.body.length - 1].b : M.bodyFrom), M.indent, O.indent);
    if (name !== '__init__') {
      // Replace the body with the generated one, keeping the original docstring.
      const doc = O.docstring ? oL.slice(O.docstring.a, O.body.length > 1 ? O.body[1].a : O.docstring.b) : [];
      const from = C.docstring ? C.docstring.b : C.bodyFrom;
      const gen = reindent(cL.slice(from, C.body.length ? C.body[C.body.length - 1].b : from), C.indent, O.indent);
      while (gen.length && isBlank(gen[0])) gen.shift();
      return lead.concat(head, doc, gen);
    }
    // __init__: change only the `self.x = ...` statements that differ.
    const key = (L, M) => new Map(M.body.map(it => [keyOf(it.text), it]).filter(([k]) => k));
    const ok = key(oL, O), bk = key(bL, B), ck = key(cL, C);
    const stmt = (L, it, M) => reindent(L.slice(it.p, it.b), M.indent, O.indent);
    const replace = new Map(), drop = new Set(), after = new Map();
    for (const [k, it] of ck) {
      const bi = bk.get(k), oi = ok.get(k);
      if (bi && jn(bL, bi.p, bi.b) === jn(cL, it.p, it.b)) continue;
      if (oi) replace.set(oi, oL.slice(oi.a, oi.p).concat(stmt(cL, it, C)));
      else if (!bi) {
        let prev = null; for (const [pk] of ck) { if (pk === k) break; if (ok.has(pk)) prev = ok.get(pk); }
        const sup = O.body.find(x => /^super\(/.test(x.text)) || O.docstring || O.body[0];
        const anchor = prev || sup;
        if (anchor) after.set(anchor, (after.get(anchor) || []).concat(stmt(cL, it, C)));
        else after.set('start', (after.get('start') || []).concat(stmt(cL, it, C)));
      }
    }
    for (const [k, it] of bk) if (!ck.has(k) && ok.has(k)) drop.add(ok.get(k));
    const out = lead.concat(head);
    const end = O.body.length ? O.body[O.body.length - 1].b : O.bodyFrom;
    const byStart = new Map(O.body.map(it => [it.a, it]));
    if (after.has('start')) out.push(...after.get('start'));
    for (let i = O.bodyFrom; i < end; i++) {
      const it = byStart.get(i);
      if (it) {
        if (drop.has(it)) { i = it.b - 1; if (i + 1 < end && isBlank(oL[i + 1])) i++; continue; }
        if (replace.has(it)) { out.push(...replace.get(it)); i = it.b - 1; }
        else { out.push(...oL.slice(it.a, it.b)); i = it.b - 1; }
        if (after.has(it)) out.push(...after.get(it));
        continue;
      }
      out.push(oL[i]);
    }
    return out;
  }
  // Patch one class: keep every method the diagram change did not touch.
  function patchClass(oL, bL, cL, keepExtraMethods = false) {
    const O = classParts(oL), B = classParts(bL), C = classParts(cL);
    const ci = { o: O.indent, b: B.indent, c: C.indent };
    const norm = (L, it) => jn(L, it.p, it.b).replace(/[ \t]+$/gm, '');
    const bm = new Map(B.methods.map(m => [m.name, m])), om = new Map(O.methods.map(m => [m.name, m])), cm = new Map(C.methods.map(m => [m.name, m]));
    const edits = [];
    for (const [name, c] of cm) {
      const b = bm.get(name), o = om.get(name);
      if (b && norm(bL, b) === norm(cL, c)) continue;
      if (o && b) edits.push({ a: o.a, b: o.b, lines: patchMethod(oL, o, bL, b, cL, c, ci) });
      else if (o) edits.push({ a: o.a, b: o.b, lines: reindent(cL.slice(c.a, c.b), C.indent, O.indent) });
      else {
        const last = O.methods.length ? O.methods[O.methods.length - 1].b : oL.length;
        edits.push({ a: last, b: last, lines: [''].concat(reindent(cL.slice(c.a, c.b), C.indent, O.indent)) });
      }
    }
    for (const [name, b] of bm) if (!keepExtraMethods && !cm.has(name) && om.has(name)) { const o = om.get(name); edits.push({ a: o.a, b: o.b, lines: [], blank: true }); }
    edits.sort((x, y) => y.a - x.a);
    const out = oL.slice();
    for (const e of edits) out.splice(e.a, e.b - e.a, ...e.lines);
    return out;
  }
  const IMPORTS = [
    ['import torch', /^[ \t]*import torch[ \t]*$/m, /\btorch\./],
    ['import torch.nn as nn', /^[ \t]*(import torch\.nn as nn|from torch import nn)\b/m, /\bnn\./],
    ['import torch.nn.functional as F', /^[ \t]*import torch\.nn\.functional as F\b/m, /\bF\./],
  ];
  function ensureImports(text, code) {
    const need = IMPORTS.filter(([, have, uses]) => uses.test(code) && !have.test(text)).map(i => i[0]);
    if (!need.length) return text;
    const lines = text.split('\n'), m = /^(\w+)\s*=\s*marimo\.App\(/m.exec(text);
    if (m) {
      const at = lines.findIndex(l => /^with\s+\w+\.setup\b.*:\s*$/.test(l));
      const add = need.map(l => '    ' + l);
      if (at >= 0) {
        let end = at + 1, last = at;
        while (end < lines.length && (isBlank(lines[end]) || /^\s/.test(lines[end]))) { if (/^\s+(import|from)\s/.test(lines[end])) last = end; end++; }
        lines.splice(last + 1, 0, ...add);
      } else {
        const appAt = lines.findIndex(l => /^\w+\s*=\s*marimo\.App\(/.test(l));
        lines.splice(appAt + 1, 0, '', `with ${m[1]}.setup:`, ...add);
      }
      return lines.join('\n');
    }
    let at = -1;
    for (let i = 0; i < lines.length; i++) { if (/^(import|from)\s/.test(lines[i])) at = i; else if (/^(class|def|if|@)/.test(lines[i])) break; }
    lines.splice(at + 1, 0, ...need);
    return lines.join('\n');
  }
  function syncSource(text, graph, o = {}) {
    let src = text.replace(/\r\n/g, '\n'), res;
    // Older versions saved `return None` while a block was being rewired. Repair
    // only matching classes with those empty forwards from the valid diagram in memory.
    // Never recover an unrelated import failure by replacing the whole notebook.
    const candidate = generate(graph, Object.assign({}, o.gen, { className: graph.name })).code;
    try { res = importPython(src, { root: o.root }); }
    catch (error) {
      const lines = src.split('\n'), generated = candidate.split('\n');
      const current = classBlocks(generated), repairs = [];
      for (const original of classBlocks(lines)) {
        const replacement = current.find(c => c.name === original.name);
        if (!replacement) continue;
        const old = lines.slice(original.h, original.b), parts = classParts(old);
        const forward = parts.methods.find(m => m.name === 'forward');
        if (!forward) continue;
        const method = methodParts(old, forward, parts.indent);
        const body = method.body.filter(item => item !== method.docstring);
        if (body.length !== 1 || !/^return\s+None\s*(?:#.*)?$/.test(body[0].text)) continue;
        repairs.push({ a: original.h, b: original.b,
          lines: patchClass(old, old, generated.slice(replacement.h, replacement.b), true) });
      }
      if (!repairs.length) throw error;
      for (const repair of repairs.sort((a, b) => b.a - a.a)) lines.splice(repair.a, repair.b - repair.a, ...repair.lines);
      src = lines.join('\n');
      res = importPython(src, { root: o.root });
    }
    // Compare in the file's own style: a literal file has no size symbols to patch, so comparing symbolic
    // code would drop a size edit made through a symbol.
    const opts = Object.assign({}, o.gen, { shapeComments: false, literalDims: res.literalDims != null ? res.literalDims : false });
    const baseGen = generate(res.graph, Object.assign({}, opts, { className: res.graph.name })).code;
    const curGen = generate(graph, Object.assign({}, opts, { className: graph.name })).code;
    if (baseGen === curGen) return src;
    const lines = src.split('\n'), bl = baseGen.split('\n'), cl = curGen.split('\n');
    const marimo = /^(\w+)\s*=\s*marimo\.App\(/m.exec(src), app = marimo && marimo[1];
    const oBlocks = classBlocks(lines), bBlocks = classBlocks(bl), cBlocks = classBlocks(cl);
    const find = (blocks, n) => blocks.find(x => x.name === n);
    const edits = [];
    const deco = (cls, extra) => (app ? [`@${app}.${extra}`] : []).concat(cls);
    for (const c of cBlocks) {
      // renaming the model in the diagram renames its root class
      const was = c.name === graph.name ? res.graph.name : c.name;
      const b = find(bBlocks, was), ob = find(oBlocks, was), clsLines = cl.slice(c.h, c.b);
      if (b && jn(bl, b.h, b.b) === jn(cl, c.h, c.b)) continue;
      if (ob && b) {
        const patched = patchClass(lines.slice(ob.h, ob.b), bl.slice(b.h, b.b), clsLines);
        patched[0] = patched[0].replace(/^class\s+\w+/, 'class ' + c.name);
        edits.push({ a: ob.h, b: ob.b, lines: patched });
      }
      else if (!ob) {
        const used = oBlocks.filter(x => (res.usedClasses || []).includes(x.name));
        const before = used.find(x => cBlocks.findIndex(z => z.name === x.name) > cBlocks.indexOf(c));
        const at = before ? before.a : used.length ? Math.max(...used.map(x => x.b)) : lines.length;
        edits.push({ a: at, b: at, lines: (before ? [] : ['', '']).concat(deco(clsLines, 'class_definition'), before ? ['', ''] : []) });
      }
    }
    const renamedFrom = graph.name !== res.graph.name && find(cBlocks, graph.name) ? res.graph.name : null;
    for (const b of bBlocks) if (!find(cBlocks, b.name) && b.name !== renamedFrom) { const ob = find(oBlocks, b.name); if (ob) edits.push({ a: ob.a, b: ob.b + (isBlank(lines[ob.b] || 'x') ? 1 : 0), lines: [] }); }
    // helper functions the generated code needs
    const helperDefs = cl.slice(0, Math.max(0, cl.findIndex(l => /^class /.test(l)))).join('\n').split(/\n(?=def )/).map(s => s.trim()).filter(s => /^def (\w+)/.test(s));
    const missing = helperDefs.filter(s => !new RegExp('^def ' + /^def (\w+)/.exec(s)[1] + '\\(', 'm').test(src));
    if (missing.length) {
      const first = oBlocks.length ? oBlocks[0].a : lines.length;
      edits.push({ a: first, b: first, lines: missing.flatMap(s => deco(s.split('\n'), 'function').concat(['', ''])) });
    }
    edits.sort((x, y) => y.a - x.a || y.b - x.b);
    const out = lines.slice();
    for (const e of edits) out.splice(e.a, e.b - e.a, ...e.lines);
    return ensureImports(out.join('\n'), edits.flatMap(e => e.lines).join('\n'));
  }
  mergeIntoSource.sync = syncSource;
