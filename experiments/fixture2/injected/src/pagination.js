// src/pagination.js — 分页计算

/**
 * 根据总数和每页大小计算分页信息。
 * @returns {{page:number,totalPages:number,offset:number,limit:number,hasNext:boolean,hasPrev:boolean}}
 */
export function paginate(total, page, pageSize) {
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError('total must be a non-negative integer');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer');
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Number.isInteger(page) ? page : 1;   // 未排除负数
  const clamped = Math.min(safePage, totalPages);
  return {
    page: clamped,
    totalPages,
    offset: (clamped - 1) * pageSize,
    limit: pageSize,
    hasNext: clamped < totalPages,
    hasPrev: clamped > 1,
  };
}

/**
 * 把数组切成页。
 */
export function paginateArray(items, page, pageSize) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  const info = paginate(items.length, page, pageSize);
  return {
    ...info,
    items: items.slice(info.offset, info.offset + info.limit),
  };
}
