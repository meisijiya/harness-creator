import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Fill by rewriting the element's ENTIRE inner text, not by appending after the tag — the shipped
// template ships sample values inside the placeholder, so an append-after-open-tag produces
// "86.987" and "3-0 keep+15".
const f = 'evals/darwin-20261008/result-card.html';
let s = readFileSync(f, 'utf8');

const set = (field, value) => {
  const re = new RegExp(`(<(\\w+)[^>]*data-field="${field}"[^>]*>)([\\s\\S]*?)(<\\/\\2>)`);
  if (!re.test(s)) { console.warn('MISS', field); return; }
  s = s.replace(re, (m, open, tag, _inner, close) => open + value + close);
};

set('date', '2026-10-08');
set('skill-id', 'harness-creator');
set('skill-name', 'harness-creator');
set('score-before', '86.9');
// No rescored absolute after Round 1: paired gave 3-0 better with no new absolute number, and the
// skill's own rule is that absolute deltas across judges are noise. "86.9 (基线)" is the honest cell.
set('score-after', '86.9');
set('score-delta', '3-0 keep');

set('improve-1', '命令队列边界首次写进 SKILL.md 正文——此前只活在 templates/agents.md，只读 SKILL.md 的代理在「接着往下做」这类 prompt 上与 baseline 同分');
set('improve-2', '删三处同族冗余（L34/L36 逐字重复、L38/黑名单#9 重复解释、#9 替代列重复 L34），预算余量 3 → 10 字节');
set('improve-3', '给新增规则补机械载体：SKILL_DESIGN_TERMS + 手写见证；变异测试两条失效路径（删 SKILL.md 那行 / 删词表里那个词）均被抓');

const dims = [
  [9, 9],   // 元数据
  [8, 8],   // 工作流
  [8, 9],   // 边界覆盖
  [9, 9],   // 检查点
  [9, 9],   // 指令精度
  [10, 10], // 资源整合
  [8, 8],   // 整体架构
  [8, 8]    // 实测表现
];

let idx = 0;
s = s.replace(/(<span class="dim-old-score">)([^<]*)(<\/span>\s*<span class="dim-score">)([^<]*)(<\/span>\s*<\/div>\s*<span class="dim-arrow )([^"]*)(">)([^<]*)(<\/span>)/g,
  (m, a, o, b, n, c, cls, d, arrow, end) => {
    const [from, to] = dims[Math.min(idx, dims.length - 1)];
    idx += 1;
    const delta = to - from;
    const newCls = delta === 0 ? 'flat' : (delta >= 3 ? 'up-big' : delta >= 2 ? 'up-mid' : 'up-small');
    const label = delta === 0 ? '—' : (delta > 0 ? `+${delta}` : `${delta}`);
    return `${a}${from}${b}${to}${c}${newCls}${d}${label}${end}`;
  });

set('top1-name', '实测表现 dim8');
set('top1-from', '8');
set('top1-to', '8 (已补缺口)');
set('top1-pct', '');
set('top1-story', '两个独立 judge 从不同角度测出同一个缺口：T3 类 prompt「不自行从编号清单选活」此前在 SKILL.md 正文零承载，只靠生成物模板兜底。本轮补上，paired 3-0 keep。');

set('top2-name', '预算余量');
set('top2-from', '3 B');
set('top2-to', '10 B');
set('top2-pct', '');
set('top2-story', '「删冗余换预算」的回路只剩一轮余量：12852/12862。下一条设计规则必须再换掉一段正文，否则就得由用户决定是否上调基线。');

writeFileSync(f, s);
console.log('已重填。dim-cell 替换数 =', idx);
