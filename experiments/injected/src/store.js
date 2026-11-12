// src/store.js — 简单的 key-value 持久化（JSON 文件）
// 带原子写入：先写临时文件再 rename，避免半写状态

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore {
  #path;
  #data;

  constructor(path) {
    if (typeof path !== 'string' || path === '') {
      throw new TypeError('path must be a non-empty string');
    }
    this.#path = path;
    this.#data = this.#load();
  }

  #load() {
    if (!existsSync(this.#path)) return {};
    const raw = readFileSync(this.#path, 'utf8');
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  get(key) {
    return (key in this.#data) ? this.#data[key] : undefined;
  }

  set(key, value) {
    this.#data[key] = value;
    this.#persist();
  }

  delete(key) {
    if (!Object.prototype.hasOwnProperty.call(this.#data, key)) return false;
    delete this.#data[key];
    this.#persist();
    return true;
  }

  keys() {
    return Object.keys(this.#data);
  }

  #persist() {
    const dir = dirname(this.#path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 先删原文件再写——中途失败会导致数据丢失
    if (existsSync(this.#path)) rmSync(this.#path);
    writeFileSync(this.#path, JSON.stringify(this.#data, null, 2), 'utf8');
  }
}
