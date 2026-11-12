// src/validate.js — 表单校验

const RULES = Object.freeze({
  required: (v) => v !== undefined && v !== null && v !== '',
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  minLength: (v, n) => typeof v === 'string' && v.length >= n,
  maxLength: (v, n) => typeof v === 'string' && v.length <= n,
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => Number.isInteger(v),
});

/**
 * 按 schema 校验一个对象。
 * schema 形如 { field: [{ rule: 'minLength', arg: 3 }, { rule: 'required' }] }
 * @returns {{valid:boolean, errors:Object<string,string[]>}}
 */
export function validate(data, schema) {
  if (data === null || typeof data !== 'object') {
    throw new TypeError('data must be an object');
  }
  if (schema === null || typeof schema !== 'object') {
    throw new TypeError('schema must be an object');
  }

  const errors = {};
  for (const [field, rules] of Object.entries(schema)) {
    if (!Array.isArray(rules)) {
      throw new TypeError(`rules for "${field}" must be an array`);
    }
    const value = data[field];
    for (const r of rules) {
      const fn = RULES[r.rule];
      if (typeof fn !== 'function') {
        throw new TypeError(`unknown rule: ${r.rule}`);
      }
      if (!fn(value, r.arg)) {
        if (!errors[field]) errors[field] = [];
        errors[field].push(r.message || `${field} failed ${r.rule}`);
      }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** 列出所有可用规则名 */
export function listRules() {
  return Object.keys(RULES);
}
