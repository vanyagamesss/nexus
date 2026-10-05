'use strict';

/**
 * NEXUS — лёгкий RAG без зависимостей: поиск знаний в рабочей папке.
 *
 * Без эмбеддингов и векторных баз: файлы режутся на чанки, релевантность
 * считается по пересечению значимых слов запроса и чанка (TF-скорее-всего
 * хватит для папки на тысячи файлов). Агент ходит сюда двумя путями:
 *   • инструмент `rag_search` — точный вопрос к базе знаний;
 *   • автоконтекст — lib/agent.js сам подкладывает топ-чанки в промпт.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage', 'uploads']);
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.ts', '.tsx', '.py', '.json', '.yml', '.yaml', '.html', '.css', '.xml', '.csv', '.log', '.ini', '.cfg', '.toml']);
const MAX_FILE_BYTES = 200 * 1024;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;
const MAX_FILES = 2000;

const RU_STOP = new Set('это|как|что|для|или|при|так|уже|все|всё|его|ее|её|они|она|оно|был|была|было|есть|нет|да|же|ли|бы|не|на|в|с|к|о|у|а|и|по|из|от|до|за|над|под|про|без|между|через|можно|нужно|надо|если|когда|где|кто|меня|тебя|себя|нас|вас|них|того|этого|такой|такая|которые|который|которая|будет|будут|меня|этот|эта|эти|там|тут|здесь|только|даже|очень|просто|сейчас|потом|затем|также|между|после|перед|время|раза|раз|два|три|год|года|лет'.split('|'));
const EN_STOP = new Set('the|and|for|with|from|that|this|have|has|are|was|were|will|would|can|could|should|what|when|where|who|how|why|not|but|you|your|our|their|its|into|over|after|before|then|than|such|only|also|just|about|there|here|all|any|each|few|more|most|other|some|no|nor|too|very|one|two|may|might|must|shall|do|does|did|done|being|been|is|it|of|to|in|on|at|by|as|an|a|or|if|so|we|they|he|she|them|his|her|our|us|my|mine|yours'.split('|'));

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-zа-яё0-9_+-]+/iu)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !RU_STOP.has(w) && !EN_STOP.has(w));
}

async function collectFiles(root, subpaths) {
  const out = [];
  const base = path.resolve(root);
  const walk = async (dir, depth) => {
    if (out.length >= MAX_FILES || depth > 10) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        try {
          const st = await fsp.stat(full);
          if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
        } catch { continue; }
        out.push(full);
      }
    }
  };
  const subs = Array.isArray(subpaths) && subpaths.length ? subpaths : null;
  if (!subs) {
    await walk(base, 0);
    return out;
  }
  /* Только указанные папки/файлы базы знаний, строго внутри корня */
  for (const s of subs) {
    const abs = path.resolve(base, String(s || '').replace(/^[/\\]+/, ''));
    const rel = path.relative(base, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    let st;
    try {
      st = await fsp.stat(abs);
    } catch { continue; }
    if (st.isDirectory()) await walk(abs, 0);
    else if (st.isFile()) {
      if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) continue;
      if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
      if (out.length < MAX_FILES) out.push(abs);
    }
  }
  return out;
}

function chunkText(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_CHARS);
    if (!slice.trim()) break;
    chunks.push(slice);
    if (i + CHUNK_CHARS >= text.length) break;
    i += CHUNK_CHARS - CHUNK_OVERLAP;
  }
  return chunks;
}

function scoreChunk(qTokens, qSet, chunkFreq, chunkLen) {
  let score = 0;
  for (const t of qSet) {
    const f = chunkFreq.get(t);
    if (f) score += (1 + Math.log(f)) * (t.length >= 6 ? 2 : 1);
  }
  void qTokens;
  void chunkLen;
  return score;
}

/**
 * Поиск по базе знаний. Возвращает [{ path, chunk, score }] — path относительный.
 * subpaths — ограничить папками/файлами базы знаний (иначе весь корень).
 */
async function search(root, query, topK = 4, subpaths) {
  const qTokens = tokens(query);
  if (!qTokens.length) return { error: 'Пустой запрос: не за что зацепиться' };
  const qSet = new Set(qTokens);
  const files = await collectFiles(root, subpaths);
  const scored = [];
  for (const full of files) {
    let text;
    try {
      text = await fsp.readFile(full, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue;
    for (const chunk of chunkText(text)) {
      const freq = new Map();
      for (const t of tokens(chunk)) freq.set(t, (freq.get(t) || 0) + 1);
      const score = scoreChunk(qTokens, qSet, freq, chunk.length);
      if (score > 0) scored.push({ full, chunk, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const k = Math.min(Math.max(Number(topK) || 4, 1), 10);
  return {
    ok: true,
    files: files.length,
    query: String(query).slice(0, 200),
    results: scored.slice(0, k).map((r) => ({
      path: path.relative(path.resolve(root), r.full) || path.basename(r.full),
      score: Math.round(r.score * 10) / 10,
      text: r.chunk.slice(0, 1200),
    })),
  };
}

/** Сводка базы знаний для панели «База знаний». */
async function status(root, subpaths) {
  const files = await collectFiles(root, subpaths);
  let bytes = 0;
  let chunks = 0;
  for (const full of files.slice(0, MAX_FILES)) {
    try {
      const st = await fsp.stat(full);
      bytes += st.size;
      chunks += Math.max(1, Math.ceil(st.size / (CHUNK_CHARS - CHUNK_OVERLAP)));
    } catch { /* файл ушёл — пропускаем */ }
  }
  return { ok: true, root: path.resolve(root), files: files.length, chunks, bytes };
}

module.exports = { search, status, tokens };
