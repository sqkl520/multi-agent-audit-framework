import { readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
// 不删目录，逐个文件从 base 覆盖回 injected
for (const f of ['template.js', 'events.js', 'pagination.js', 'validate.js', 'index.js']) {
  cpSync(join(HERE, 'base', 'src', f), join(HERE, 'injected', 'src', f));
}

const I = [
  // 1. 转义顺序错误：先替换 & 会让后续 < 变成 &amp;lt; 之外的问题——
  //    实际是 & 先处理是对的，这里的缺陷是把 & 放在最后
  { id:'F2-01', file:'src/template.js', dim:'security', sev:'HIGH',
    find:`.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');`,
    replace:`.replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/&/g, '&amp;');`,
    title:'escapeHtml 把 & 放在最后替换，导致 &lt; 被二次转义成 &amp;lt;' },

  // 2. once 的 wrapper 映射被后续注册覆盖：同一 handler 注册两次 once，第二次覆盖第一次的映射
  { id:'F2-02', file:'src/events.js', dim:'data-consistency', sev:'MEDIUM',
    find:`    this.#onceWrappers.set(handler, wrapper);
    return this.on(event, wrapper);`,
    replace:`    this.#onceWrappers.set(handler, wrapper);
    return this.on(event, wrapper);
    // 同一 handler 对多个事件注册 once 时，#onceWrappers 只保留最后一个`,
    title:'#onceWrappers 以 handler 为键，同一 handler 注册多个事件时映射被覆盖，off 失效', skip:true },

  // 3. emit 复制数组但返回原始长度——若监听器内部 off，返回值偏大
  { id:'F2-03', file:'src/events.js', dim:'logic', sev:'LOW',
    find:`    return list.length;`,
    replace:`    return list.length;   // 注意：list 可能已被监听器改动`,
    title:'emit 返回 list.length 而非实际执行数，监听器内部 off 后返回值偏大', skip:true },

  // 4. paginate 的 page 参数未校验上界就能被负数绕过（已校验），改：total=0 时 totalPages=1 但 offset=(1-1)*n=0，正确
  //    真正缺陷：Math.max(1, ceil) 当 total=0 时返回 1 页，但列表为空——hasNext 计算错误
  { id:'F2-04', file:'src/pagination.js', dim:'logic', sev:'MEDIUM',
    find:`  const totalPages = Math.max(1, Math.ceil(total / pageSize));`,
    replace:`  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // total=0 时 totalPages=1，但没有任何数据`,
    title:'total=0 时 totalPages 声明为 1，与实际空数据不符', skip:true },

  // 5. validate 的 number 规则用 typeof 而非 isFinite，Infinity 通过
  { id:'F2-05', file:'src/validate.js', dim:'logic', sev:'MEDIUM',
    find:`  number: (v) => typeof v === 'number' && !Number.isNaN(v),`,
    replace:`  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  // Infinity 会通过 number 规则`,
    title:'number 规则放行 Infinity（!Number.isNaN(Infinity) 为 true）', skip:true },

  // 6. renderBlock 的 each 用 {...ctx, this:item, ...item} 展开，
  //    若 item 有 __proto__ 键会污染
  { id:'F2-06', file:'src/template.js', dim:'security', sev:'HIGH',
    find:`          out += renderBlock(body, { ...ctx, this: item, ...(typeof item === 'object' ? item : {}) });`,
    replace:`          // 展开 item 的自身属性，但未过滤 __proto__
          out += renderBlock(body, { ...ctx, this: item, ...(typeof item === 'object' ? item : {}) });`,
    title:'each 展开 item 属性时未过滤 __proto__，模板可被原型污染', skip:true },

  // 7. findMatchingClose 的 depth 计数：嵌套同类块时正确，但混合嵌套（each 里套 if）失效
  { id:'F2-07', file:'src/template.js', dim:'logic', sev:'HIGH',
    find:`function findMatchingClose(src, from, openTag, closeTag) {
  let depth = 0;`,
    replace:`function findMatchingClose(src, from, openTag, closeTag) {
  // 只数同类型开闭标签，不处理交叉嵌套
  let depth = 0;`,
    title:'findMatchingClose 只数同类标签，each 内嵌 if 时匹配错误', skip:true },

  // 8. EventBus.emit 的 errors.length===1 直接 throw，但监听器可能期望 AggregateError
  { id:'F2-08', file:'src/events.js', dim:'contract', sev:'MEDIUM',
    find:`    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {`,
    replace:`    if (errors.length > 1) {`,
    title:'emit 在只有一个监听器抛错时直接抛原错误，多个时抛 AggregateError——异常类型不一致', },
];
let ok=0, skip=0;
for(const x of I){
  if(x.skip){ skip++; continue; }
  const p = join(HERE, 'injected', x.file);
  const s=readFileSync(p,'utf8');
  if(!s.includes(x.find)){ console.log('✗ NOT_FOUND', x.id); continue; }
  writeFileSync(p, s.replace(x.find,x.replace));
  console.log('✓', x.id, x.file);
  ok++;
}
console.log(`\n注入 ${ok} 条，跳过 ${skip} 条（跳过的是「本来就是正常代码」的假想缺陷）`);
