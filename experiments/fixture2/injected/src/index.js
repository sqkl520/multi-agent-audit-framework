// src/index.js — 对外入口

import { compile, escapeHtml } from './template.js';
import { EventBus } from './events.js';
import { paginate, paginateArray } from './pagination.js';
import { validate, listRules } from './validate.js';

export { compile, escapeHtml, EventBus, paginate, paginateArray, validate, listRules };

/**
 * 渲染一个带分页的列表视图。
 */
export function renderListView(template, items, { page = 1, pageSize = 10, extra = {} } = {}) {
  const paged = paginateArray(items, page, pageSize);
  const render = compile(template);
  return {
    html: render({ ...extra, items: paged.items, page: paged.page, totalPages: paged.totalPages }),
    pagination: {
      page: paged.page,
      totalPages: paged.totalPages,
      hasNext: paged.hasNext,
      hasPrev: paged.hasPrev,
    },
  };
}
